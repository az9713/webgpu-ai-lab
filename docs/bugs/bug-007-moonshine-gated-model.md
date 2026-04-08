# Bug 007 — Moonshine ASR model requires HuggingFace authentication

**Status:** Fixed  
**Component:** `src/workers/transformers.worker.ts`  
**Severity:** High — speech-to-text completely broken; every transcription attempt fails

---

## Symptom

After recording audio and clicking "Transcribe", the request fails immediately with:

```
Transcription failed: Unauthorized access to file: https://huggingface.co/onnx-community/moonshine-base/resolve/main/onnx/encoder_model_quantized.onnx
```

The error appears in the UI status area. No audio is transcribed.

---

## Root cause

The worker was configured to use `onnx-community/moonshine-base` as the ASR model:

```ts
asrPromise = pipeline(
  "automatic-speech-recognition",
  "onnx-community/moonshine-base",
  { quantized: true }
);
```

`@xenova/transformers` fetches model weights from `https://huggingface.co/<model>/resolve/main/...`. At some point after the code was originally written, the `onnx-community/moonshine-base` repository on HuggingFace transitioned from a public model to a **gated model** — meaning it requires the visitor to:

1. Have a HuggingFace account.
2. Accept the model's terms of use on the model card page.
3. Be authenticated (logged in, or have a valid API token set in the environment).

When `@xenova/transformers` fetches a gated model without credentials, HuggingFace returns HTTP **401 Unauthorized**. The library converts this into an "Unauthorized access to file" error.

### Why the error says "Unauthorized access to file" rather than "HTTP 401"

`@xenova/transformers` wraps fetch errors with a message that describes the operation rather than the HTTP status code. The string "Unauthorized access to file" is the library's own error message for a 401 response from HuggingFace. It does not mean a local file permission error.

### Why this is easy to miss

- The model worked in an earlier version of the codebase when it was still public.
- HuggingFace does not announce when a model transitions from public to gated — the change is silent from the consumer's perspective.
- The error message mentions "Unauthorized access to file" which can be misread as a local filesystem or CORS error rather than a model access problem.

---

## Fix

Replace `onnx-community/moonshine-base` with `Xenova/whisper-tiny`, a fully public model with no authentication requirement:

**Before (`src/workers/transformers.worker.ts`):**

```ts
async function getAsr() {
  if (!asrPromise) {
    self.postMessage({ type: "status", message: "Loading speech model: Moonshine Base..." });
    asrPromise = pipeline(
      "automatic-speech-recognition",
      "onnx-community/moonshine-base",
      { quantized: true }
    );
    asrPromise.catch(() => { asrPromise = null; });
  }
  return asrPromise;
}
```

**After (`src/workers/transformers.worker.ts`):**

```ts
async function getAsr() {
  if (!asrPromise) {
    self.postMessage({ type: "status", message: "Loading speech model: Whisper Tiny..." });
    asrPromise = pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny",
      { quantized: true }
    );
    asrPromise.catch(() => { asrPromise = null; });
  }
  return asrPromise;
}
```

The UI heading in `App.tsx` was also updated to reflect the new model:

```tsx
// BEFORE
<h2>Speech To Text (Moonshine Base)</h2>

// AFTER
<h2>Speech To Text (Whisper Tiny)</h2>
```

### Why Whisper Tiny

`Xenova/whisper-tiny` is the `@xenova/transformers`-compatible ONNX export of OpenAI's Whisper Tiny model. It is:

- **Publicly available** — no HuggingFace account or gating required.
- **Maintained by the Xenova organization** — the same publisher as the other models used in this project (Swin Tiny for image classification, BGE Small for embeddings), so it follows the same quantization and packaging conventions.
- **Small** — the quantized model is approximately 40 MB, loading quickly on a typical connection.
- **English-capable** — sufficient for the speech demo, which targets English input.

The `automatic-speech-recognition` pipeline API is identical for both models, so no changes to the transcription call site were needed.

---

## Error hint in the worker

The worker also has an error handler that appends a diagnostic hint when it detects the "unauthorized" keyword:

```ts
if (data.type === "transcribe" && message.toLowerCase().includes("unauthorized")) {
  message += " (Model requires HuggingFace login. Check that the model is public or provide an access token.)";
}
```

This hint was added alongside the fix so that if the same problem recurs with a different model in the future, the error message makes the cause clear immediately rather than appearing as a generic file access error.

---

## Verification

After applying the fix:

1. Record a short audio clip using the "Record" button.
2. Click "Transcribe".
3. The worker status area shows `"Loading speech model: Whisper Tiny..."` on first use, then `"Transcribing audio..."`.
4. The transcription result appears in the output area.
5. No 401 errors in the Network tab — all HuggingFace fetches return 200.

---

## Prevention

When using browser-side ML with `@xenova/transformers` (or similar libraries):

1. **Always verify model access at development time** — open `https://huggingface.co/<org>/<model>` in a browser while logged out and confirm the model files are accessible without authentication.
2. **Prefer models in the `Xenova/` namespace** for browser-side use — these are maintained specifically for `@xenova/transformers` and are consistently public.
3. **Test model fetches in CI** — a simple `curl -I https://huggingface.co/<model>/resolve/main/config.json` that checks for a 200 response can catch gating regressions before they reach production.
4. **Pin model versions** — some model cards change their gating status silently. Using a specific commit SHA in the model path (if the library supports it) prevents silent breakage from repository changes.
