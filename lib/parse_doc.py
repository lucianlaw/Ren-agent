#!/usr/bin/env python3
# 文档解析：把 PDF / Word / Excel / PPT / CSV 读成模型能看懂的文本
#
# 设计原则：
#   1. 表格一律转 Markdown 表格，保留行列关系（比纯文字流准得多）
#   2. 读不到就说清楚为什么（扫描件 / 加密 / 格式不支持），不要吐半截假内容
#   3. 大文件按页、按表截断，并在结尾写明「还有多少没读」
#
# 用法：python3 parse_doc.py <绝对路径> [max_chars]
# 输出：单行 JSON {"ok":true,"kind":"pdf","text":"...","meta":{...}} 或 {"ok":false,"error":"..."}

import sys
import os
import json


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def fail(msg):
    out({"ok": False, "error": msg})


def md_table(rows, max_rows=200, max_cols=16):
    rows = [r for r in rows][:max_rows]
    if not rows:
        return "（空表）"
    rows = [[("" if c is None else str(c).replace("|", "\\|").replace("\n", " ").strip()) for c in r[:max_cols]] for r in rows]
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    head = rows[0]
    lines = ["| " + " | ".join(head) + " |", "|" + "---|" * width]
    for r in rows[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


def parse_pdf(path, cap):
    try:
        from pypdf import PdfReader
    except Exception:
        try:
            from PyPDF2 import PdfReader
        except Exception:
            fail("这台机器没装 PDF 解析库")
    try:
        reader = PdfReader(path)
    except Exception as e:
        fail("PDF 打不开：%s" % e)
    if getattr(reader, "is_encrypted", False):
        try:
            reader.decrypt("")
        except Exception:
            fail("这个 PDF 是加密的，需要密码才能读")
    total = len(reader.pages)
    parts = []
    size = 0
    empty = 0
    for i in range(min(total, 120)):
        try:
            t = reader.pages[i].extract_text() or ""
        except Exception:
            t = ""
        t = t.strip()
        if not t:
            empty += 1
            continue
        block = "\n--- 第 %d 页 ---\n%s" % (i + 1, t)
        if size + len(block) > cap:
            parts.append("\n…（到第 %d 页已达长度上限，后面还有 %d 页没读）" % (i + 1, total - i - 1))
            break
        parts.append(block)
        size += len(block)
    if not parts or (empty == min(total, 120) and not "".join(parts).strip()):
        return {"kind": "pdf", "text": "", "meta": {"pages": total, "note": "没有可提取的文字，多半是扫描件——需要走图片识别"},
                "empty": True}
    return {"kind": "pdf", "text": "\n".join(parts), "meta": {"pages": total, "blank_pages": empty}}


def parse_docx(path, cap):
    try:
        import docx
    except Exception:
        fail("这台机器没装 Word 解析库")
    try:
        d = docx.Document(path)
    except Exception as e:
        fail("Word 打不开：%s" % e)
    parts = []
    for p in d.paragraphs:
        t = (p.text or "").strip()
        if t:
            style = (p.style.name or "").lower()
            if style.startswith("heading"):
                parts.append("\n## " + t)
            else:
                parts.append(t)
    for ti, tb in enumerate(d.tables):
        rows = []
        for row in tb.rows:
            rows.append([c.text.strip() for c in row.cells])
        parts.append("\n【表 %d】\n%s" % (ti + 1, md_table(rows)))
    text = "\n".join(parts)
    return {"kind": "docx", "text": text[:cap], "meta": {"tables": len(d.tables), "chars": len(text)}}


def parse_xlsx(path, cap):
    try:
        import openpyxl
    except Exception:
        fail("这台机器没装 Excel 解析库")
    try:
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    except Exception as e:
        fail("Excel 打不开：%s" % e)
    parts = []
    size = 0
    for ws in wb.worksheets:
        rows = []
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i >= 200:
                break
            if all(c is None or str(c).strip() == "" for c in row):
                continue
            rows.append(list(row))
        block = "\n【工作表：%s｜%d 行 × %d 列】\n%s" % (ws.title, ws.max_row or 0, ws.max_column or 0, md_table(rows))
        if size + len(block) > cap:
            parts.append("\n…（已到长度上限，后面的工作表没读：%s）" % "、".join(w.title for w in wb.worksheets))
            break
        parts.append(block)
        size += len(block)
    return {"kind": "xlsx", "text": "\n".join(parts), "meta": {"sheets": [w.title for w in wb.worksheets]}}


def parse_pptx(path, cap):
    try:
        from pptx import Presentation
    except Exception:
        fail("这台机器没装 PPT 解析库")
    try:
        prs = Presentation(path)
    except Exception as e:
        fail("PPT 打不开：%s" % e)
    parts = []
    for i, slide in enumerate(prs.slides):
        buf = []
        for sh in slide.shapes:
            if getattr(sh, "has_table", False):
                rows = [[c.text.strip() for c in r.cells] for r in sh.table.rows]
                buf.append(md_table(rows))
            elif getattr(sh, "has_text_frame", False):
                t = (sh.text_frame.text or "").strip()
                if t:
                    buf.append(t)
        if buf:
            parts.append("\n【第 %d 页】\n%s" % (i + 1, "\n".join(buf)))
    text = "\n".join(parts)
    return {"kind": "pptx", "text": text[:cap], "meta": {"slides": len(prs.slides)}}


def parse_text(path, cap):
    raw = open(path, "rb").read()
    if b"\x00" in raw[:4000]:
        fail("这不是文本文件（内容是二进制），没法直接读")
    for enc in ("utf-8", "gb18030", "utf-16"):
        try:
            t = raw.decode(enc)
            break
        except Exception:
            continue
    else:
        fail("文字编码不认识，读不出来")
    if path.lower().endswith(".csv"):
        import csv
        import io
        rows = list(csv.reader(io.StringIO(t)))[:200]
        return {"kind": "csv", "text": md_table(rows), "meta": {"rows": len(rows)}}
    return {"kind": "text", "text": t[:cap], "meta": {"chars": len(t)}}


def main():
    if len(sys.argv) < 2:
        fail("没有给文件路径")
    path = sys.argv[1]
    cap = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
    if not os.path.exists(path):
        fail("文件不存在：%s" % path)
    if os.path.isdir(path):
        fail("这是一个目录，不是文件")
    ext = os.path.splitext(path)[1].lower()
    size = os.path.getsize(path)
    if size > 60 * 1024 * 1024:
        fail("文件太大（%.1f MB），超过 60MB 不处理" % (size / 1048576.0))

    try:
        if ext == ".pdf":
            r = parse_pdf(path, cap)
        elif ext == ".docx":
            r = parse_docx(path, cap)
        elif ext == ".xlsx":
            r = parse_xlsx(path, cap)
        elif ext == ".pptx":
            r = parse_pptx(path, cap)
        elif ext in (".csv", ".txt", ".md", ".json", ".log", ".tsv"):
            r = parse_text(path, cap)
        elif ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"):
            fail("这是图片，不在这里读——图片要直接交给模型看（视觉通道）")
        elif ext in (".doc", ".xls", ".ppt"):
            fail("这是老版 Office 格式（%s），请另存为 %s 再传" % (ext, ext + "x"))
        else:
            fail("不认识的格式「%s」。能读的是：pdf / docx / xlsx / pptx / csv / txt / md" % (ext or "无扩展名"))
    except SystemExit:
        raise
    except Exception as e:
        fail("解析出错：%s" % e)

    if r.get("empty") or not str(r.get("text") or "").strip():
        r["ok"] = False
        r["error"] = "这个文件里没有可提取的文字。" + (r.get("meta", {}).get("note") or "可能是扫描件或纯图片，请直接传图片让我看。")
        out(r)
    r["ok"] = True
    r["meta"]["bytes"] = size
    out(r)


if __name__ == "__main__":
    main()
