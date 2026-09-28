"""Printable bay labels: a QR code per location that the phone and the video read.

The payload is short and versioned ("CB1:LOC:<code>") so a label printed
today still reads after the format grows, and a random QR on a product box
is never mistaken for a bay.
"""

from __future__ import annotations

import html
import io

import segno

from ..plugins.location_tag import label_payload


def qr_svg(code: str, scale: int = 6) -> str:
    qr = segno.make(label_payload(code), error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=scale, border=2, xmldecl=False, svgns=True, dark="#000")
    return buf.getvalue().decode("utf-8")


def qr_png(code: str, scale: int = 8) -> bytes:
    qr = segno.make(label_payload(code), error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=scale, border=2)
    return buf.getvalue()


def sheet_html(locations: list[dict]) -> str:
    """An A4 sheet of labels, 3 across, ready to print on adhesive paper."""
    cells = "".join(
        f"""<div class="label"><div class="qr">{qr_svg(loc['code'], 5)}</div>
            <div class="text"><div class="code">{html.escape(loc['code'])}</div>
            <div class="name">{html.escape(loc.get('name') or '')}</div>
            <div class="hint">Scan before filming</div></div></div>"""
        for loc in locations
    )
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>Location labels</title>
<style>
@page {{ size: A4; margin: 10mm; }}
body {{ font-family: system-ui, sans-serif; margin: 0; }}
.grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 4mm; }}
.label {{ border: 1px dashed #bbb; padding: 3mm; display: flex; gap: 3mm; align-items: center;
          break-inside: avoid; height: 34mm; box-sizing: border-box; }}
.qr svg {{ width: 28mm; height: 28mm; display: block; }}
.code {{ font: 700 15pt ui-monospace, monospace; letter-spacing: .5px; }}
.name {{ font-size: 9pt; color: #333; margin-top: 1mm; }}
.hint {{ font-size: 7pt; color: #777; margin-top: 2mm; text-transform: uppercase; letter-spacing: .6px; }}
@media screen {{ body {{ padding: 16px; background: #eee; }} .grid {{ background: #fff; padding: 10mm; max-width: 190mm; }} }}
</style></head><body><div class="grid">{cells}</div>
<script>if (location.hash === "#print") window.print();</script></body></html>"""
