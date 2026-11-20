# Look Match Studio

A browser-based photo editor for wedding portraits, built for Brian's photography workflow.

- **AI editor**: edits a photo step by step (fix, white balance, colour, skin, light) with Light touch / Balanced / Bold strength.
- **Skin**: per-person skin handling (deep and light skin kept true), retoucher-style smooth skin that keeps texture, tattoos and sheen.
- **RAW**: Canon CR3 and other RAW files decoded in the browser with LibRaw (WebAssembly), matched to the camera's own look.
- **Subject only**: edits the people and leaves the background as shot.
- **Curve**: tone curve with Apply to subject / background / whole photo.
- **Looks**: save a look from your edits and apply it to other photos; ideas shown beside the photo.

## Files
- `index.html` – page and styles
- `app.js` – interface and AI editor
- `pipeline.js` – render pipeline (masks, skin, smoothing, curve)
- `develop.js` – develop engine (tone, colour, masks, sharpening)
- `lookcore.js` – colour science and look transfer
- `inpaint.js` – object removal
- `raw/` – libraw-wasm 1.6.0 (RAW decoding)

Runs as a claude.ai artifact; the AI editor uses the artifact's Claude runtime.
