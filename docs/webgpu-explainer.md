# WebGPU and In-Browser AI: A Plain-English Guide

## What Is WebGPU?

Your computer has two processors: a **CPU** (Central Processing Unit) and a **GPU** (Graphics Processing Unit).

- The **CPU** is a generalist. It has a handful of very powerful cores (4–16 typically) that can do almost anything, but only a few things at once.
- The **GPU** is a specialist. It has thousands of smaller, simpler cores designed to do *one kind of thing very fast*: the same arithmetic operation on a huge batch of numbers simultaneously.

GPUs were originally built to draw 3D game frames: every pixel's colour is computed independently, so parallelism is exactly what you need. It turns out that neural networks need exactly the same thing: multiplying huge matrices of numbers together. That is why modern AI workloads run on GPUs.

**WebGPU** is a browser API — standardised in 2023 — that lets JavaScript and WebAssembly programs talk directly to the GPU through the browser. Before WebGPU existed, web pages could only use the GPU for drawing graphics (via WebGL). WebGPU adds a *compute* path: you can submit arbitrary numeric workloads to the GPU the same way a native Python/CUDA program does.

```
Your JavaScript code
       ↓
   WebGPU API   (navigator.gpu)
       ↓
 Browser driver layer
       ↓
   GPU hardware   (DirectX 12 / Vulkan / Metal depending on OS)
```

### Why Is It a Big Deal for AI?

Before WebGPU, running an LLM in a browser meant running it entirely on the CPU via WebAssembly — workable for tiny models, but 10–50× slower than GPU execution. With WebGPU:

- A 1-billion-parameter model (like Llama 3.2 1B) fits in GPU VRAM and generates tokens at conversational speed.
- Transformer attention and matrix multiplications are dispatched as GPU *compute shaders* — tiny programs that run in parallel on thousands of GPU cores.
- The browser handles memory management, security sandboxing, and cross-platform translation (DirectX, Vulkan, Metal) so the developer writes one API.

### What Makes It Feel Magical

From the user's perspective, visiting a web page and having a language model reply in real time — with zero installation, zero server, entirely on their own machine — is new. The technical pieces that make it work:

1. **Quantization** — model weights are compressed from 32-bit floats to 4-bit integers (`q4f16_1`). A 1B-parameter model that would be ~4 GB at full precision becomes ~700 MB. It fits in a laptop GPU.
2. **WASM + WebGPU together** — the neural network runtime (MLC-LLM for LLMs, ONNX Runtime for other models) compiles to WebAssembly so its logic runs in the browser, while the heavy arithmetic is offloaded to the GPU via WebGPU shaders.
3. **Web Workers** — to keep the page responsive while the model is thinking, the inference runs in a background thread (a Worker). The main UI thread stays free to paint buttons and accept input.
4. **SharedArrayBuffer / Cross-Origin Isolation** — high-performance memory sharing between the Worker and the main thread requires `crossOriginIsolated: true`. That is why the app checks and warns if this header is missing.

---

## The Five Demos Explained

### 1. LLM Chat — Llama 3.2 1B (web-llm)

**What you see:** A chat box. You type a message, the model replies word-by-word.

**What happens under the hood:**

1. When the page loads, `App.tsx` spawns a background **Web Worker** (`llm.worker.ts`).
2. It immediately sends the worker an `{ type: "init" }` message.
3. The worker calls `CreateMLCEngine("Llama-3.2-1B-Instruct-q4f16_1-MLC")` from the `@mlc-ai/web-llm` library.
   - The library downloads the quantized model weights (~700 MB) from a CDN on first use. Subsequent visits use the browser cache.
   - It compiles GPU compute shaders for this model on the fly using WebGPU.
