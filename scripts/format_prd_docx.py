#!/usr/bin/env python3
"""Apply deterministic PRD formatting to a pandoc-generated DOCX."""

from __future__ import annotations

import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Mm, Pt, RGBColor


SKILL_SCRIPTS = Path(
    "/Users/liguang/.codex/plugins/cache/openai-primary-runtime/"
    "documents/26.819.11345/skills/documents/scripts"
)
sys.path.insert(0, str(SKILL_SCRIPTS))

from table_geometry import apply_table_geometry, column_widths_from_weights  # noqa: E402


BLUE = "2E75B6"
HEADER_FILL = "EAF0F6"
GRID = "C9D4E2"
BODY = RGBColor(34, 53, 75)


def set_run_font(run, name: str, size: float, *, bold: bool | None = None, color=None):
    run.font.name = name
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), name)
    run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if color is not None:
        run.font.color.rgb = color


def shade_cell(cell, fill: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_borders(cell, color: str = GRID, size: str = "6"):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = qn(f"w:{edge}")
        el = borders.find(tag)
        if el is None:
            el = OxmlElement(f"w:{edge}")
            borders.append(el)
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), size)
        el.set(qn("w:color"), color)


def mark_repeat_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = tr_pr.find(qn("w:tblHeader"))
    if tbl_header is None:
        tbl_header = OxmlElement("w:tblHeader")
        tr_pr.append(tbl_header)
    tbl_header.set(qn("w:val"), "true")


def prevent_row_split(row):
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = tr_pr.find(qn("w:cantSplit"))
    if cant_split is None:
        tr_pr.append(OxmlElement("w:cantSplit"))


def table_weights(table):
    n = len(table.columns)
    header = [c.text.strip() for c in table.rows[0].cells]
    if n == 1:
        return [1]
    if n == 2:
        return [0.25, 0.75]
    if n == 3:
        if "必填" in header:
            return [0.18, 0.15, 0.67]
        if "优先级" in header:
            return [0.18, 0.67, 0.15]
        return [0.22, 0.48, 0.30]
    if n == 4:
        if "接口" in header:
            return [0.30, 0.13, 0.45, 0.12]
        if "建议业务含义" in header:
            return [0.18, 0.12, 0.22, 0.48]
        if "确认人" in header:
            return [0.10, 0.30, 0.45, 0.15]
        return [0.12, 0.18, 0.58, 0.12]
    return [1 / n] * n


def format_document(input_path: Path, output_path: Path):
    doc = Document(input_path)

    for section in doc.sections:
        section.page_width = Mm(210)
        section.page_height = Mm(297)
        section.top_margin = Mm(22)
        section.bottom_margin = Mm(20)
        section.left_margin = Mm(24)
        section.right_margin = Mm(24)
        section.header_distance = Mm(10)
        section.footer_distance = Mm(10)
        section.different_first_page_header_footer = True

        header_p = section.header.paragraphs[0]
        header_p.text = "菏泽市中医医院  |  产品需求文档（PRD）"
        header_p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        header_p.paragraph_format.space_after = Pt(2)
        for run in header_p.runs:
            set_run_font(run, "Microsoft YaHei", 9, bold=True, color=RGBColor(100, 112, 132))

        footer_p = section.footer.paragraphs[0]
        footer_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        footer_p.add_run("第 ")
        run = footer_p.add_run()
        fld_begin = OxmlElement("w:fldChar")
        fld_begin.set(qn("w:fldCharType"), "begin")
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = " PAGE "
        fld_end = OxmlElement("w:fldChar")
        fld_end.set(qn("w:fldCharType"), "end")
        run._r.extend([fld_begin, instr, fld_end])
        footer_p.add_run(" 页")
        for footer_run in footer_p.runs:
            set_run_font(footer_run, "Microsoft YaHei", 8.5, color=RGBColor(70, 85, 105))

    # Preserve the source document's page system and recurring header/footer.
    normal = doc.styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = BODY
    normal.paragraph_format.space_after = Pt(5)
    normal.paragraph_format.line_spacing = 1.25

    heading_specs = {
        "Heading 1": (20, RGBColor(46, 117, 182), 18, 8),
        "Heading 2": (15, RGBColor(46, 117, 182), 14, 6),
        "Heading 3": (12.5, RGBColor(31, 78, 121), 10, 4),
    }
    for style_name, (size, color, before, after) in heading_specs.items():
        style = doc.styles[style_name]
        style.font.name = "Microsoft YaHei"
        style._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = color
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True
        style.paragraph_format.keep_together = True

    # Make the opening block a real cover page.
    content_heading = next(
        (p for p in doc.paragraphs if p.text.strip() == "1. 文档说明"), None
    )
    if content_heading is not None:
        content_heading.paragraph_format.page_break_before = True
    for page_start in ("8.1.4 患者检查记录列表", "18. 开发分工与实施建议"):
        paragraph = next((p for p in doc.paragraphs if p.text.strip() == page_start), None)
        if paragraph is not None:
            paragraph.paragraph_format.page_break_before = True

    for idx, paragraph in enumerate(doc.paragraphs):
        if idx == 0:
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            paragraph.paragraph_format.space_after = Pt(18)
            for run in paragraph.runs:
                set_run_font(run, "Microsoft YaHei", 26, bold=True, color=RGBColor(46, 117, 182))
        if paragraph.style and paragraph.style.name.startswith("Heading"):
            paragraph.paragraph_format.keep_with_next = True
            paragraph.paragraph_format.keep_together = True

    content_width = int(
        doc.sections[0].page_width.twips
        - doc.sections[0].left_margin.twips
        - doc.sections[0].right_margin.twips
        - 120
    )

    for table in doc.tables:
        widths = column_widths_from_weights(table_weights(table), content_width)
        apply_table_geometry(
            table,
            widths,
            table_width_dxa=content_width,
            indent_dxa=110,
            cell_margins_dxa={"top": 90, "bottom": 90, "start": 110, "end": 110},
        )
        mark_repeat_header(table.rows[0])
        for row_idx, row in enumerate(table.rows):
            prevent_row_split(row)
            for cell in row.cells:
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
                set_cell_borders(cell)
                if row_idx == 0:
                    shade_cell(cell, HEADER_FILL)
                for paragraph in cell.paragraphs:
                    paragraph.paragraph_format.space_before = Pt(0)
                    paragraph.paragraph_format.space_after = Pt(0)
                    paragraph.paragraph_format.line_spacing = 1.05
                    if row_idx == 0:
                        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    for run in paragraph.runs:
                        set_run_font(
                            run,
                            "Microsoft YaHei",
                            8.5 if len(table.columns) >= 4 else 9,
                            bold=True if row_idx == 0 else None,
                            color=RGBColor(31, 78, 121) if row_idx == 0 else BODY,
                        )

    doc.save(output_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: format_prd_docx.py INPUT.docx OUTPUT.docx")
    format_document(Path(sys.argv[1]), Path(sys.argv[2]))
