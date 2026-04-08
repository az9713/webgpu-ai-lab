# Bug 001 — LLM worker silently killed by React StrictMode

**Status:** Fixed  
**Component:** `src/App.tsx`, LLM web worker  
**Severity:** High — LLM feature completely non-functional in development

---

## Symptom

On first load, the LLM status reads "Loading model..." indefinitely. After 90 seconds, the page shows:

```
LLM init timeout after 90s. Likely model download, network fetch failure, or WebGPU incompatibility.
```

The debug console shows `"LLM init posted"` twice, but no status messages ever arrive from the worker — not even `"Initializing LLM engine: ..."`, which is the very first thing the worker sends.

---

## Root cause

### How React 18 StrictMode works in development

React 18 StrictMode **double-invokes every effect** in development to help detect side effects that should be idempotent. The lifecycle is:

```
1. Component renders  →  useMemo runs (creates worker W1)
2. useEffect setup    →  handlers set on W1, "init" posted to W1
3. StrictMode cleanup →  W1.terminate() called
4. useEffect setup    →  handlers set on W1 again, "init" posted to W1 again
```

After step 3, W1 is terminated. In step 4, `W1.postMessage("init")` is called on a dead worker.

### Why no error is thrown

Chrome silently discards messages sent to a terminated worker — `postMessage()` does **not** throw. The call succeeds from JavaScript's perspective, so the code after it (`pushDebugLog("LLM init posted")`) still runs, producing the second log entry. The message is lost.

This can be verified with:

```js
const w = new Worker(/* ... */);
w.terminate();
w.postMessage("test"); // No throw — silently dropped in Chrome
```

### Why `useMemo` doesn't help

`useMemo` with `[]` deps runs **once per component instance**. In StrictMode's double-effect simulation, the component does not re-render — the memo value is preserved. So both effect invocations see the same (eventually terminated) worker.

The result: the real worker is dead, and all subsequent attempts to chat call `postMessage` on a corpse.

---

## Fix

Move worker creation from `useMemo` into `useEffect`. Each effect invocation now creates a fresh worker, so the second (real) invocation in StrictMode always gets a live one. Store the workers in `useRef` so callbacks like `sendChat` can reach them.

**Before (`src/App.tsx`):**

```tsx
// Worker created once in useMemo — gets terminated by StrictMode cleanup
const llmWorker = useMemo(
  () => new Worker(new URL("./workers/llm.worker.ts", import.meta.url), { type: "module" }),
  []
);

useEffect(() => {
  llmWorker.onmessage = (event) => { /* ... */ };
  llmWorker.postMessage({ type: "init" });

  return () => {
    llmWorker.terminate(); // terminates the only worker
  };
}, [llmWorker]);
```

**After (`src/App.tsx`):**

```tsx
// Refs hold workers; creation is deferred to the effect itself
const llmWorkerRef = useRef<Worker | null>(null);
const tfWorkerRef  = useRef<Worker | null>(null);

useEffect(() => {
  // Fresh worker created on every effect setup
  const llmWorker = new Worker(
    new URL("./workers/llm.worker.ts", import.meta.url),
    { type: "module" }
  );
  const tfWorker = new Worker(
    new URL("./workers/transformers.worker.ts", import.meta.url),
    { type: "module" }
  );
  llmWorkerRef.current = llmWorker;
  tfWorkerRef.current  = tfWorker;

  llmWorker.onmessage = (event) => { /* ... */ };
  llmWorker.postMessage({ type: "init" });

  return () => {
    llmWorker.terminate();
    tfWorker.terminate();
    llmWorkerRef.current = null;
    tfWorkerRef.current  = null;
  };
}, []); // empty deps — runs once per real mount
```

All call sites that previously referenced `llmWorker` directly were updated to read from the ref:

```tsx
// Before
llmWorker.postMessage({ type: "chat", ... });

// After
llmWorkerRef.current?.postMessage({ type: "chat", ... });
```

---

## Verification

After the fix, the debug console shows:

```
LLM init posted
LLM init posted                                          ← StrictMode second setup (fresh worker)
LLM status: Initializing LLM engine: Llama-3.2-1B-...  ← worker is alive
LLM status: Start to fetch params (0%)
LLM status: Loading model from cache[1/22]: ...
...
LLM ready
```

---

## Why this only affects development

React StrictMode's double-effect behavior is **development-only**. In a production build (`npm run build && npm run preview`), effects run exactly once and the worker is never terminated prematurely.

This class of bug is easy to miss: the app works perfectly in production and breaks silently in development, with no console error.

---

## Prevention

- Never create resources with side effects (workers, subscriptions, timers, open connections) in `useMemo`. Use `useEffect` with a cleanup function instead.
- Verify that `useEffect` cleanup functions genuinely reverse the setup so StrictMode's double-invoke leaves the system in a clean state.
- If you see `"LLM init posted"` in logs but no subsequent worker status messages, suspect worker termination before checking network or WebGPU issues.
