# Bug report — Browser AI Lab

Seven bugs were found and fixed during a live debugging session on 2026-04-08. The session covered all five AI features: LLM chat, image classification, speech-to-text, semantic search, and hand tracking.

---

## Summary

| ID | Component | Symptom | Root cause | Severity |
|----|-----------|---------|------------|----------|
| [001](bug-001-worker-terminated-by-strictmode.md) | LLM worker | Status stuck at "Loading model...", times out after 90 s | Worker created in `useMemo` is terminated by React StrictMode cleanup; second `postMessage` silently dropped | High — LLM completely broken in dev |
| [002](bug-002-token-doubling-in-state-updater.md) | Chat UI | Every token appears twice ("WebGPU WebGPU is is...") | `setChatMessages` updater mutates `last.content` in-place; StrictMode double-invokes updaters, applying each delta twice | High — output unreadable |
| [003](bug-003-transformers-local-model-cache.md) | Image classifier | Fails instantly with "Received HTML instead of model JSON" | `@xenova/transformers` defaults to fetching from `localhost/models/`, Vite returns 404 HTML which gets permanently cached | High — image classification broken |
| [004](bug-004-hand-tracking-double-start.md) | Hand tracking | Clicking "Start Camera" twice leaks the first media stream | No guard in `startHandTracking`; `streamRef` overwritten without stopping old tracks, duplicate RAF loops run | Medium — stream and CPU leak |
| [005](bug-005-cached-rejected-pipeline-promises.md) | All TF pipelines | After one model load failure, all retries fail instantly | Rejected `Promise` stored in `imageClassifierPromise` / `asrPromise` / `embeddingPromise`; non-null check treats rejected promise as "loaded" | High — permanent failure with no recovery |
| [006](bug-006-mediapipe-coep-cdn-failure.md) | Hand tracking | "Hand tracking failed: [object Event]" on every attempt | MediaPipe WASM loaded from `cdn.jsdelivr.net` (503 / no CORP header); model from `storage.googleapis.com` blocked by `require-corp` COEP policy | High — hand tracking broken |
| [007](bug-007-moonshine-gated-model.md) | Speech-to-text | "Unauthorized access to file: ...moonshine-base..." | `onnx-community/moonshine-base` is a gated HuggingFace model requiring authentication | High — speech-to-text broken |

---

## Themes

### React 18 StrictMode (Bugs 001, 002)

React StrictMode in development **deliberately double-invokes** effects and state updater functions to surface side effects and mutations. Both bugs existed silently in production and were only revealed by StrictMode. The fixes make the code correct in both environments.

### Browser security headers (Bugs 003, 006)

The app uses `Cross-Origin-Embedder-Policy: require-corp` to enable `SharedArrayBuffer` (required for WebGPU). This policy blocks any cross-origin resource that does not explicitly opt in with a `Cross-Origin-Resource-Policy` header. Three different CDNs were affected: the Vite dev server (Bug 003), `storage.googleapis.com` and `cdn.jsdelivr.net` (Bug 006). The solutions route all external assets through the local Vite server.

### Third-party model availability (Bugs 005, 007)

Browser-side ML depends entirely on models being publicly available at known CDN URLs. Bug 005 shows that a transient fetch failure can permanently break a feature within a session if the failed Promise is cached. Bug 007 shows that models can silently transition from public to gated on HuggingFace, breaking fetches with a 401 that looks like a generic error.

---

## All files changed

| File | Changes |
|------|---------|
| `src/App.tsx` | Workers moved from `useMemo` to `useEffect`; chat delta updater made immutable; `startHandTracking` guard added; Start Camera button disabled while tracking; hand tracking error message improved; MediaPipe URLs changed to local proxy |
| `src/workers/transformers.worker.ts` | `env.allowLocalModels = false`; `.catch(() => reset)` on all three pipeline promises; ASR model changed from `onnx-community/moonshine-base` to `Xenova/whisper-tiny`; error hint updated |
| `vite.config.ts` | Vite middleware plugin added to serve `@mediapipe/tasks-vision/wasm` from node_modules; proxy added for `storage.googleapis.com` model file |

---

## Detailed docs

- [Bug 001 — LLM worker terminated by React StrictMode](bug-001-worker-terminated-by-strictmode.md)
- [Bug 002 — Chat tokens doubled by StrictMode updater double-invoke](bug-002-token-doubling-in-state-updater.md)
- [Bug 003 — Transformers cache poisoned with HTML 404 pages](bug-003-transformers-local-model-cache.md)
- [Bug 004 — Hand tracking double-start leaks media stream](bug-004-hand-tracking-double-start.md)
- [Bug 005 — Rejected pipeline promises cached permanently](bug-005-cached-rejected-pipeline-promises.md)
- [Bug 006 — MediaPipe WASM blocked by COEP and CDN 503](bug-006-mediapipe-coep-cdn-failure.md)
- [Bug 007 — Moonshine ASR model requires HuggingFace authentication](bug-007-moonshine-gated-model.md)
