# Browser AI Lab (WebGPU)

> Inspired by the YouTube video **[WebGPU Turns Your Browser Into A Free Local AI Server](https://www.youtube.com/watch?v=1mix7WnuEK0&t=1s)** by Van Riel.

A frontend-only TypeScript/React app that runs five AI capabilities entirely in the browser — no server, no API key, no installation. Everything executes on your local GPU via WebGPU.

https://github.com/user-attachments/assets/77ef50d4-a3f0-4d88-9403-da64c3440d70

---

## Demos

| Demo | Model | Library |
|---|---|---|
| **LLM Chat** | Llama 3.2 1B (4-bit quantized) | `@mlc-ai/web-llm` |
| **Image Classification** | Swin Tiny | `@xenova/transformers` |
| **Speech-to-Text** | Whisper Tiny | `@xenova/transformers` |
| **Semantic Search** | BGE Small v1.5 | `@xenova/transformers` |
| **Hand Tracking** | MediaPipe Hand Landmarker | `@mediapipe/tasks-vision` |

---

## Getting Started

```bash
npm install
npm run dev
```

Open the local Vite URL in a **Chromium-based browser** (Chrome or Edge) with WebGPU support.

> **First run:** model weights are downloaded from HuggingFace/CDN and cached in the browser. Llama 3.2 1B is ~700 MB. Subsequent visits are instant.

---

## Requirements

- Chrome or Edge (recent — WebGPU is not yet in Firefox/Safari stable)
- A GPU with ~1 GB VRAM free (integrated graphics work for small models)
- The page must be served with cross-origin isolation headers (the Vite dev server handles this automatically via `vite.config.ts`)

The app will display a warning if `crossOriginIsolated` is `false`. If you see it on localhost, try opening an Incognito window or disabling browser extensions.

---

## Architecture

All heavy inference runs in **Web Workers** so the UI stays responsive:

```
Main Thread (React)
  ├─ llm.worker.ts       ← Llama via web-llm + WebGPU
  └─ transformers.worker.ts  ← Swin / Whisper / BGE via @xenova/transformers
```

MediaPipe hand tracking runs on the main thread using `requestAnimationFrame` and WebGL.

---

## Stack

- [Vite](https://vitejs.dev/) + [React](https://react.dev/) + TypeScript
- [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) — LLM inference via WebGPU
- [@xenova/transformers](https://github.com/xenova/transformers.js) — ONNX-based vision, speech, and embedding models
- [@mediapipe/tasks-vision](https://developers.google.com/mediapipe) — real-time hand landmark detection

---

## How It Works

See [`docs/webgpu-explainer.md`](docs/webgpu-explainer.md) for a plain-English deep-dive into WebGPU and how each demo works under the hood.
