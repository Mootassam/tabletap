"""Render docs/playbook.html -> docs/TableTap-Business-Playbook.pdf (uses Microsoft Edge via Playwright)."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SRC = HERE / "playbook.html"
OUT = HERE / "TableTap-Business-Playbook.pdf"

FOOTER = """<div style="width:100%;font:7.5pt Segoe UI,sans-serif;color:#8f8a83;padding:0 15mm;display:flex;justify-content:space-between">
<span>TableTap · Product &amp; Business Playbook</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>"""

with sync_playwright() as p:
    b = p.chromium.launch(channel="msedge")
    page = b.new_page()
    page.goto(SRC.as_uri(), wait_until="networkidle")
    page.pdf(path=str(OUT), format="A4", print_background=True, prefer_css_page_size=True,
             display_header_footer=True, header_template="<div></div>", footer_template=FOOTER)
    b.close()
print(OUT, os.path.getsize(OUT) // 1024, "KB")
