# Bug 005 — Rejected pipeline promises cached permanently

**Status:** Fixed  
**Component:** `src/workers/transformers.worker.ts`  
**Severity:** High — after any model load failure the feature is permanently broken for the rest of the session with no way to recover without a page reload

---

## Symptom

If a model fails to load (network error, bad CDN response, rate limit, etc.), all subsequent requests to that feature fail instantly — even after the original cause is resolved. The error appears immediately without any network activity:

```
Image classification failed: <original error message>
```

or

```
Transcription failed: <original error message>
```

No new network requests appear in DevTools. The error is identical to the original failure on every retry. A page reload clears the problem.

---

## Root cause

The three pipeline loader functions use a module-level variable to cache the `Promise` returned by `pipeline(...)`. The intent is to load each model only once and reuse it:

```ts
let imageClassifierPromise: ReturnType<typeof pipeline> | null = null;

async function getImageClassifier() {
  if (!imageClassifierPromise) {
    imageClassifierPromise = pipeline("image-classification", model, { quantized: true });
  }
  return imageClassifierPromise;
}
```

The check `if (!imageClassifierPromise)` treats any non-null value as "model already loaded". This is correct for a successfully resolved Promise — `await imageClassifierPromise` will return the cached classifier instantly.

But when `pipeline(...)` **rejects** (throws on any model load error), `imageClassifierPromise` is still a non-null `Promise` — it's just a rejected one. The `if (!imageClassifierPromise)` check evaluates to `false`, so the function returns the cached rejected Promise without attempting a new load.

Every subsequent call to `getImageClassifier()` skips the retry logic and immediately `await`s the same rejected Promise, which re-throws the original error. The feature is permanently broken until the variable is reset, which only happens on a page reload (the worker is a module with module-level scope).

The same bug existed in all three pipeline loaders:

```ts
let imageClassifierPromise: ReturnType<typeof pipeline> | null = null;
let asrPromise: ReturnType<typeof pipeline> | null = null;
let embeddingPromise: ReturnType<typeof pipeline> | null = null;
```

---

## Why this is subtle

A rejected Promise is truthy. JavaScript's truthiness check for an object is always `true` regardless of the Promise's settled state:

```js
const p = Promise.reject(new Error("oops"));
Boolean(p) // → true
!p         // → false
```

The `if (!imageClassifierPromise)` check passes for `null` (correct — triggers load) and for a resolved Promise (acceptable — re-awaiting resolves instantly). It fails silently for a rejected Promise (wrong — should trigger a new load attempt).

This is a common mistake when caching async work: **the cached value is a Promise, not its result**, so you must handle the rejected state explicitly.

---

## Fix

After assigning each promise, attach a `.catch` handler that resets the variable to `null` if the Promise rejects. This means a failed load is treated as "not loaded" and the next call will try again:

**Before (`src/workers/transformers.worker.ts`):**

```ts
async function getImageClassifier() {
  if (!imageClassifierPromise) {
    imageClassifierPromise = (async () => {
      // ... candidate model loop
    })();
    // No error handling — rejected promise stays cached
  }
  return imageClassifierPromise;
}

async function getAsr() {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", { quantized: true });
    // No error handling
  }
  return asrPromise;
}

async function getEmbeddings() {
  if (!embeddingPromise) {
    embeddingPromise = pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { quantized: true });
    // No error handling
  }
  return embeddingPromise;
}
```

**After (`src/workers/transformers.worker.ts`):**

```ts
async function getImageClassifier() {
  if (!imageClassifierPromise) {
    imageClassifierPromise = (async () => {
      // ... candidate model loop
    })();
    imageClassifierPromise.catch(() => { imageClassifierPromise = null; });  // ← reset on failure
  }
  return imageClassifierPromise;
}

async function getAsr() {
  if (!asrPromise) {
    asrPromise = pipeline("automatic-speech-recognition", "Xenova/whisper-tiny", { quantized: true });
    asrPromise.catch(() => { asrPromise = null; });  // ← reset on failure
  }
  return asrPromise;
}

async function getEmbeddings() {
  if (!embeddingPromise) {
    embeddingPromise = pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { quantized: true });
    embeddingPromise.catch(() => { embeddingPromise = null; });  // ← reset on failure
  }
  return embeddingPromise;
}
```

### How the fix works

The `.catch` handler does not suppress the error — the Promise is still rejected, and `await getImageClassifier()` in the caller will still throw. The `.catch` side-effect only resets the module variable to `null`.

Timeline for a failure followed by a retry:

1. First call: `imageClassifierPromise` is `null` → creates new Promise → attaches `.catch` handler → returns Promise.
2. Promise rejects (network error, bad model, etc.) → `.catch` handler fires → `imageClassifierPromise = null`.
3. `await getImageClassifier()` in the message handler throws → worker posts error back to main thread.
4. User retries → second call: `imageClassifierPromise` is `null` again → creates a new Promise → attempts model load fresh.

---

## Timing consideration

The `.catch` handler fires asynchronously after the rejection. There is a brief window (between the rejection and the `.catch` handler executing) where `imageClassifierPromise` still holds the rejected Promise. Any call arriving in that exact tick would receive the rejected Promise and fail.

In practice this is not a problem for this app because:
- Model loads take seconds; no user can retry in the same microtask tick.
- The message handler is also async — it `await`s `getImageClassifier()`, which means the handler suspends. By the time a retry message is processed, the `.catch` handler has long since run.

For a high-throughput service where concurrent callers could race, a more robust pattern involves tracking a separate `loadFailed` flag or using explicit state (`idle | loading | ready | error`).

---

## Verification

1. Temporarily change the model name to something invalid (e.g., `"Xenova/does-not-exist"`) in the worker.
2. Attempt image classification — it fails with a 404 / model-not-found error.
3. Change the model name back to a valid one (simulate "the issue is resolved").
4. Attempt image classification again — **before the fix**, this fails instantly with the cached error; **after the fix**, it triggers a new network request and succeeds.

---

## Prevention

When caching a Promise (the "promise memo" pattern), always handle the rejected case:

```ts
// Safe promise memo pattern
let cachedPromise: Promise<Thing> | null = null;

function getThing(): Promise<Thing> {
  if (!cachedPromise) {
    cachedPromise = loadThing();
    cachedPromise.catch(() => { cachedPromise = null; });  // reset on failure
  }
  return cachedPromise;
}
```

This pattern appears in many places: module-level singletons, React context initializers, service worker caches. The `.catch` reset is easy to forget because the happy path works perfectly without it.
