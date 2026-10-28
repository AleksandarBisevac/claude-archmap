#!/usr/bin/env python3
"""Visual check of the golden render (design section 10, "Visual").

Lays out and renders tests/fixtures/golden (clean, internal and shared) into a temp dir, opens each HTML over
file:// in headless Chromium, and for every tab, in light and dark, at 1440 px and 400 px, saves a screenshot to
tests/visual/out/. Exits 1 on any console error or warning, page error, failed request or request that leaves file://.

It also exercises its own failure path (P2-R4): a second run with --inject-fault plants a console.error, a console.warn
and an external request in the page and must exit 1 naming all three.

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
CONSOLE_FAILS = ("error", "warning")  # a warning fails the check as well as an error
# Planted into every page on --inject-fault: one console error, one console warning, one request that leaves file://.
FAULT_JS = """window.addEventListener('DOMContentLoaded', () => {
  console.error('injected-console-error');
  console.warn('injected-console-warning');
  const i = new Image(); i.src = 'http://injected-external.invalid/x.png';
});"""


def node(*args):
    subprocess.run(["node", *map(str, args)], cwd=ROOT, check=True)


def build(tmp):
    model = GOLDEN / "architecture.model.json"
    layout = tmp / "layout.json"
    node("scripts/layout.mjs", model, "--out", layout)
    pages = {}
    for mode in ("clean", "internal", "shared"):
        out = tmp / f"{mode}.html"
        args = ["scripts/render.mjs", model, "--layout", layout, "--mode", mode, "--out", out]
        if mode != "clean":
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


def check_page(browser, mode, html, results, errors, sizes=SIZES, themes=THEMES, fault=False, shoot=True):
    for size_name, (w, h) in sizes.items():
        for theme in themes:
            ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=theme)
            page = ctx.new_page()
            if fault:
                page.add_init_script(FAULT_JS)
            where = f"{mode}/{size_name}/{theme}"

            def on_console(msg, where=where):
                if msg.type in CONSOLE_FAILS:
                    errors.append(f"{where}: console {msg.type}: {msg.text}")

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
                shown += 1
                if shoot:
                    path = OUT / f"{mode}-{tab}-{theme}-{size_name}.png"
                    page.screenshot(path=str(path), full_page=True)
                    results.append(str(path.relative_to(ROOT)))
            if shown == 0:
                errors.append(f"{where}: no visible tabs")
            ctx.close()


def run(fault):
    """One pass over the golden render. With fault=True: clean mode only, desktop and light, no screenshots."""
    results, errors = [], []
    with tempfile.TemporaryDirectory() as t, sync_playwright() as p:
        pages = build(Path(t))
        browser = p.chromium.launch(headless=True)
        for mode, html in pages.items():
            if fault:
                check_page(browser, mode, html, results, errors, sizes={"desktop": SIZES["desktop"]},
                           themes=("light",), fault=True, shoot=False)
                break
            check_page(browser, mode, html, results, errors)
        browser.close()
    return results, errors


def failure_path():
    """vs2: run this script with --inject-fault in a child and require exit 1 naming each planted fault."""
    child = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--inject-fault"],
                           cwd=ROOT, capture_output=True, text=True)
    wanted = ("console error: injected-console-error", "console warning: injected-console-warning",
              "external request: http://injected-external.invalid/x.png")
    missing = [w for w in wanted if w not in child.stderr]
    problems = ([f"child exit {child.returncode}, wanted 1"] if child.returncode != 1 else []) + \
        [f"child stderr lacks '{w}'" for w in missing]
    for pr in problems:
        print("ERROR", pr, file=sys.stderr)
    print(f"{'PASS' if not problems else 'FAIL'} vs2 failure path: an injected console error, console warning and "
          f"external request make the run exit 1 ({len(problems)} problems)")
    return not problems


def main():
    if "--inject-fault" in sys.argv:
        _, errors = run(fault=True)
        for e in errors:
            print("ERROR", e, file=sys.stderr)
        return 1 if errors else 0  # a clean fault run would mean the check is blind
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.png"):
        old.unlink()
    results, errors = run(fault=False)
    for r in results:
        print("shot", r)
    for e in errors:
        print("ERROR", e, file=sys.stderr)
    ok = not errors and bool(results)
    # Case id first, as the house suites print it: vs1 is the golden render, vs2 the failure path.
    print(f"{'PASS' if ok else 'FAIL'} vs1 golden render (clean, internal and shared), every tab, light and dark, 1440 and 400 px: "
          f"{len(results)} screenshots, {len(errors)} errors")
    ok2 = failure_path()
    return 0 if ok and ok2 else 1


if __name__ == "__main__":
    sys.exit(main())