4. The worker sends back progress messages (`type: "status"`) so you see "Downloading… (42%)".
5. When ready, it sends `{ type: "ready" }`. The "Send" button becomes active.
6. When you send a message, the main thread posts `{ type: "chat", messages: [...] }` to the worker.
7. The worker calls `engine.chat.completions.create({ stream: true })`. The engine runs the transformer forward pass on the GPU. Each new token is sent back as `{ type: "chat-delta", delta: "..." }` — this is why the response appears word by word.
8. The main thread appends each delta to the last assistant message in React state.

**Why it works:** MLC-LLM pre-compiles the model into WebGPU shader programs that perform matrix multiplications across all GPU cores simultaneously. The 4-bit weights mean less data transferred from VRAM per step, improving throughput.

---

### 2. Image Classification — Swin Tiny

**What you see:** A file picker. Upload a photo, get a ranked list of labels and confidence scores.

**What happens under the hood:**

1. When you pick a file, the browser reads it into a base64 `data:` URL (`fileToDataUrl`).
2. The main thread sends `{ type: "classify", image: dataUrl }` to the **Transformers Worker** (`transformers.worker.ts`).
3. The worker uses `@xenova/transformers` (a port of HuggingFace Transformers to JavaScript/WASM/WebGPU). On first use it lazily downloads `Xenova/swin-tiny-patch4-window7-224` — a Swin Transformer image model.
4. The model processes the image: it splits it into 7×7 pixel patches, passes them through several transformer attention layers, and outputs a probability distribution over 1,000 ImageNet categories.
5. The top-5 predictions (label + probability) come back as `{ type: "result", payload: [...] }`.
6. The main thread renders them as a list.

**The Swin Transformer:** Unlike older CNNs (ResNet etc.) that slide a fixed filter window over an image, Swin Transformers use *shifted window self-attention* — each patch can attend to nearby patches in a hierarchy, making it accurate on a wide range of images while being computationally efficient.

---

### 3. Speech To Text — Whisper Tiny

**What you see:** Start/Stop recording buttons. After stopping, a text transcript appears.

**What happens under the hood:**

1. Clicking "Start Recording" calls `navigator.mediaDevices.getUserMedia({ audio: true })` — the browser's microphone API. The browser asks permission.
2. A `MediaRecorder` captures audio chunks into WebM format.
3. On "Stop", all chunks are assembled into a single `Blob`.
4. The main thread decodes the audio using the **Web Audio API** (`AudioContext.decodeAudioData`), mixes stereo to mono if needed, and downsamples to 16 kHz — the sample rate Whisper was trained on. This produces a raw `Float32Array`.
5. The array is sent to the Transformers Worker via a **transferable** (`transfer: [mono16k.buffer]`) — this moves the underlying memory to the worker with zero copy, saving time.
6. The worker runs `pipeline("automatic-speech-recognition", "Xenova/whisper-tiny")`. Whisper's encoder-decoder architecture converts the audio spectrogram into text tokens.
7. The result `{ text: "..." }` is sent back to the main thread and displayed.

**Why Whisper works offline:** OpenAI's Whisper was trained on 680,000 hours of multilingual audio. The "tiny" variant has ~39M parameters — small enough to run on CPU/WebAssembly in the browser without GPU acceleration, though it takes a few seconds per recording.

---

### 4. Semantic Search — BGE Small v1.5

**What you see:** A "Build Index" button, a search box, and ranked search results.

**What happens under the hood:**

**Semantic search is fundamentally different from keyword search.** A keyword search for "keep UI snappy" would find nothing. A semantic search finds "run heavy inference jobs in Web Workers to avoid blocking paint" because the *meaning* is the same.

How it works:
1. Clicking "Build Index" sends `{ type: "index", docs: [...5 documents...] }` to the Transformers Worker.
2. The worker loads `Xenova/bge-small-en-v1.5` — an **embedding model**. It converts text into vectors (arrays of ~384 numbers) where similar meanings land close together in vector space.
3. Each of the 5 documents is embedded. The resulting 5 vectors are stored in memory (`indexedVectors`).
4. When you search, the query is embedded the same way into a query vector.
5. **Cosine similarity** is computed between the query vector and every document vector: `dot(A,B) / (|A| * |B|)`. This measures the angle between vectors — 1.0 means identical meaning, 0.0 means unrelated.
6. Results are sorted by score and the top 3 are returned.

