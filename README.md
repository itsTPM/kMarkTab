# kMarkTab

A keyboard-first new tab page extension for Chrome. Keep all your bookmarks at a glance with search, a clock, and a configurable background.

<!-- image here -->

## Development

Requires Node 24 and pnpm 12. With [mise](https://mise.jdx.dev/), `mise install` sets up both — versions are pinned in `mise.toml` and `mise.lock`.

Install dependencies (wxt prepare will run automatically):

```bash
pnpm install
```

Dev mode (launches a browser with the extension loaded, with HMR):

```bash
pnpm dev          # Chrome
pnpm dev:firefox  # Firefox
```

Dev mode shows a mock bookmark tree. To use the browser's real bookmarks instead:

```bash
pnpm dev:real          # Chrome
pnpm dev:firefox:real  # Firefox
```

## Backend

Unsplash photos come from [kMarkTab-backend](https://github.com/itsTPM/kMarkTab-backend/), so the extension needs no Unsplash key. Its URL is `WXT_BACKEND_URL` in `.env`; to use another one (e.g. a local backend), put it in `.env.local`:

```bash
WXT_BACKEND_URL=http://localhost:3000
```

## Building

```bash
pnpm build          # → .output/chrome-mv3
pnpm build:firefox  # → .output/firefox-mv2
pnpm zip            # store-ready archive (zip:firefox for Firefox)
```

The built extension can be loaded manually: `chrome://extensions` → "Developer mode" → "Load unpacked" → the `.output/chrome-mv3` directory.

## Checks

```bash
pnpm check  # typecheck + lint + format:check + test
pnpm fix    # lint:fix + format — auto-fix what can be fixed
```

Usually, you won't need to run `pnpm check` because it runs as a pre-commit hook ([simple-git-hooks](https://github.com/toplenboren/simple-git-hooks), installed by `pnpm install`). If it fails, run `pnpm fix`, restage, and commit again; `git commit --no-verify` skips it. After changing the hook config in `package.json`, run `pnpm install` to rebuild it.

The individual steps can also be run on their own, see below.

### Tests

```bash
pnpm test        # single run
pnpm test:watch  # watch mode
```

### Linting and formatting ([Oxlint](https://oxc.rs/docs/guide/usage/linter.html), [html-validate](https://html-validate.org/), [Stylelint](https://stylelint.io/), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html))

```bash
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm typecheck
```
