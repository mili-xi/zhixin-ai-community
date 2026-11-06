from __future__ import annotations

import zipfile
from pathlib import Path

from app.knowledge import extract_text_from_file


def write_minimal_docx(path: Path, text: str) -> None:
    document_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
  </w:body>
</w:document>
"""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
""")
        archive.writestr("word/document.xml", document_xml)


def write_minimal_pdf(path: Path, text: str) -> None:
    stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET"
    pdf = f"""%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>
endobj
4 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
5 0 obj
<< /Length {len(stream)} >>
stream
{stream}
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF
"""
    path.write_bytes(pdf.encode("latin-1"))


def test_extract_text_from_docx_without_optional_dependency(tmp_path):
    path = tmp_path / "knowledge.docx"
    write_minimal_docx(path, "DOCX SEO knowledge paragraph")

    assert "DOCX SEO knowledge paragraph" in extract_text_from_file(path)


def test_extract_text_from_pdf_without_optional_dependency(tmp_path):
    path = tmp_path / "knowledge.pdf"
    write_minimal_pdf(path, "PDF SEO knowledge paragraph")

    assert "PDF SEO knowledge paragraph" in extract_text_from_file(path)
