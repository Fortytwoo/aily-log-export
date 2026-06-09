# Repository Guidelines

## Project Structure & Module Organization

This repository is a Manifest V3 Chrome extension for exporting Feishu Aily runtime logs.

- `manifest.json`: extension manifest, permissions, content script registration, and web-accessible resources.
- `src/content.js`: main page integration, runtime log row/span selection, batch export workflow.
- `src/page-hook.js`: best-effort page-context `fetch`/XHR capture for same-origin log responses.
- `src/content.css`: styles injected into Feishu pages for row checkboxes.
- `src/popup.html`, `src/popup.css`, `src/popup.js`: toolbar popup status and export controls.
- `icons/`: generated PNG icons for Chrome extension sizes.
- `scripts/`: local validation, icon generation, and Chrome smoke testing.
- `docs/`: Chrome Web Store publishing copy, privacy policy, and review notes.

There is no bundled build output directory. Do not commit exported runtime log JSON files or local diagnostic logs.

## Build, Test, and Development Commands

- `.\scripts\generate-icons.ps1`: regenerate `icons/icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`.
- `node .\scripts\validate-extension.mjs`: verify manifest shape and required extension files.
- `node .\scripts\smoke-chrome.mjs`: launch a temporary Chrome profile, load the unpacked extension, and verify list-page checkbox injection.
- `.\scripts\build-webstore.ps1`: create `dist/*-webstore.zip` for Chrome Web Store upload.
- `.\scripts\build-crx.ps1`: optionally create a local CRX package and PEM key in `dist/`.
- `node --check .\src\content.js`: syntax-check a single JavaScript file. Repeat for changed JS files.

For manual testing, open `chrome://extensions`, enable Developer mode, load this repository as an unpacked extension, then open a Feishu Aily runtime-log page.

## Coding Style & Naming Conventions

Use plain JavaScript, HTML, CSS, and PowerShell. Keep files dependency-free unless a dependency is clearly justified. Use two-space indentation in JSON/HTML/CSS and existing JavaScript style in `src/*.js`. Prefer descriptive camelCase names for JavaScript functions and constants in `UPPER_SNAKE_CASE` only for fixed configuration keys.

Do not log or paste Feishu runtime log contents, cookies, tokens, API response bodies, or generated CRX PEM keys in commits, README examples, or issue text.

## Testing Guidelines

Run `node .\scripts\validate-extension.mjs` and `node .\scripts\smoke-chrome.mjs` before committing behavior changes. Update `scripts/smoke-chrome.mjs` when changing injection behavior so it covers the expected UI state, for example default-collapsed toolbar or list-row checkbox creation.

## Commit & Pull Request Guidelines

Recent commits use short imperative summaries, for example `Avoid blocking runtime log controls` and `Support batch export from runtime log list`. Keep commit messages focused on user-visible behavior.

Pull requests should include a concise description, affected extension surfaces, validation commands run, and screenshots or screen recordings for UI changes. Mention any changes to Chrome permissions in `manifest.json`.
