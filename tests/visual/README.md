# Visual check of the golden render

Design section 10, "Visual": Playwright screenshots of every tab of the golden render, light and dark, at 1440 px and
400 px, with no console errors. It is **local only**: not part of `node --test`, not in CI (there is no browser there).

## Run

```sh
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/python tests/visual/screenshots.py
```

Playwright finds Chromium in its local cache (`~/Library/Caches/ms-playwright` on macOS). If the launch fails, run
`.venv/bin/playwright install chromium` once.

The script runs `node scripts/layout.mjs` and `node scripts/render.mjs` on `tests/fixtures/golden` into a temp dir (a clean
and an internal render), opens each HTML over `file://`, clicks every visible tab, and saves
`tests/visual/out/<mode>-<tab>-<theme>-<size>.png`. Light and dark come from the browser's colour scheme.

It exits 1 on any console error, page error, failed request, or request that leaves `file://` (the page must be offline),
and prints `PASS vs1 ...` or `FAIL vs1 ...` with the errors on stderr. Then open the PNGs and look for overlapping nodes,
edges through cards, unreadable dark mode and clipped panels at 400 px.

`.venv/` and `tests/visual/out/` are gitignored.
