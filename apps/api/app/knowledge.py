from __future__ import annotations

import hashlib
import re
import html
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

try:
    from docx import Document
except Exception:  # pragma: no cover
    Document = None

try:
    from pypdf import PdfReader
except Exception:  # pragma: no cover
    PdfReader = None


def parse_tags(value: str | None) -> list[str]:
    if not value:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def extract_docx_text_fallback(path: Path) -> str:
    with zipfile.ZipFile(path) as archive:
        xml_text = archive.read("word/document.xml")
    root = ElementTree.fromstring(xml_text)
    text_nodes = [
        node.text or ""
        for node in root.iter()
        if node.tag.endswith("}t") or node.tag == "t"
    ]
    return "\n".join(part for part in text_nodes if part)


def decode_pdf_literal(value: str) -> str:
    value = value.replace(r"\(", "(").replace(r"\)", ")").replace(r"\\", "\\")
    return html.unescape(value)


def extract_pdf_text_fallback(path: Path) -> str:
    raw = path.read_bytes().decode("latin-1", errors="ignore")
    streams = re.findall(r"stream\s*(.*?)\s*endstream", raw, flags=re.S)
    text_parts: list[str] = []
    for stream in streams:
        for value in re.findall(r"\(((?:\\.|[^\\)])*)\)\s*T[Jj]", stream):
            text_parts.append(decode_pdf_literal(value))
    if text_parts:
        return "\n".join(text_parts)
    return "\n".join(decode_pdf_literal(value) for value in re.findall(r"\(((?:\\.|[^\\)])*)\)", raw))


def extract_text_from_file(path: Path, content_type: str = "") -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv"} or content_type.startswith("text/"):
        return path.read_text(encoding="utf-8", errors="ignore")
    if suffix == ".pdf":
        if PdfReader is not None:
            reader = PdfReader(str(path))
            return "\n".join(page.extract_text() or "" for page in reader.pages)
        return extract_pdf_text_fallback(path)
    if suffix == ".docx":
        if Document is not None:
            doc = Document(str(path))
            return "\n".join(paragraph.text for paragraph in doc.paragraphs)
        return extract_docx_text_fallback(path)
    return path.read_text(encoding="utf-8", errors="ignore")


def extract_text_from_url(url: str) -> str:
    """Fetch page text via Scrapling-first pipeline (see app.scraping).

    Raises ValueError with user-facing Chinese messages on failure.
    """
    from .config import get_settings
    from .scraping import fetch_url_text

    settings = get_settings()
    text, _meta = fetch_url_text(
        url,
        mode=str(getattr(settings, "knowledge_fetch_mode", "auto") or "auto"),
        enable_stealth=bool(getattr(settings, "knowledge_fetch_stealth", True)),
        http_timeout=float(getattr(settings, "knowledge_fetch_timeout", 30) or 30),
        stealth_timeout_ms=int(getattr(settings, "knowledge_fetch_stealth_timeout_ms", 45000) or 45000),
        stealth_hard_timeout_seconds=float(
            getattr(settings, "knowledge_fetch_stealth_hard_timeout_seconds", 300.0) or 0.0
        ),
    )
    return text


def chunk_text(text: str, max_chars: int = 900) -> list[str]:
    cleaned = re.sub(r"\n{3,}", "\n\n", text.strip())
    if not cleaned:
        return []
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if len(current) + len(paragraph) + 2 <= max_chars:
            current = f"{current}\n\n{paragraph}".strip()
        else:
            if current:
                chunks.append(current)
            current = paragraph
    if current:
        chunks.append(current)
    return chunks or [cleaned[:max_chars]]


def deterministic_embedding(text: str, dimensions: int = 16) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8", errors="ignore")).digest()
    values = []
    for index in range(dimensions):
        byte = digest[index % len(digest)]
        values.append(round((byte / 255.0) * 2 - 1, 6))
    return values


def build_chunk_records(knowledge_id: str, text: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    chunks = chunk_text(text)
    chunk_records = []
    vector_records = []
    for index, content in enumerate(chunks):
        chunk_id = f"{knowledge_id}-chunk-{index + 1}"
        chunk_records.append({
            "id": chunk_id,
            "knowledgeId": knowledge_id,
            "index": index,
            "content": content,
            "tokenEstimate": max(1, len(content) // 4),
        })
        vector_records.append({
            "id": f"{chunk_id}-vector",
            "knowledgeId": knowledge_id,
            "chunkId": chunk_id,
            "provider": "local-hash",
            "dimensions": 16,
            "embedding": deterministic_embedding(content),
        })
    return chunk_records, vector_records
