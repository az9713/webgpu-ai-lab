# Bug 003 — Image classifier fails with HTML cached as model weights

**Status:** Fixed  
**Component:** `src/workers/transformers.worker.ts`, browser Cache Storage  
**Severity:** High — image classification completely non-functional

---

## Symptom

Uploading an image triggers classification, but it fails immediately (all three candidate models fail within the same second) with:

```
Image classification failed: Unexpected token '<', "<!doctype "... is not valid JSON
(Received HTML instead of model JSON/weights. Usually bad model path, blocked remote
fetch, or extension/proxy rewrite.)
```

The debug console shows all three model candidates failing at the exact same timestamp:

```
TF status: Trying image model: Xenova/swin-tiny-patch4-window7-224
TF status: Image model failed: Xenova/swin-tiny-patch4-window7-224 (Unexpected token '<'...)
TF status: Trying image model: Xenova/swin-base-patch4-window7-224-in22k
TF status: Image model failed: Xenova/swin-base-patch4-window7-224-in22k (Unexpected token '<'...)
TF status: Trying image model: Xenova/vit-base-patch16-224
TF status: Image model failed: Xenova/vit-base-patch16-224 (Unexpected token '<'...)
```

The instant failure (no network latency) is the key diagnostic clue.

---

## Root cause

### What `@xenova/transformers` does by default

`@xenova/transformers` v2 has two model sources it tries in order:

1. **Local path** — `<origin>/models/<model-name>/` (defaults to `http://localhost:5173/models/` in a Vite dev server)
2. **Remote host** — `https://huggingface.co/<model-name>/resolve/main/`

The local path is checked first and takes precedence. This is controlled by `env.allowLocalModels`, which defaults to `true`.

### The poisoned cache

Inspecting the browser's Cache Storage (`caches.keys()`) revealed a `transformers-cache` containing entries like:

```
http://localhost:5173/models/Xenova/swin-tiny-patch4-window7-224/config.json
http://localhost:5173/models/Xenova/swin-tiny-patch4-window7-224/preprocessor_config.json
http://localhost:5173/models/Xenova/swin-base-patch4-window7-224-in22k/config.json
...
```

These paths do not exist on the Vite dev server. When they were first requested, Vite returned its standard `<!doctype html>` 404 error page. `@xenova/transformers` cached those HTML responses as if they were valid model files.

On every subsequent classification attempt, the library reads these cached HTML pages, attempts `JSON.parse()` on the `<!doctype html>...` body, and throws a `SyntaxError`. The failure is instant because no network request is made — it reads straight from cache.

### Why the worker code has no explicit local path configuration

The transformers worker (`src/workers/transformers.worker.ts`) never set `env.localModelPath` or `env.allowLocalModels`. The default value of `env.allowLocalModels = true` was inherited silently, causing the library to look for models at `/models/` without the developer intending it.

---

## Fix

### Step 1 — Clear the corrupted cache (one-time)

The cached HTML responses had to be deleted from the browser's Cache Storage. This was done via the browser console:

```js
caches.delete('transformers-cache');
```

This step is only needed once per affected browser. It cannot be automated in the app code because the cache is poisoned before the fix takes effect.

### Step 2 — Disable local model lookup in the worker

Add `env.allowLocalModels = false` at the top of the worker file so the library skips the local path entirely and always fetches from Hugging Face:

**Before (`src/workers/transformers.worker.ts`):**

```ts
import { pipeline } from "@xenova/transformers";
```

**After (`src/workers/transformers.worker.ts`):**

```ts
import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = false;
```

With this in place:
- The library goes directly to `https://huggingface.co/Xenova/...` for all model files
- No HTML 404 pages are ever fetched or cached
- First run downloads and correctly caches the real model weights

---

## Verification

After clearing the cache and deploying the fix, the classification completes successfully:

```
TF status: Trying image model: Xenova/swin-tiny-patch4-window7-224
TF status: Image model ready: Xenova/swin-tiny-patch4-window7-224
Status: Image classification complete

Results:
  mosque: 86.24%
  dome: 1.62%
  palace: 1.28%
  monastery: 0.62%
  church, church building: 0.33%
```

---

## How to diagnose this in the future

If image classification (or any `@xenova/transformers` feature) fails instantly with an HTML parse error, run the following in the browser console:

```js
// 1. List all cache keys
caches.keys().then(console.log);

// 2. Inspect entries in the transformers cache
caches.open('transformers-cache')
  .then(c => c.keys())
  .then(keys => keys.map(r => r.url))
  .then(console.log);

// 3. Check if an entry is corrupted (returns HTML instead of JSON)
caches.open('transformers-cache')
  .then(c => c.match('http://localhost:5173/models/Xenova/swin-tiny-patch4-window7-224/config.json'))
  .then(r => r?.text())
  .then(console.log);

// 4. Delete the cache to force a clean re-fetch
caches.delete('transformers-cache');
```

If entries point to `localhost` paths instead of `huggingface.co` paths, the cache is poisoned.

---

## Prevention

Always set `env.allowLocalModels = false` when using `@xenova/transformers` in a browser application that does not serve model files locally. This eliminates the entire class of problem.

If you intend to serve models locally (e.g., bundled with the app or fetched from a company-internal CDN), set:

```ts
env.allowLocalModels = true;
env.localModelPath   = "/your-actual-model-path/";
```

and verify the path returns valid JSON before deploying.
