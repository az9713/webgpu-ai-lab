# Bug 006 — MediaPipe WASM blocked by COEP and CDN 503

**Status:** Fixed  
**Component:** `src/App.tsx`, `vite.config.ts`  
**Severity:** High — hand tracking completely broken; every attempt fails immediately

---

## Symptom

Clicking "Start Camera" initialises the webcam successfully but the MediaPipe `HandLandmarker` setup fails:

```
Hand tracking failed: [object Event]
```

After improving the error handler to give a more readable message:

```
Hand tracking failed: Failed to load MediaPipe resources (COEP/network error)
```

Network DevTools shows two failing requests:

```
GET https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm/vision_wasm_internal.wasm  → 503 Service Unavailable
GET https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm/vision_wasm_internal.js   → 503 (or no CORP header)
```

And / or:

```
GET https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task  → blocked (COEP)
```

---

## Root cause

The app runs with these HTTP headers on every response from the Vite dev server:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Cross-Origin-Embedder-Policy: require-corp` (COEP) is required to enable `SharedArrayBuffer`, which is needed for WebGPU's multi-threaded work. However, COEP creates a strict rule: **any cross-origin resource loaded by the page must include a `Cross-Origin-Resource-Policy: cross-origin` (or `same-site`) header** in its response. If a cross-origin resource lacks the CORP header, the browser blocks it entirely — the request succeeds at the network level but the browser discards the response and reports a network error.

MediaPipe's JS loads two types of external resources:

### 1. The model file (`storage.googleapis.com`)

The `FilesetResolver` and `HandLandmarker` APIs load the `.task` model bundle from Google Cloud Storage:

```
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
```

`storage.googleapis.com` does **not** include a `Cross-Origin-Resource-Policy` header on its responses. Under COEP `require-corp`, this fetch is blocked.

### 2. The WASM runtime (`cdn.jsdelivr.net`)

`FilesetResolver.forVisionTasks(wasmFileset)` uses `wasmFileset` as the base URL to construct the WASM loader path. The original code passed the official CDN URL:

```ts
const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
);
```

Two problems with this:

1. **jsDelivr was returning 503** for these specific WASM assets at the time of debugging.
2. Even if jsDelivr were available, the WASM and JS files it serves do not include a `Cross-Origin-Resource-Policy` header, so COEP would block them regardless.

### Why the error is `[object Event]`

When a resource load fails due to COEP, the browser fires a generic `error` Event on the loading element (script tag, fetch response, etc.). MediaPipe's internal error handling passes this Event object directly to its rejection handler without converting it to a string. When the caller does:

```ts
} catch (error) {
  setHandMessage(`Hand tracking failed: ${error}`);
}
```

JavaScript's string coercion of an `Event` object produces `[object Event]`.

---

## Fix

The fix has three parts, applied in order as earlier approaches proved insufficient.

### Attempt 1 — Proxy `storage.googleapis.com` (partial fix)

Add a Vite proxy so the model file is fetched by the dev server and re-served to the browser with same-origin semantics:

```ts
// vite.config.ts
server: {
  proxy: {
    "/mediapipe-model": {
      target: "https://storage.googleapis.com",
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/mediapipe-model/, "")
    }
  }
}
```

Change the model URL in `App.tsx` to go through the proxy:

```ts
// BEFORE
const handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  }
});

// AFTER
const handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: {
    modelAssetPath: "/mediapipe-model/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
  }
});
```

This proxied URL is same-origin, so COEP permits it. The Vite proxy rewrites `/mediapipe-model/...` → `https://storage.googleapis.com/...`.

Result: model file loads. WASM still fails.

### Attempt 2 — Proxy `cdn.jsdelivr.net` (failed)

Add a second proxy for the jsDelivr WASM files and point `FilesetResolver` at it:

```ts
// vite.config.ts (attempted)
proxy: {
  "/mediapipe-wasm": {
    target: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm",
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/mediapipe-wasm/, "")
  }
}
```

```ts
// App.tsx (attempted)
const vision = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
```

**This did not work.** MediaPipe's `FilesetResolver` passes the base path to the emscripten WASM loader. Internally, MediaPipe's compiled JS calls `new Worker(...)` and constructs asset URLs by appending filenames to the base path. However, emscripten's WASM loading logic constructs **absolute CDN URLs internally** — it ignores the base path for the actual `.wasm` binary download and goes directly to `cdn.jsdelivr.net`. Proxying the base path has no effect on the absolute URL the emscripten module generates.

