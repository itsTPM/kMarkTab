# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser extension that replaces the new-tab page: a clock, bookmark search, and a configurable
background (solid color, a local file, an image URL, rotating Unsplash photos (the default) or the Bing image of the day). Built on [WXT](https://wxt.dev/), TypeScript,
single entrypoint (`entrypoints/newtab`).

## Commands

Package manager is pnpm.

```bash
pnpm dev            # launch Chrome with the extension loaded, HMR
pnpm dev:firefox    # same, Firefox
pnpm dev:real       # dev with the browser's real bookmarks instead of the mock tree
                    # (dev:firefox:real for Firefox)

pnpm build          # → .output/chrome-mv3
pnpm build:firefox  # → .output/firefox-mv2
pnpm zip            # store-ready archive (zip:firefox for Firefox)

pnpm check          # typecheck + lint + format:check + test — run before committing
pnpm fix            # lint:fix + format

pnpm test           # vitest run (single run)
pnpm test:watch     # vitest watch mode
pnpm test -- bookmarks   # run a single test file (any vitest CLI filter works after --)

pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint (JS/TS) + html-validate (HTML) + stylelint (CSS)
pnpm lint:fix       # same, with --fix
pnpm format         # oxfmt (writes)
pnpm format:check   # oxfmt --check

pnpm icons          # regenerate icons from SVG sources (scripts/generate-icons.sh)
```

`postinstall` runs `wxt prepare` (generates `.wxt/` types) and `simple-git-hooks`, which installs
the pre-commit hook (`pnpm check`, configured under `"simple-git-hooks"` in `package.json`). The
hook is installed by our own `postinstall` because the package's build script is disabled in
`pnpm-workspace.yaml` (`allowBuilds`). The hook checks the working tree, not just the staged
changes, so keep the whole tree passing `pnpm check` before committing.

To manually load the built extension: `chrome://extensions` → enable Developer mode → "Load
unpacked" → select `.output/chrome-mv3`.

## Architecture

Everything lives under `entrypoints/newtab/`. The source files carry detailed comments on the
non-obvious parts (DST handling, ARIA choices, browser quirks); this is the map.

- `main.ts` — awaits `loadSettings()` once, then starts each feature. Settings must be loaded
  before any feature reads them.
- `core/settings.ts` — the only module that touches settings storage
  (`storage.defineItem('local:settings')`). Loaded once into a module-level cache; `getSettings()`
  is synchronous afterward, `saveSettings()` normalizes form input (clamping, defaults) and
  persists. Every setting is one entry of `SCHEMA`: its default and normalizer (built by
  `oneOf()`, `flag()`, `text()`, `color()`, `intIn()`) and `affects`, the parts of the
  page it refreshes (`background`, `backgroundCache`, `clock`, `appearance`, `bookmarks`).
  `Settings`, `SettingsInput` and `DEFAULT_SETTINGS` are derived from it, and `keysAffecting()` gives
  the keys of an effect. Also mirrors the `clock` settings (`showTime`/`showDate`/`timeFormat`) into
  `localStorage` for `clock-init.js`, and the `appearance` ones (`panelOpacity`/`panelBlur`) for
  `appearance-init.js`.
  `settingsToJson()` / `settingsFromJson()` are the settings file format (`format`, `version`,
  `settings`) for import and export; `imageFileName` is left out, the image file stays on its device.
- `core/dom.ts` — `q<T>(selector, root?)`, a `querySelector` that throws instead of returning null. Use
  it instead of raw `document.querySelector`.
- `public/clock-init.js` + `features/clock.ts` — the clock. `clock-init.js` is a classic
  (non-module) script placed right after the clock markup in `index.html`, so the time and the
  clock settings are applied before the first paint; `clock.ts` only runs the tick. They share
  `window.renderClock` / `window.applyClockSettings` (declared in `globals.d.ts`). `timeFormat`
  (`24h`/`12h`) defaults to the browser language's format (`defaultTimeFormat()`), and
  `clock-init.js` falls back to the same when the mirror is missing.
- `public/appearance-init.js` + `features/appearance.ts` — the panel's opacity and backdrop blur.
  `appearance-init.js` is a classic script in `<head>` that sets `--panel-opacity` and
  `--panel-backdrop` on `:root` before the first paint (`none` instead of `blur(0)` or behind an
  opaque panel); `appearance.ts` reapplies them after settings load and on change, and the settings
  sliders preview through it while dragged. A media query in `style.css`
  (`prefers-reduced-transparency`, `prefers-contrast: more`, `forced-colors`) makes the panel
  opaque regardless; the settings panel mirrors it with `matchMedia` for its hint and summary.
- `features/background.ts` — solid color, a local file, a fixed image URL (loaded as is on every
  refresh: no rotation, sizing or cache), Unsplash rotation or the Bing image of the day, with the
  fetched image URL, time, credit and source cached in `storage.local:background` (Unsplash/Bing only) (a cached image
  of the other source is ignored). The cached URL is the full-size image; `sizedUrl()` applies
  `imageQuality` when it is shown, so another quality costs no new request. `rotate` is `tab` (the next photo in every
  new tab, kept by that tab: cached since `pageOpenedAt`), `hour` or `day`; the periods are aligned
  to the local wall clock, not to the fetch time (a new image at :00 of every hour, or at local
  midnight); see the comments on `rotationPeriod()` and `scheduleNextRotation()`. Unsplash photos come
  from our backend (`../kNewTab-backend`, URL in `WXT_BACKEND_URL`, `.env`) in decks of 30:
  `/v1/curated` when `unsplashSource` is `curated` (or the `unsplashCollection` ID is empty), else `/v1/collections/:id` with an
  `X-Install-Id` (`storage.local:installId`, a random UUID). The unshown rest of the deck is kept in
  `storage.local:unsplashDeck` (with its collection; a deck of another one is ignored), each
  rotation takes the next photo and the next deck is fetched in the background when `DECK_LOW` are
  left. A refused request (`Retry-After`, else 5 min) marks the deck `blocked`: no new request
  until then, and with an empty deck the error is shown (or the stale image) and retried then. Bing ignores
  `rotate`: its undocumented `HPImageArchive.aspx` feed (no key) changes at midnight in the
  selected market's time zone, so the next refresh is `fullstartdate` + 24h, retried in 15 min
  while the old image is still served; see `fetchBingImage()`. `#bg-status` (left of
  the settings button) shows a spinner while loading and the error if there is no image to show;
  a `generation` counter drops results of fetches/loads overtaken by a newer refresh.
  `bingMarket` defaults to the region of the first of `navigator.languages` that has a market
  (`defaultBingMarket()`), else `en-US`.
- `core/image-file.ts` — the local background file, a Blob in IndexedDB (not storage.local: no
  quota, no base64). Settings keep only `imageFileName` for display; the panel stores the picked
  file before saving the settings and deletes it when the name is cleared (Restore defaults).
  `background.ts` turns it into an object URL once per page; `clearCache()` forgets it.
- `features/bookmarks.ts` — the bookmark list:
  - empty query → the full tree, flattened into rows; folder expansion is tracked by node
    identity, collapsed folder ids persist in `storage.local:collapsedFolders`;
  - non-empty query → relevance-ranked flat results from
    [uFuzzy](https://github.com/leeoniya/uFuzzy) over "title + URL", with match highlighting and
    the folder path as a crumb. Word patterns are widened to all Unicode letters, and text is
    folded by `foldForSearch()` (accents, ё → е);
  - Enter with no results searches the web via `browser.search.query`;
  - bookmarks with a non-web URL (`data:`, `file:`, `chrome:`, …) open through `browser.tabs`:
    Chrome silently drops a page's own navigation to them, leaving the spinner on forever. It drops
    `tabs.update()` to `data:` too, so a `data:` URL replaces the current tab by a new one.
    Bookmarklets (`javascript:`) are not run (no page to act on, CSP blocks them): the
    `#list-notice` live region says so;
  - accessibility: APG treeview on a flat DOM — `#list` is `role="tree"`, rows are `treeitem`s
    with explicit `aria-level`/`aria-posinset`/`aria-setsize`; focus never leaves `#search`
    (`role="combobox"` + `aria-activedescendant`); the empty-state message is the `#list-empty`
    live region outside the tree;
  - favicon URL depends on the `faviconProvider` setting; `chrome` uses the extension `_favicon`
    API (needs the `favicon` permission, unavailable in Firefox).
- `features/settings-panel.ts` — the settings drawer, a modal `<dialog>` (`showModal()`: top
  layer, the page behind it inert, Escape closes it), with collapsible `<details>` sections whose
  header shows a summary of their values (`syncSummaries()`). There is no Save button:
  every change goes through `applyChange()`, which stores it and diffs previous vs. next settings
  by `keysAffecting()` to decide what to refresh. Every setting but `bgMode` and
  `imageFileName` (`SPECIAL_KEYS`) has one control `#set-<key>`, filled and listened to
  generically (`FIELD_KEYS`, `fields`). Switches, selects, the source tiles and the file picker apply right away; the
  settings in `COMMIT_KEYS` (typed ones costing a network request) are applied only by their check button or Enter, Escape reverts them (its
  keydown is canceled so the dialog stays open), closing the panel drops them. The Unsplash
  "Collection ID" source without a stored ID only shows its field: it is stored with the ID, once
  a non-empty one is applied. Background errors are repeated in the dialog's own `#set-status` (via `onStatusChange()` from `background.ts`),
  since `#bg-status` is inert while the dialog is open.
  Fields of a background mode live in `[data-mode]` blocks (space-separated list of modes); the
  other modes' fields are only hidden, so their values survive a mode switch. Reset buttons
  (`[data-reset]`, the whole settings or the Background section) need a second click.
  The "Import and export" section downloads the settings as JSON and imports such a file
  through `applyChange()` (every setting replaced, missing ones by defaults, the current image
  file kept; if the imported source is `file` and this device has no file, the status asks for one).
  The About section holds no setting: `initAbout()` fills the name and version from the
  manifest and links the Chrome Web Store reviews by `browser.runtime.id` (hidden in Firefox).
- `data/bookmark-tree.ts` — `loadBookmarkTree()`: the mock tree from `data/mock-bookmarks.ts` under
  `pnpm dev` (unless `WXT_REAL_BOOKMARKS` is set — `pnpm dev:real`), otherwise `browser.bookmarks.getTree()` mapped by `browserTreeToNodes()` (toolbar
  contents hoisted to the top level, other non-empty roots become folders, separators skipped).

Manifest permissions are declared in `wxt.config.ts`: `storage`, `bookmarks`, `search` always,
`favicon` on non-Firefox, `host_permissions` for the backend's origin (from `WXT_BACKEND_URL`) and
`www.bing.com`.

`WXT_BACKEND_URL` is set in the committed `.env` (a placeholder for now); override it in
`.env.local` (not committed), e.g. `http://localhost:3000` for a local backend.

## Invariants — easy to break

- **Background cache order:** when cache-affecting settings change, `clearCache()` must be awaited
  _before_ `refreshBackground()`, otherwise the stale cached image wins.
- **`foldForSearch()` is length-preserving:** every replacement maps one character to one. uFuzzy
  match ranges index into the folded text and are used to highlight the original title.
- **Live regions are never `[hidden]` or removed** (`#list-empty`, `#list-notice`, `#set-reset-status`, `#set-status`, `#set-transfer-status`, `#bg-status`): a live
  region must already be in the accessibility tree when its text changes, or nothing is announced
  (verified in NVDA). Hide them visually instead.
- **`#list` keeps `role="tree"` in both modes** and must not get child elements other than
  `treeitem` rows — the empty-state message stays outside it.
- **Early-paint mirrors:** `clock` and `appearance` in `localStorage` are written by
  `core/settings.ts` and read by `public/clock-init.js` / `public/appearance-init.js`; keep the
  keys and shapes in sync. The `--panel-*` defaults on `:root` in `style.css` must match
  `DEFAULT_SETTINGS`.
- **Adding a setting** touches: its `SCHEMA` entry in `core/settings.ts`; the form field
  `#set-<key>` in `index.html`; `syncSummaries()` and, if it costs a network request,
  `COMMIT_KEYS` in `features/settings-panel.ts`. A setting whose `affects` includes `clock` or
  `appearance` is mirrored for the early-paint scripts, which must read it too.

## Conventions

- Code, comments, UI text and tests are in English.
- UI icons are Material Symbols from Iconify (the `-outline` variant where there is one), saved
  without `width`/`height`/`fill` and painted through a CSS mask (`.icon`). Add each new one to
  the list in `public/licenses/material-symbols.txt`. Brand logos (GitHub, Unsplash) come from Simple Icons
  instead, listed in `public/licenses/simple-icons.txt`; the Bing one from CoreUI Brands (`cib`),
  in `public/licenses/coreui-brands.txt`, as Simple Icons' Bing logo is illegible at icon size.
- CSS uses native nesting: states and pseudo-classes (`:hover`, `:focus-visible`, `:has()`, …) go inside
  the element's own rule via `&`, not as separate flat `.class:state` rules.

## Testing notes

Tests live in `tests/` and use `vitest` + `happy-dom` + `wxt/testing` (`fakeBrowser`, `WxtVitest`
plugin). Feature modules query their DOM elements and cache state at module scope, so each test
must build the DOM it needs, call `vi.resetModules()` and re-import the module fresh — see the
`setup()` / `freshSettings()` helpers at the top of each test file. Call `fakeBrowser.reset()` in
`beforeEach`. Timer-driven code (background rotation, clock, reset confirmation) is tested with
`vi.useFakeTimers()`.
