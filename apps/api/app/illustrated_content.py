from __future__ import annotations

import re
from typing import Any


_MARKDOWN_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_MARKDOWN_IMAGE_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<url>[^)]+)\)")
_MAX_INLINE_IMAGES = 5


def _slug(value: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value.strip()).strip("-").lower()
    return cleaned or fallback


def _clean_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_newlines(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n")


def _plain_len(value: Any) -> int:
    return len(re.sub(r"\s+", "", str(value or "")))


def _section_body_text(raw: dict[str, Any]) -> str:
    """Accept common LLM field aliases so body is not dropped as empty."""
    for key in ("content", "body", "text", "paragraph", "html", "markdown"):
        value = raw.get(key)
        if isinstance(value, list):
            joined = "\n\n".join(str(item).strip() for item in value if str(item).strip())
            if joined.strip():
                return joined.strip()
        text = _normalize_newlines(value).strip()
        if text:
            return text
    paragraphs = raw.get("paragraphs")
    if isinstance(paragraphs, list):
        joined = "\n\n".join(str(item).strip() for item in paragraphs if str(item).strip())
        if joined.strip():
            return joined.strip()
    return ""


def _sections_body_chars(sections: list[dict[str, Any]]) -> int:
    return sum(_plain_len(section.get("content")) for section in sections if isinstance(section, dict))


def _markdown_body_chars(content: str) -> int:
    text = _normalize_newlines(content)
    # Strip headings and image markdown so we measure real body copy.
    text = re.sub(r"^#{1,6}\s+.*$", "", text, flags=re.MULTILINE)
    text = _MARKDOWN_IMAGE_RE.sub("", text)
    return _plain_len(text)


def _source_content_blocks(article: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = [article.get("contentBlocks")]
    writer_context = article.get("writerContext") if isinstance(article.get("writerContext"), dict) else {}
    if isinstance(writer_context, dict):
        candidates.append(writer_context.get("contentBlocks"))
    for candidate in candidates:
        if isinstance(candidate, list) and candidate:
            return [item for item in candidate if isinstance(item, dict)]
    return []


def _has_substantive_body_blocks(blocks: list[dict[str, Any]]) -> bool:
    return any(
        str(block.get("type") or "").strip().lower() in {"section", "image"}
        for block in blocks
        if isinstance(block, dict)
    )


def _markdown_to_blocks(content: str, fallback_title: str) -> list[dict[str, Any]]:
    text = _normalize_newlines(content).strip()
    title = str(fallback_title or "未命名文章").strip() or "未命名文章"
    blocks: list[dict[str, Any]] = [{"type": "title", "text": title}]
    if not text:
        return blocks

    section_index = 0
    current_section_title = ""
    current_section_id = ""
    current_paragraph_lines: list[str] = []
    current_section_paragraphs: list[str] = []
    title_set = False

    def flush_paragraph() -> None:
        nonlocal current_paragraph_lines, current_section_paragraphs
        paragraph = "\n".join(line.rstrip() for line in current_paragraph_lines).strip()
        if paragraph:
            current_section_paragraphs.append(paragraph)
        current_paragraph_lines = []

    def start_default_section() -> None:
        nonlocal section_index, current_section_title, current_section_id, current_section_paragraphs
        section_index += 1
        current_section_title = "正文" if section_index == 1 else f"正文 {section_index}"
        current_section_id = _slug(current_section_title, f"section-{section_index}")
        current_section_paragraphs = []

    def finish_section() -> None:
        nonlocal current_section_title, current_section_id, current_section_paragraphs
        flush_paragraph()
        if not current_section_title and not current_section_paragraphs:
            return
        section_title = current_section_title or "正文"
        section_id = current_section_id or _slug(section_title, f"section-{max(1, section_index)}")
        blocks.append({
            "type": "section",
            "sectionId": section_id,
            "title": section_title,
            "content": "\n\n".join(current_section_paragraphs).strip(),
        })
        current_section_title = ""
        current_section_id = ""
        current_section_paragraphs = []

    def start_section(section_title: str) -> None:
        nonlocal section_index, current_section_title, current_section_id, current_section_paragraphs
        flush_paragraph()
        if current_section_title or current_section_paragraphs:
            finish_section()
        section_index += 1
        current_section_title = str(section_title or "正文").strip() or f"正文 {section_index}"
        current_section_id = _slug(current_section_title, f"section-{section_index}")
        current_section_paragraphs = []

    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            flush_paragraph()
            continue

        heading = _MARKDOWN_HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            heading_text = heading.group(2).strip()
            has_started_body = bool(current_section_title or current_section_paragraphs or len(blocks) > 1)
            if level == 1 and not title_set and not has_started_body:
                blocks[0]["text"] = heading_text or title
                title = str(blocks[0]["text"])
                title_set = True
                continue
            start_section(heading_text or "正文")
            continue

        cursor = 0
        matched_image = False
        for image_match in _MARKDOWN_IMAGE_RE.finditer(line):
            prefix = line[cursor:image_match.start()].strip()
            if prefix:
                if not current_section_title:
                    start_default_section()
                current_paragraph_lines.append(prefix)
            flush_paragraph()
            if not current_section_title:
                start_default_section()
            image_section_id = current_section_id
            if current_section_title or current_section_paragraphs:
                finish_section()
            blocks.append({
                "type": "image",
                "sectionId": image_section_id,
                "assetId": "",
                "url": image_match.group("url").strip(),
                "path": "",
                "altText": image_match.group("alt").strip() or title,
            })
            matched_image = True
            cursor = image_match.end()

        suffix = line[cursor:].strip()
        if suffix:
            if not current_section_title:
                start_default_section()
            current_paragraph_lines.append(suffix)
        elif matched_image:
            continue

    finish_section()
    return blocks


def _markdown_to_sections(content: str, fallback_title: str) -> list[dict[str, str]]:
    sections: list[dict[str, str]] = []
    for block in _markdown_to_blocks(content, fallback_title):
        if str(block.get("type") or "") != "section":
            continue
        sections.append({
            "id": str(block.get("sectionId") or ""),
            "title": str(block.get("title") or ""),
            "content": str(block.get("content") or "").strip(),
        })
    return sections


def _escape_html(value: Any) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def bind_content_blocks_to_images(blocks: list[dict[str, Any]], images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    image_by_asset = {
        str(image.get("assetId") or ""): image
        for image in images
        if isinstance(image, dict) and str(image.get("assetId") or "")
    }
    image_by_section = {
        str(image.get("sectionId") or ""): image
        for image in images
        if isinstance(image, dict) and str(image.get("sectionId") or "")
    }
    bound: list[dict[str, Any]] = []
    for raw in blocks:
        if not isinstance(raw, dict):
            continue
        block = dict(raw)
        if str(block.get("type") or "") == "image":
            image = image_by_asset.get(str(block.get("assetId") or "")) or image_by_section.get(str(block.get("sectionId") or ""))
            if image:
                block = {**block, **image, "type": "image"}
        bound.append(block)
    return bound


def _drop_unbound_image_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove image blocks that carry neither a url nor a path.

    The desktop agent turns every image block into a local file before publishing,
    so a block with no source aborts the whole run. Dropping the block degrades to
    an article without that picture instead of losing the entire publication.
    """
    return [
        block for block in blocks
        if not (
            isinstance(block, dict)
            and str(block.get("type") or "") == "image"
            and not str(block.get("url") or "")
            and not str(block.get("path") or "")
        )
    ]


def _insert_missing_images_after_sections(blocks: list[dict[str, Any]], images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pending_by_section: dict[str, list[dict[str, Any]]] = {}
    existing_keys = {
        (
            str(block.get("assetId") or ""),
            str(block.get("sectionId") or ""),
            str(block.get("url") or block.get("path") or ""),
        )
        for block in blocks
        if isinstance(block, dict) and str(block.get("type") or "") == "image"
    }
    for image in images:
        if not isinstance(image, dict) or image.get("purpose") == "cover":
            continue
        source = str(image.get("url") or image.get("path") or "")
        section_id = str(image.get("sectionId") or "")
        if not source or not section_id:
            continue
        key = (str(image.get("assetId") or ""), section_id, source)
        if key in existing_keys:
            continue
        pending_by_section.setdefault(section_id, []).append(image)

    if not pending_by_section:
        return blocks

    with_images: list[dict[str, Any]] = []
    inserted_sections: set[str] = set()
    for block in blocks:
        with_images.append(block)
        if str(block.get("type") or "") != "section":
            continue
        section_id = str(block.get("sectionId") or "")
        for image in pending_by_section.get(section_id, []):
            with_images.append({
                "type": "image",
                "sectionId": section_id,
                "assetId": image.get("assetId") or "",
                "url": image.get("url") or "",
                "path": image.get("path") or "",
                "altText": image.get("altText") or block.get("title") or "文章配图",
            })
        inserted_sections.add(section_id)

    for section_id, section_images in pending_by_section.items():
        if section_id in inserted_sections:
            continue
        for image in section_images:
            with_images.append({
                "type": "image",
                "sectionId": section_id,
                "assetId": image.get("assetId") or "",
                "url": image.get("url") or "",
                "path": image.get("path") or "",
                "altText": image.get("altText") or "文章配图",
            })
    return with_images


def compose_rich_article_html(blocks: list[dict[str, Any]], include_images: bool = True) -> str:
    parts: list[str] = []
    for raw in blocks:
        if not isinstance(raw, dict):
            continue
        block_type = str(raw.get("type") or "").strip().lower()
        if block_type == "title":
            continue
        if block_type == "section":
            content = str(raw.get("content") or "").strip()
            paragraphs = [
                f"<p style=\"margin: 0 0 12px; line-height: 1.8;\">{_escape_html(paragraph).replace(chr(10), '<br>')}</p>"
                for paragraph in re.split(r"\n{2,}", content)
                if paragraph.strip()
            ]
            parts.append(
                f"<section data-zhixin-section=\"{_escape_html(raw.get('sectionId'))}\" style=\"margin: 0 0 24px;\">"
                f"<h2 style=\"margin: 0 0 12px; line-height: 1.4;\">{_escape_html(raw.get('title') or '')}</h2>"
                f"{''.join(paragraphs)}"
                f"</section>"
            )
            continue
        if block_type == "image":
            if not include_images:
                continue
            source = str(raw.get("dataUrl") or raw.get("url") or "").strip()
            if not source:
                continue
            alt_text = _escape_html(raw.get("altText") or "Article image")
            parts.append(
                f"<figure data-zhixin-section=\"{_escape_html(raw.get('sectionId'))}\" style=\"margin: 20px 0; text-align: center;\">"
                f"<img src=\"{_escape_html(source)}\" alt=\"{alt_text}\" style=\"display: block; max-width: 100%; height: auto; margin: 0 auto 8px;\">"
                f"<figcaption style=\"margin: 0; font-size: 12px; color: #666; text-align: center;\">{alt_text}</figcaption>"
                f"</figure>"
            )
    return "".join(parts)


def _markdown_from_sections(title: str, sections: list[dict[str, str]]) -> str:
    return "\n\n".join([
        f"# {title}",
        *[f"## {section['title']}\n\n{section['content']}" for section in sections],
    ]).strip()


def _sections_to_blocks(title: str, sections: list[dict[str, str]]) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [{"type": "title", "text": title}]
    for section in sections:
        blocks.append({
            "type": "section",
            "sectionId": str(section.get("id") or ""),
            "title": str(section.get("title") or ""),
            "content": str(section.get("content") or ""),
        })
    return blocks


def normalize_article_output(output: dict[str, Any], max_inline_images: int = 5) -> dict[str, Any]:
    title = str(output.get("title") or "未命名文章").strip() or "未命名文章"
    sections: list[dict[str, str]] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(output.get("sections") or []):
        if not isinstance(raw, dict):
            continue
        section_title = str(raw.get("title") or f"第 {index + 1} 节").strip()
        section_id = _slug(str(raw.get("id") or section_title), f"section-{index + 1}")
        if section_id in used_ids:
            section_id = f"{section_id}-{index + 1}"
        used_ids.add(section_id)
        sections.append({
            "id": section_id,
            "title": section_title,
            "content": _section_body_text(raw),
        })

    raw_markdown = _normalize_newlines(output.get("contentMarkdown") or output.get("markdown") or output.get("content") or "").strip()
    content_blocks = _source_content_blocks(output)
    markdown_sections: list[dict[str, str]] = []
    markdown_blocks: list[dict[str, Any]] = []
    if raw_markdown:
        markdown_blocks = _markdown_to_blocks(raw_markdown, title)
        markdown_sections = [
            {
                "id": str(block.get("sectionId") or ""),
                "title": str(block.get("title") or ""),
                "content": str(block.get("content") or "").strip(),
            }
            for block in markdown_blocks
            if str(block.get("type") or "") == "section"
        ]
        if _has_substantive_body_blocks(markdown_blocks) and not content_blocks:
            content_blocks = markdown_blocks

    # Prefer structured sections only when they actually carry body copy.
    # Empty skeleton sections must NOT wipe a full contentMarkdown body.
    section_chars = _sections_body_chars(sections)
    markdown_chars = _sections_body_chars(markdown_sections) or _markdown_body_chars(raw_markdown)
    if section_chars < 80 and markdown_chars >= 80 and markdown_sections:
        sections = markdown_sections
        if _has_substantive_body_blocks(markdown_blocks):
            content_blocks = markdown_blocks
    elif not sections and markdown_sections:
        sections = markdown_sections

    # Backfill empty section shells from markdown by title / order match.
    if sections and markdown_sections and _sections_body_chars(sections) < 80 <= _sections_body_chars(markdown_sections):
        by_title = {
            str(item.get("title") or "").strip(): item
            for item in markdown_sections
            if str(item.get("title") or "").strip()
        }
        filled: list[dict[str, str]] = []
        for index, section in enumerate(sections):
            content = str(section.get("content") or "").strip()
            if content:
                filled.append(section)
                continue
            match = by_title.get(str(section.get("title") or "").strip())
            if not match and index < len(markdown_sections):
                match = markdown_sections[index]
            filled.append({
                **section,
                "content": str((match or {}).get("content") or "").strip(),
                "id": section.get("id") or str((match or {}).get("id") or ""),
            })
        sections = filled

    content_markdown = _markdown_from_sections(title, sections) if sections else raw_markdown
    # Last resort: keep raw markdown if rebuilt content is still empty skeleton.
    if _markdown_body_chars(content_markdown) < 80 and _markdown_body_chars(raw_markdown) >= 80:
        content_markdown = raw_markdown
        if not sections and markdown_sections:
            sections = markdown_sections

    if not _has_substantive_body_blocks(content_blocks) and sections:
        content_blocks = _sections_to_blocks(title, sections)

    # Layout rule: one cover + one inline image brief per body section (up to limit).
    inline_limit = max(0, min(_safe_int(max_inline_images, 5), _MAX_INLINE_IMAGES))
    briefs: list[dict[str, Any]] = []
    inline_count = 0
    for index, raw in enumerate(output.get("imageBriefs") or []):
        if not isinstance(raw, dict):
            continue
        purpose = str(raw.get("purpose") or "inline").strip().lower()
        if purpose not in {"cover", "inline", "infographic"}:
            purpose = "inline"
        if purpose in {"inline", "infographic"}:
            if inline_count >= inline_limit:
                continue
            inline_count += 1
        section_id = str(raw.get("sectionId") or "").strip()
        # Map bogus "cover" sectionId on inline briefs away from cover slot.
        if purpose != "cover" and section_id in {"", "cover", "封面"}:
            section_id = ""
        prompt = str(raw.get("prompt") or raw.get("altText") or "").strip()
        if not prompt:
            prompt = (
                f"为《{title}》生成专业、清晰、无文字的主题封面"
                if purpose == "cover"
                else f"为《{title}》生成专业、清晰、无文字的正文配图"
            )
        briefs.append({
            "id": str(raw.get("id") or f"image-{index + 1}"),
            "purpose": purpose,
            "sectionId": section_id,
            "prompt": prompt,
            "altText": str(raw.get("altText") or prompt or title).strip(),
            "aspectRatio": str(raw.get("aspectRatio") or ("16:9" if purpose == "cover" else "4:3")),
            "priority": _safe_int(raw.get("priority"), index + 1),
        })

    # Ensure every body section can get one inline image slot in the plan.
    body_sections = [
        section for section in sections
        if _plain_len(section.get("content")) >= 40 or str(section.get("title") or "").strip()
    ]
    assigned = {
        str(brief.get("sectionId") or "")
        for brief in briefs
        if str(brief.get("purpose") or "") in {"inline", "infographic"} and str(brief.get("sectionId") or "")
    }
    for section in body_sections:
        if inline_count >= inline_limit:
            break
        section_id = str(section.get("id") or "")
        if not section_id or section_id in assigned:
            continue
        briefs.append({
            "id": f"image-inline-{section_id}",
            "purpose": "inline",
            "sectionId": section_id,
            "prompt": (
                f"为《{title}》章节「{section.get('title') or section_id}」生成专业、清晰、无文字配图。"
                f"章节语义：{str(section.get('content') or '')[:180]}"
            ),
            "altText": f"{section.get('title') or title}配图",
            "aspectRatio": "4:3",
            "priority": len(briefs) + 1,
        })
        assigned.add(section_id)
        inline_count += 1
    if not any(str(brief.get("purpose") or "") == "cover" for brief in briefs):
        briefs.insert(0, {
            "id": "image-cover",
            "purpose": "cover",
            "sectionId": "",
            "prompt": f"为《{title}》生成专业、清晰、无文字的主题封面",
            "altText": f"{title}封面",
            "aspectRatio": "16:9",
            "priority": 0,
        })

    return {
        **output,
        "title": title,
        "summary": str(output.get("summary") or "").strip(),
        "metaDescription": str(output.get("metaDescription") or "").strip(),
        "contentMarkdown": content_markdown,
        "keywords": _clean_strings(output.get("keywords")),
        "tags": _clean_strings(output.get("tags")),
        "sections": sections,
        "contentBlocks": content_blocks,
        "imageBriefs": briefs,
    }


def _eligible_sections_for_images(article: dict[str, Any]) -> list[dict[str, Any]]:
    sections = [section for section in article.get("sections") or [] if isinstance(section, dict)]
    substantial = [
        section for section in sections
        if len(re.sub(r"\s+", "", str(section.get("content") or ""))) >= 80
    ]
    if substantial:
        return substantial
    # Short-model drafts still deserve section-based inline art when strategy asks for it.
    return [
        section for section in sections
        if str(section.get("title") or "").strip() or str(section.get("content") or "").strip()
    ]


def calculate_inline_image_target(article: dict[str, Any], max_inline_images: int = 5) -> int:
    """Hard layout rule: one body section → one inline image (capped by max)."""
    ceiling = max(0, min(_safe_int(max_inline_images, 5), _MAX_INLINE_IMAGES))
    eligible_sections = _eligible_sections_for_images(article)
    if not eligible_sections or ceiling == 0:
        return 0
    # Prefer real body sections; still allow title-only shells as last resort.
    with_body = [section for section in eligible_sections if _plain_len(section.get("content")) >= 40]
    target_pool = with_body or eligible_sections
    return min(ceiling, len(target_pool))


def _distributed_sections(sections: list[dict[str, Any]], count: int) -> list[dict[str, Any]]:
    if count <= 0:
        return []
    if count >= len(sections):
        return sections
    if count == 1:
        return [sections[len(sections) // 2]]
    indexes = [round(index * (len(sections) - 1) / (count - 1)) for index in range(count)]
    return [sections[index] for index in indexes]


def plan_required_images(
    article: dict[str, Any],
    selected_assets: list[dict[str, Any]],
    image_strategy: str = "cover-and-inline",
    max_inline_images: int = 5,
) -> list[dict[str, Any]]:
    if image_strategy == "none":
        return []
    wants_cover = image_strategy in {"cover", "cover-and-inline", "thumbnail"}
    wants_inline = image_strategy in {"inline", "cover-and-inline"}
    briefs = article.get("imageBriefs") or []
    section_by_id = {
        str(section.get("id") or ""): section
        for section in article.get("sections") or []
        if isinstance(section, dict) and str(section.get("id") or "")
    }
    eligible_sections = _eligible_sections_for_images({"sections": list(section_by_id.values())})
    inline_target = calculate_inline_image_target(article, max_inline_images) if wants_inline else 0
    requested: list[dict[str, Any]] = []
    assigned_sections: set[str] = set()
    for brief in sorted((item for item in briefs if isinstance(item, dict)), key=lambda item: _safe_int(item.get("priority"), 0)):
        purpose = str(brief.get("purpose") or "inline")
        if purpose == "cover":
            if wants_cover and not any(item.get("purpose") == "cover" for item in requested):
                requested.append(brief)
            continue
        if not wants_inline or purpose not in {"inline", "infographic"}:
            continue
        section_id = str(brief.get("sectionId") or "")
        if section_id not in section_by_id or section_id in assigned_sections or len(assigned_sections) >= inline_target:
            continue
        assigned_sections.add(section_id)
        requested.append(brief)
    if wants_cover and not any(brief.get("purpose") == "cover" for brief in requested):
        requested.insert(0, {
            "id": "image-cover",
            "purpose": "cover",
            "sectionId": "",
            "prompt": f"为《{article.get('title') or '文章'}》生成专业、清晰、无文字的主题封面",
            "altText": f"{article.get('title') or '文章'}封面",
            "aspectRatio": "16:9",
            "priority": 0,
        })
    missing_count = max(0, inline_target - len(assigned_sections))
    fallback_sections = [section for section in eligible_sections if str(section.get("id") or "") not in assigned_sections]
    for section in _distributed_sections(fallback_sections, missing_count):
        section_id = str(section.get("id") or "")
        requested.append({
            "id": f"image-inline-{section_id}",
            "purpose": "inline",
            "sectionId": section_id,
            "prompt": (
                f"为《{article.get('title') or '文章'}》的章节“{section.get('title') or section_id}”生成专业、"
                f"清晰、无文字的内容配图。章节语义：{str(section.get('content') or '')[:180]}"
            ),
            "altText": f"{section.get('title') or article.get('title') or '文章'}配图",
            "aspectRatio": "4:3",
            "priority": len(requested) + 1,
        })
        assigned_sections.add(section_id)
    inline_limit = inline_target
    selected: set[str] = set()
    plan: list[dict[str, Any]] = []
    inline_count = 0
    for brief in sorted(requested, key=lambda item: _safe_int(item.get("priority"), 0)):
        purpose = str(brief.get("purpose") or "inline")
        if purpose != "cover":
            if inline_count >= inline_limit:
                continue
            inline_count += 1
        asset = next((
            item for item in selected_assets
            if str(item.get("id") or "") not in selected
            and str(item.get("type") or "") == ("cover" if purpose == "cover" else "inline")
        ), None)
        if asset:
            selected.add(str(asset.get("id") or ""))
            plan.append({**brief, "action": "reuse", "assetId": asset.get("id"), "asset": asset})
        else:
            plan.append({**brief, "action": "generate"})
    return plan


def build_content_blocks(article: dict[str, Any], images: list[dict[str, Any]]) -> list[dict[str, Any]]:
    title = str(article.get("title") or "Untitled article").strip() or "Untitled article"
    source_blocks = _source_content_blocks(article)
    explicit_sections: list[dict[str, Any]] = []
    seen_section_ids: set[str] = set()
    for index, raw in enumerate(article.get("sections") or []):
        if not isinstance(raw, dict):
            continue
        section_title = str(raw.get("title") or f"Section {index + 1}").strip() or f"Section {index + 1}"
        section_id = str(raw.get("id") or "").strip() or _slug(section_title, f"section-{index + 1}")
        if section_id in seen_section_ids:
            section_id = f"{section_id}-{index + 1}"
        seen_section_ids.add(section_id)
        explicit_sections.append({
            "id": section_id,
            "title": section_title,
            "content": str(raw.get("content") or "").strip(),
        })

    if explicit_sections and not any(str(block.get("type") or "").strip().lower() == "image" for block in source_blocks):
        blocks = _sections_to_blocks(title, explicit_sections)
        bound_blocks = _drop_unbound_image_blocks(bind_content_blocks_to_images(blocks, images))
        return _insert_missing_images_after_sections(bound_blocks, images)

    source_blocks = _source_content_blocks(article)
    if _has_substantive_body_blocks(source_blocks):
        blocks: list[dict[str, Any]] = []
        has_title = False
        for raw in source_blocks:
            block_type = str(raw.get("type") or "").strip().lower()
            if block_type == "title":
                has_title = True
                blocks.append({
                    "type": "title",
                    "text": str(raw.get("text") or title),
                })
            elif block_type == "section":
                blocks.append({
                    "type": "section",
                    "sectionId": str(raw.get("sectionId") or raw.get("id") or ""),
                    "title": str(raw.get("title") or ""),
                    "content": str(raw.get("content") or ""),
                })
            elif block_type == "image":
                blocks.append({
                    "type": "image",
                    "sectionId": str(raw.get("sectionId") or ""),
                    "assetId": str(raw.get("assetId") or ""),
                    "url": str(raw.get("url") or ""),
                    "path": str(raw.get("path") or ""),
                    "altText": str(raw.get("altText") or raw.get("title") or "文章配图"),
                })
        if not has_title:
            blocks.insert(0, {
                "type": "title",
                "text": title,
            })
        bound_blocks = _drop_unbound_image_blocks(bind_content_blocks_to_images(blocks, images))
        return _insert_missing_images_after_sections(bound_blocks, images)

    blocks = _markdown_to_blocks(str(article.get("contentMarkdown") or ""), title)
    images_by_section: dict[str, list[dict[str, Any]]] = {}
    for image in images:
        if not isinstance(image, dict) or image.get("purpose") == "cover" or not image.get("url"):
            continue
        images_by_section.setdefault(str(image.get("sectionId") or ""), []).append(image)
    if images_by_section:
        with_images: list[dict[str, Any]] = []
        for block in blocks:
            with_images.append(block)
            if str(block.get("type") or "") != "section":
                continue
            section_id = str(block.get("sectionId") or "")
            for image in images_by_section.get(section_id, []):
                with_images.append({
                    "type": "image",
                    "sectionId": section_id,
                    "assetId": image.get("assetId") or "",
                    "url": image.get("url") or "",
                    "path": image.get("path") or "",
                    "altText": image.get("altText") or block.get("title") or "文章配图",
                })
        blocks = with_images
    return blocks

def assemble_markdown(article: dict[str, Any], images: list[dict[str, Any]]) -> str:
    blocks = build_content_blocks(article, images)
    markdown_blocks: list[str] = []
    for block in blocks:
        if block["type"] == "title":
            markdown_blocks.append(f"# {block['text']}")
        elif block["type"] == "section":
            markdown_blocks.append(f"## {block['title']}\n\n{block['content']}".strip())
        elif block["type"] == "image":
            markdown_blocks.append(f"![{block['altText']}]({block['url']})")
    if markdown_blocks:
        return "\n\n".join(markdown_blocks)
    return str(article.get("contentMarkdown") or "")


def evaluate_article_quality(article: dict[str, Any], images: list[dict[str, Any]], image_strategy: str) -> dict[str, Any]:
    issues: list[str] = []
    if not str(article.get("title") or "").strip():
        issues.append("MISSING_TITLE")
    if not str(article.get("summary") or "").strip():
        issues.append("MISSING_SUMMARY")
    content = _normalize_newlines(article.get("contentMarkdown")).strip()
    if not content:
        issues.append("MISSING_CONTENT")
    if len(re.sub(r"\s+", "", content)) < 200:
        issues.append("CONTENT_TOO_SHORT")
    markdown_blocks = _markdown_to_blocks(content, str(article.get("title") or "")) if content else []
    section_ids = {str(section.get("id") or "") for section in article.get("sections") or [] if isinstance(section, dict)}
    if not section_ids:
        section_ids = {
            str(block.get("sectionId") or "")
            for block in markdown_blocks
            if isinstance(block, dict)
            and str(block.get("type") or "") == "section"
            and str(block.get("sectionId") or "")
        }
    if not section_ids and not _has_substantive_body_blocks(_source_content_blocks(article)) and not _has_substantive_body_blocks(markdown_blocks):
        issues.append("MISSING_SECTIONS")
    if image_strategy in {"cover", "cover-and-inline", "thumbnail"} and not any(image.get("purpose") == "cover" and image.get("url") for image in images):
        issues.append("MISSING_COVER")
    if image_strategy in {"inline", "cover-and-inline"} and not any(image.get("purpose") != "cover" and image.get("url") for image in images):
        issues.append("MISSING_INLINE_IMAGES")
    if any(image.get("url") and not str(image.get("altText") or "").strip() for image in images):
        issues.append("MISSING_IMAGE_ALT_TEXT")
    if any(image.get("purpose") != "cover" and image.get("sectionId") not in section_ids for image in images if image.get("url")):
        issues.append("INVALID_IMAGE_SECTION")
    return {
        "status": "ready" if not issues else "review_required",
        "issues": issues,
        "wordCount": len(re.sub(r"[#*_`\s]+", "", content)),
        "sectionCount": len(article.get("sections") or []),
        "imageCount": len([image for image in images if image.get("url")]),
    }