**Why it feels like magic:** The model has learned a continuous geometry of meaning. "Responsiveness during inference" and "Web Workers to avoid blocking" map to nearby points in 384-dimensional space, even though they share no words.

---

### 5. Hand Tracking — MediaPipe

**What you see:** A camera feed (invisible) overlaid with a canvas showing glowing dots on your hand joints.

**What happens under the hood:**

1. Clicking "Start Camera" downloads the MediaPipe WASM runtime and the `hand_landmarker.task` model file (~8 MB) from `/mediapipe-wasm` and `/mediapipe-model` public paths.
2. `HandLandmarker.createFromOptions` builds the inference pipeline. MediaPipe uses its own WASM+WebGL pipeline (predating WebGPU), so this demo runs on the CPU and GPU via WebGL rather than WebGPU.
3. The browser opens the webcam with `getUserMedia({ video: true })` and feeds frames into a hidden `<video>` element.
4. A `requestAnimationFrame` loop calls `handLandmarkerRef.detectForVideo(videoEl, timestamp)` on every frame (typically 60 fps).
5. For each frame, MediaPipe's palm detection model finds hands, then a 21-keypoint landmark model localises each joint (fingertip, knuckle, wrist etc.) in normalised [0,1] coordinates.
6. The `drawHands` function translates those coordinates to canvas pixels and draws a circle at each joint.

**Why it runs at 60 fps:** The model is deliberately tiny (~8 MB) and runs end-to-end within a single frame budget (~16 ms). MediaPipe compiled the pipeline from TensorFlow Lite to WASM for portability.

---

## How the Architecture Keeps the UI Responsive

All the heavy AI work runs in **Web Workers** — isolated background threads with no access to the DOM.

```
Main Thread (React UI)               Web Workers
──────────────────────────           ──────────────────────────────────
Renders buttons, chat, etc.          llm.worker.ts
                                       └─ web-llm + WebGPU
          postMessage ──────────────►
          ◄─────────── onmessage      transformers.worker.ts
                                       └─ @xenova/transformers
                                       └─ image classify
                                       └─ speech-to-text
                                       └─ semantic embeddings
```

Each request gets a unique `requestId`. A `Map<requestId, {resolve, reject}>` tracks pending promises. When the worker sends back `{ type: "result", requestId: "...", payload: ... }`, the matching promise resolves. This is a classic request-response pattern over message passing.

The Transferable trick (used for audio) avoids copying the `Float32Array` buffer: ownership moves from the main thread to the worker, making it zero-copy even for large audio buffers.

---

## Browser Requirements

| Requirement | Why |
|---|---|
| Chrome or Edge (recent) | WebGPU is not yet enabled in Firefox/Safari stable |
| `crossOriginIsolated: true` | Required for `SharedArrayBuffer`, used by web-llm's WASM runtime |
| ~1–2 GB free VRAM | Llama 3.2 1B q4f16 needs ~700 MB GPU memory |
| Good internet (first load) | Model weights are downloaded on first use, cached thereafter |

The `crossOriginIsolated` flag requires the server to send two HTTP headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
These prevent malicious iframes from reading memory via Spectre-style timing attacks, which is why browsers gate `SharedArrayBuffer` behind them.

---

## Summary

WebGPU democratises GPU compute for the web. Combined with:
- **Quantization** (shrink model weights 8×)
- **WASM runtimes** (run native code in the browser sandbox)
- **Web Workers** (keep the UI thread free)
- **Browser caching** (download once, run forever offline)

...you get a web page that runs a 1-billion-parameter language model, an image classifier, a speech recogniser, a semantic search engine, and real-time hand tracking — all locally, all private, all without installing anything.
