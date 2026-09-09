# Info Highlight

Chrome MV3 extension: click the toolbar icon to heatmap surprisal on the current webpage or PDF. Click again to clear.

This is a separate plugin from Semantic Highlight (`extension/semantic-highlight/`). Shared page/PDF runtime sources live in `extension/shared/`. Build assembles them into a standalone extension artifact.

The `_locales` this plugin declares via `default_locale` is not in this directory: the shared PDF pages own their strings, so build merges `extension/shared/_locales/` into the artifact. Add a `_locales/` here only for strings specific to this plugin (its own keys win on conflict).

Toolbar icon is a 5-row red mosaic (`icons/render-icons.py`); same RGB as the heatmap.

## Load

1. Start the local backend so `http://localhost:5001/api/analyze` is up.
2. Run `python3 extension/scripts/build_extension.py info-highlight` from the repository root.
3. Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/dist/info-highlight/`.
4. Open a normal http(s) article or PDF tab. Click the Info Highlight icon.

No keyboard shortcut. Restricted pages (`chrome://`, Web Store, …) do nothing.

For `file:` PDFs, enable “Allow access to file URLs” on the extension details page.

## Test and package

```bash
npm test
./pack.sh
```

The package command builds the standalone artifact, runs tests, verifies JavaScript syntax and writes `extension/dist/info-highlight-v<version>.zip`.
