#!/usr/bin/env python3
"""Visual check of the golden render (design section 10, "Visual").

Lays out and renders tests/fixtures/golden (clean and internal) into a temp dir, opens each HTML over file://
in headless Chromium, and for every tab, in light and dark, at 1440 px and 400 px, saves a screenshot to
tests/visual/out/. Exits 1 on any console error, page error, failed request or request that leaves file://.

Local only: not part of `node --test`, not in CI. See tests/visual/README.md.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "tests" / "fixtures" / "golden"
OUT = Path(__file__).resolve().parent / "out"
SIZES = {"desktop": (1440, 900), "narrow": (400, 800)}
THEMES = ("light", "dark")
LOCAL_SCHEMES = ("file:", "data:", "blob:", "about:")


def node(*args):
    subprocess.run(["node", *map(str, args)], cwd=ROOT, check=True)


def build(tmp):
    model = GOLDEN / "architecture.model.json"
    layout = tmp / "layout.json"
    node("scripts/layout.mjs", model, "--out", layout)
    pages = {}
    for mode in ("clean", "internal"):
        out = tmp / f"{mode}.html"
        args = ["scripts/render.mjs", model, "--layout", layout, "--mode", mode, "--out", out]
        if mode == "internal":
            args += ["--issues", GOLDEN / "issues.json"]
        node(*args)
        pages[mode] = out
    return pages


# Layout checks for the figure in the open tab (P2-R1): the default view fits the figure to the panel width, so
# nothing is clipped on the right and nothing scrolls sideways, the drawing fills its viewBox (no mostly blank canvas),
# and a scale control (Fit / 100%) lets the reader zoom in and scroll.
FIGURE_JS = """() => [...document.querySelectorAll('.fig-scroll')].filter(f => f.offsetParent !== null).map(f => {
  const svg = f.querySelector('svg'), r = svg.getBoundingClientRect(), fr = f.getBoundingClientRect();
  const vb = svg.viewBox.baseVal, bb = svg.getBBox();
  const ctl = f.parentElement.querySelector('.fig-scale');
  return {id: svg.id, overflow: f.scrollWidth - f.clientWidth, right: r.right - fr.right, width: r.width,
          fill: vb.width ? bb.width / vb.width : 1,
          control: !!ctl, fitOn: !!ctl && !!ctl.querySelector('[data-scale="fit"][aria-pressed="true"]')};
})"""


def check_figures(page, where, errors):
    for fig in page.evaluate(FIGURE_JS):
        at = f"{where}/{fig['id']}"
        if fig["overflow"] > 1 or fig["right"] > 1:
            errors.append(f"{at}: figure clipped on the right (scroll overflow {fig['overflow']}px, svg past panel {fig['right']:.0f}px)")
        if fig["fill"] < 0.6:
            errors.append(f"{at}: drawing fills only {fig['fill']:.0%} of its viewBox (mostly blank canvas)")
        if not fig["control"] or not fig["fitOn"]:
            errors.append(f"{at}: no scale control with Fit pressed by default")
        else:
            fig_el = page.locator(f'#{fig["id"]}').locator("xpath=ancestor::figure")
            fig_el.locator("button[data-scale='full']").click()
            wide = next(w for w in page.evaluate(FIGURE_JS) if w["id"] == fig["id"])
            fig_el.locator("button[data-scale='fit']").click()
            if wide["width"] < fig["width"] - 1:
                errors.append(f"{at}: 100% is narrower than Fit")


def check_page(browser, mode, html, results, errors):
    for size_name, (w, h) in SIZES.items():
        for theme in THEMES:
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=theme)
            page = ctx.new_page()
            where = f"{mode}/{size_name}/{theme}"

            def on_console(msg, where=where):
                if msg.type == "error":
                    errors.append(f"{where}: console error: {msg.text}")

            def on_request(req, where=where):
                if not req.url.startswith(LOCAL_SCHEMES):
                    errors.append(f"{where}: external request: {req.url}")

            page.on("console", on_console)
            page.on("pageerror", lambda e, where=where: errors.append(f"{where}: page error: {e}"))
            page.on("requestfailed", lambda r, where=where: errors.append(f"{where}: request failed: {r.url}"))
            page.on("request", on_request)
            page.goto(html.as_uri())
            page.wait_for_load_state("networkidle")
            tabs = page.eval_on_selector_all("#navlist [data-tab]", "els => els.map(e => e.dataset.tab)")
            shown = 0
            for tab in tabs:
                btn = page.locator(f'#navlist [data-tab="{tab}"]')
                if not btn.is_visible():
                    continue  # e.g. the Issues tab in a clean render
                btn.click()
                page.wait_for_timeout(300)
                check_figures(page, f"{where}/{tab}", errors)
                path = OUT / f"{mode}-{tab}-{theme}-{size_name}.png"
                page.screenshot(path=str(path), full_page=True)
                shown += 1
                results.append(str(path.relative_to(ROOT)))
            if shown == 0:
                errors.append(f"{where}: no visible tabs")
            ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    results, errors = [], []
    with tempfile.TemporaryDirectory() as t, sync_playwright() as p:
        pages = build(Path(t))
        browser = p.chromium.launch(headless=True)
        for mode, html in pages.items():
            check_page(browser, mode, html, results, errors)
        browser.close()
    for r in results:
        print("shot", r)
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    ok = not errors and bool(results)
    # Case id first, as the house suites print it: vs1 is the one case this script carries.
    print(f"{'PASS' if ok else 'FAIL'} vs1 golden render (clean and internal), every tab, light and dark, 1440 and 400 px: "
          f"{len(results)} screenshots, {len(errors)} errors")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