Also: jsDelivr returned 503 for these assets, so even if the proxy worked, the upstream was unavailable.

### Attempt 3 — Serve WASM from `node_modules` (final fix)

Since `@mediapipe/tasks-vision` is already installed as a `node_modules` dependency (required for the TypeScript types), its WASM files are available at:

```
node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm
node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js
node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal_loader.js
```

A custom Vite server middleware serves these files at `/mediapipe-wasm/` with the required CORP header:

```ts
// vite.config.ts
import fs from "node:fs";
import path from "node:path";

{
  name: "mediapipe-local-wasm",
  configureServer(server) {
    const wasmDir = path.resolve(
      __dirname,
      "node_modules/@mediapipe/tasks-vision/wasm"
    );
    server.middlewares.use("/mediapipe-wasm", (req, res, next) => {
      const filePath = path.join(wasmDir, req.url ?? "");
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
        res.setHeader("Cache-Control", "public, max-age=86400");
        const ext = path.extname(filePath);
        if (ext === ".wasm") res.setHeader("Content-Type", "application/wasm");
        else if (ext === ".js") res.setHeader("Content-Type", "application/javascript");
        fs.createReadStream(filePath).pipe(res);
      } else {
        next();
      }
    });
  }
}
```

`FilesetResolver` in `App.tsx` points to this local endpoint:

```ts
// BEFORE
const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
);

// AFTER
const vision = await FilesetResolver.forVisionTasks("/mediapipe-wasm");
```

Because `/mediapipe-wasm` is same-origin, MediaPipe's emscripten module can resolve the WASM files without COEP interference. The middleware explicitly adds `Cross-Origin-Resource-Policy: cross-origin` so the files are accessible to any subresource check.

### Part 4 — Improve the error message

```ts
// BEFORE
} catch (error) {
  setHandMessage(`Hand tracking failed: ${error}`);
}

// AFTER
} catch (error) {
  const msg = error instanceof Event
    ? "Failed to load MediaPipe resources (COEP/network error)"
    : error instanceof Error ? error.message : String(error);
  setHandMessage(`Hand tracking failed: ${msg}`);
}
```

---

## Why `vite.config.ts` changes require a server restart

Unlike source files under `src/`, `vite.config.ts` is read once when the dev server process starts. Vite's HMR system watches source files for hot-reload but does not watch its own config file. Changes to `vite.config.ts` take effect only after:

```
Ctrl+C   # stop the running dev server
npm run dev   # restart
```

This was the cause of the "why can't I hotload the page this time" confusion — the proxy and middleware changes needed a full restart before they were active.

---

## Verification

After applying the fix and restarting the dev server:

1. Navigate to `http://localhost:5173`.
2. Click "Start Camera".
3. Network DevTools shows:
   - `GET /mediapipe-wasm/vision_wasm_internal.js` → 200 (served from node_modules)
   - `GET /mediapipe-wasm/vision_wasm_internal.wasm` → 200 (served from node_modules)
   - `GET /mediapipe-model/mediapipe-models/hand_landmarker/...` → 200 (proxied from GCS)
4. Console shows: `"Hand tracking started"`.
5. Hand landmarks appear on the canvas overlay in real time.

---

## Prevention

When building a web app that requires `Cross-Origin-Embedder-Policy: require-corp`:

1. **Audit every cross-origin resource** at development time — CDN-hosted scripts, fonts, images, WASM binaries, model files.
2. For each resource, check that the CDN includes `Cross-Origin-Resource-Policy: cross-origin` in its response headers (use `curl -I <url>` or DevTools Network tab).
3. For any resource that lacks CORP (or that you don't control), either:
   - Route it through a same-origin proxy (Vite dev-server proxy or a production reverse proxy/CDN).
   - Serve it from `node_modules` via a custom middleware (for build dependencies).
   - Self-host the file at a path you control.
4. Never rely on CDN availability for blocking resources — CDN outages (like the jsDelivr 503 here) will take down your feature. Prefer `node_modules`-local assets for critical runtime dependencies.
