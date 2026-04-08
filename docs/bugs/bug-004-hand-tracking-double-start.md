# Bug 004 — Hand tracking double-start leaks media stream

**Status:** Fixed  
**Component:** `src/App.tsx` — `startHandTracking` function  
**Severity:** Medium — stream leak and duplicate RAF loop; no visible crash but growing resource usage

---

## Symptom

Clicking "Start Camera" a second time (after hand tracking is already running) causes two overlapping issues:

1. The previous camera stream is never stopped — the browser continues capturing video from the webcam in the background with no consumer, burning CPU and keeping the camera LED lit.
2. A second `requestAnimationFrame` loop starts running in parallel with the first. Both loops process video frames and post results independently, causing duplicate hand landmark messages and potential race conditions on the canvas.

Neither issue produces a visible JavaScript error. The only clue is elevated CPU usage and the camera indicator staying on in some OS taskbars.

---

## Root cause

`startHandTracking` in `App.tsx` had no guard against being called while tracking was already active:

```tsx
// BEFORE — no guard
async function startHandTracking() {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  streamRef.current = stream;           // overwrites old stream reference
  videoRef.current!.srcObject = stream;
  // ...
  function processFrame() {
    // ...
    rafRef.current = requestAnimationFrame(processFrame);
  }
  processFrame();                        // starts a second loop if already running
}
```

When called a second time:

1. `getUserMedia` opens a **new** stream.
2. `streamRef.current` is overwritten with the new stream — the reference to the old stream is now lost.
3. No code calls `.stop()` on the old stream's tracks. The browser keeps streaming video for the old, now-orphaned stream.
4. `processFrame()` is called unconditionally, starting a second RAF loop. The old loop continues from `rafRef.current` (not cancelled), so two loops now run simultaneously.

The "Stop Camera" button calls `streamRef.current.getTracks().forEach(t => t.stop())` — but with the old stream overwritten, it can only stop the new stream. The original stream lives on until the tab is closed.

---

## Fix

Add an early return at the top of `startHandTracking` if a stream is already active:

**Before (`src/App.tsx`):**

```tsx
async function startHandTracking() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    streamRef.current = stream;
    // ...
  }
}
```

**After (`src/App.tsx`):**

```tsx
async function startHandTracking() {
  if (streamRef.current) return;          // ← guard: already running
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    streamRef.current = stream;
    // ...
  }
}
```

Additionally, the "Start Camera" button was disabled while tracking is active to prevent the double-click path entirely:

```tsx
// BEFORE
<button onClick={startHandTracking}>Start Camera</button>

// AFTER
<button onClick={startHandTracking} disabled={handMessage === "Tracking..."}>
  Start Camera
</button>
```

The two layers of defence work together:
- The `disabled` attribute prevents the second click at the UI level.
- The `if (streamRef.current) return` guard handles the programmatic case (e.g., tests or future callers that bypass the button).

---

## Why the old stream is not stoppable once overwritten

The `stopHandTracking` function (called by "Stop Camera") does:

```tsx
streamRef.current?.getTracks().forEach(t => t.stop());
streamRef.current = null;
```

Once `streamRef.current` is overwritten by the second call, there is no reference to the first stream anywhere. `getTracks()` is called on the second stream, which works fine — but the first stream continues running because no code holds a reference to it and `stop()` is never called on its tracks.

This is a general pattern to be aware of: any time a `ref` that holds a resource (stream, socket, timer) is overwritten without first disposing the old value, the old resource leaks.

---

## Verification

After applying the fix:

1. Click "Start Camera" — tracking begins, button becomes disabled.
2. Attempt to click "Start Camera" again — button is unclickable.
3. The `streamRef.current` guard also protects against programmatic double-calls.
4. Open `chrome://webrtc-internals` and confirm only one `getUserMedia` stream is active per "Start Camera" click.
5. Click "Stop Camera" — stream stops, button re-enables, camera LED goes off.

---

## Prevention

For any resource that lives in a `ref` and must be cleaned up (streams, workers, WebSocket connections, animation loops):

1. Always check whether one is already running before creating a new one.
2. Always dispose the old resource before replacing `ref.current`.
3. Disable the trigger UI element while the resource is active.

The pattern:

```tsx
// Correct pattern for an exclusive resource in a ref
async function startResource() {
  if (resourceRef.current) return;         // guard
  const resource = await acquireResource();
  resourceRef.current = resource;
}

function stopResource() {
  resourceRef.current?.dispose();          // clean up old value before clearing
  resourceRef.current = null;
}
```
