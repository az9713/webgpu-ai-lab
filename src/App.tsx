import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ImagePrediction, SearchHit } from "./types";
import { getWebGPUStatus } from "./lib/webgpu";

type PendingResolver = {
  resolve: (value: any) => void;
  reject: (reason?: unknown) => void;
  timeoutId?: number;
  op: string;
};

const semanticDocs = [
  "Fresh herbs are best added near the end of cooking to keep aroma and color.",
  "For stable AI UIs, run heavy inference jobs in Web Workers to avoid blocking paint.",
  "Quantization to 8-bit or 4-bit reduces model size and bandwidth for browser delivery.",
  "WebGPU enables parallel compute workloads in modern browsers through shader execution.",
  "Client-side semantic search can ground local LLM prompts with domain documents."
];

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function audioBlobToMono16k(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  const channelData = audioBuffer.numberOfChannels === 1
    ? audioBuffer.getChannelData(0)
    : mixToMono(audioBuffer);
  const downsampled = downsample(channelData, audioBuffer.sampleRate, 16000);
  await audioContext.close();
  return downsampled;
}

function mixToMono(buffer: AudioBuffer) {
  const length = buffer.length;
  const result = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      result[i] += input[i] / buffer.numberOfChannels;
    }
  }
  return result;
}

function downsample(input: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.round(input.length / ratio);
  const output = new Float32Array(length);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < output.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    output[offsetResult] = accum / count;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return output;
}

export function App() {
  const gpu = getWebGPUStatus();
  const isCrossOriginIsolated = window.crossOriginIsolated === true;
  const [status, setStatus] = useState("Idle");

  const [chatInput, setChatInput] = useState("Explain why WebGPU helps local AI apps.");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [llmReady, setLlmReady] = useState(false);
  const [llmStatus, setLlmStatus] = useState("Loading model...");
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const llmReadyRef = useRef(false);

  const [selectedImage, setSelectedImage] = useState<string>("");
  const [predictions, setPredictions] = useState<ImagePrediction[]>([]);

  const [transcript, setTranscript] = useState("");
  const [isRecording, setIsRecording] = useState(false);

  const [searchQuery, setSearchQuery] = useState("How do I keep UI responsive during inference?");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [indexReady, setIndexReady] = useState(false);

  const [handMessage, setHandMessage] = useState("Camera stopped");
  const [handsOnFrame, setHandsOnFrame] = useState(0);

  const pendingMapRef = useRef<Map<string, PendingResolver>>(new Map());
  const llmInitTimeoutRef = useRef<number | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handLandmarkerRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef<number | null>(null);

  const llmWorkerRef = useRef<Worker | null>(null);
  const tfWorkerRef = useRef<Worker | null>(null);

  function pushDebugLog(message: string) {
    const timestamp = new Date().toLocaleTimeString();
    setDebugLogs((prev) => [`${timestamp} ${message}`, ...prev].slice(0, 80));
  }

  useEffect(() => {
    llmReadyRef.current = llmReady;
  }, [llmReady]);

  function sendTfRequest<T>(
    payload: Record<string, unknown>,
    transfer?: Transferable[],
    timeoutMs = 120000
  ) {
    return new Promise<T>((resolve, reject) => {
      const requestId = uid("tf");
      const op = String(payload.type ?? "unknown");
      const timeoutId = window.setTimeout(() => {
        const pending = pendingMapRef.current.get(requestId);
        if (!pending) return;
        pendingMapRef.current.delete(requestId);
        pending.reject(new Error(`Timeout in ${op} after ${Math.round(timeoutMs / 1000)}s`));
        pushDebugLog(`TF timeout: op=${op}, requestId=${requestId}`);
      }, timeoutMs);
      pendingMapRef.current.set(requestId, { resolve, reject, timeoutId, op });
      pushDebugLog(`TF request queued: op=${op}, requestId=${requestId}`);
      if (!tfWorkerRef.current) {
        pendingMapRef.current.delete(requestId);
        if (timeoutId) window.clearTimeout(timeoutId);
        reject(new Error("Transformers worker not initialized"));
        return;
      }
      tfWorkerRef.current.postMessage({ ...payload, requestId }, transfer ?? []);
    });
  }

  useEffect(() => {
    const llmWorker = new Worker(new URL("./workers/llm.worker.ts", import.meta.url), { type: "module" });
    const tfWorker = new Worker(new URL("./workers/transformers.worker.ts", import.meta.url), { type: "module" });
    llmWorkerRef.current = llmWorker;
    tfWorkerRef.current = tfWorker;

    llmInitTimeoutRef.current = window.setTimeout(() => {
      if (!llmReadyRef.current) {
        const msg = isCrossOriginIsolated
          ? "LLM init timeout after 90s. Likely model download, network fetch failure, or WebGPU incompatibility."
          : "LLM init timeout after 90s. crossOriginIsolated=false (likely extension/headers issue).";
        setLlmStatus(msg);
        setStatus(msg);
        pushDebugLog(msg);
      }
    }, 90000);

    llmWorker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data.type === "status") {
        setStatus(data.message);
        setLlmStatus(data.message);
        pushDebugLog(`LLM status: ${data.message}`);
        return;
      }
      if (data.type === "ready") {
        setLlmReady(true);
        setLlmStatus("Model ready");
        setStatus("LLM ready");
        if (llmInitTimeoutRef.current) {
          window.clearTimeout(llmInitTimeoutRef.current);
          llmInitTimeoutRef.current = null;
        }
        pushDebugLog("LLM ready");
        return;
      }
      if (data.type === "chat-delta") {
        setChatMessages((prev) => {
          const clone = [...prev];
          const last = clone[clone.length - 1];
          if (last && last.role === "assistant") {
            clone[clone.length - 1] = { ...last, content: last.content + data.delta };
          } else {
            clone.push({ role: "assistant", content: data.delta });
          }
          return clone;
        });
        return;
      }
      if (data.type === "chat-done") {
        setChatBusy(false);
        setStatus("LLM response complete");
        setLlmStatus("Response complete");
        pushDebugLog(`LLM chat completed: requestId=${data.requestId}`);
        return;
      }
      if (data.type === "error") {
        setChatBusy(false);
        setStatus(`LLM error: ${data.error}`);
        setLlmStatus(`Error: ${data.error}`);
        pushDebugLog(`LLM error: ${data.error}`);
      }
    };

    tfWorker.onmessage = (event: MessageEvent<any>) => {
      const data = event.data;
      if (data.type === "status") {
        setStatus(data.message);
        pushDebugLog(`TF status: ${data.message}`);
        return;
      }
      if (data.type === "error") {
        const pending = pendingMapRef.current.get(data.requestId);
        if (pending?.timeoutId) window.clearTimeout(pending.timeoutId);
        pending?.reject(new Error(data.error));
        pendingMapRef.current.delete(data.requestId);
        setStatus(`Worker error: ${data.error}`);
        pushDebugLog(`TF error: requestId=${data.requestId}, op=${pending?.op ?? "unknown"}, error=${data.error}`);
        return;
      }
      if (data.type === "result") {
        const pending = pendingMapRef.current.get(data.requestId);
        if (pending?.timeoutId) window.clearTimeout(pending.timeoutId);
        pending?.resolve(data.payload);
        pendingMapRef.current.delete(data.requestId);
        pushDebugLog(`TF result: requestId=${data.requestId}, op=${pending?.op ?? "unknown"}`);
      }
    };

    llmWorker.postMessage({ type: "init" });
    pushDebugLog("LLM init posted");
    llmWorker.onerror = (event) => {
      setChatBusy(false);
      setLlmStatus(`Worker crash: ${event.message}`);
      setStatus(`Worker crash: ${event.message}`);
      pushDebugLog(`LLM worker crash: ${event.message}`);
    };
    llmWorker.onmessageerror = () => {
      setChatBusy(false);
      setLlmStatus("Worker message error");
      setStatus("Worker message error");
      pushDebugLog("LLM worker message error");
    };
    tfWorker.onerror = (event) => {
      const msg = `Transformers worker crash: ${event.message}`;
      setStatus(msg);
      pushDebugLog(msg);
    };
    tfWorker.onmessageerror = () => {
      const msg = "Transformers worker message error";
      setStatus(msg);
      pushDebugLog(msg);
    };

    const onWindowError = (event: ErrorEvent) => {
      pushDebugLog(`Window error: ${event.message}`);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      pushDebugLog(`Unhandled rejection: ${String(event.reason)}`);
    };
    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      if (llmInitTimeoutRef.current) {
        window.clearTimeout(llmInitTimeoutRef.current);
        llmInitTimeoutRef.current = null;
      }
      for (const pending of pendingMapRef.current.values()) {
        if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
      }
      pendingMapRef.current.clear();
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      llmWorker.terminate();
      tfWorker.terminate();
      llmWorkerRef.current = null;
      tfWorkerRef.current = null;
    };
  }, []);

  async function sendChat() {
    if (!chatInput.trim() || chatBusy) return;
    if (!llmReady) {
      setLlmStatus("Model still loading. Wait until status shows 'Model ready'.");
      pushDebugLog("Chat blocked: LLM not ready");
      return;
    }
    const userMessage: ChatMessage = { role: "user", content: chatInput };
    const nextMessages = [...chatMessages, userMessage];
    setChatMessages(nextMessages);
    setChatInput("");
    setChatBusy(true);
    setStatus("Generating response...");
    llmWorkerRef.current?.postMessage({
      type: "chat",
      requestId: uid("chat"),
      messages: nextMessages
    });
    pushDebugLog("LLM chat request posted");
  }

  async function onPickImage(file: File) {
    const dataUrl = await fileToDataUrl(file);
    setSelectedImage(dataUrl);
    setStatus("Classifying image...");
    try {
      const result = await sendTfRequest<ImagePrediction[]>({
        type: "classify",
        image: dataUrl
      });
      setPredictions(result);
      setStatus("Image classification complete");
    } catch (error) {
      pushDebugLog(`Image classification failed: ${error instanceof Error ? error.message : String(error)}`);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function buildSemanticIndex() {
    setStatus("Indexing docs...");
    try {
      const result = await sendTfRequest<{ count: number }>({
        type: "index",
        docs: semanticDocs
      });
      setIndexReady(true);
      setStatus(`Indexed ${result.count} documents`);
    } catch (error) {
      pushDebugLog(`Semantic index failed: ${error instanceof Error ? error.message : String(error)}`);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function searchSemantic() {
    if (!indexReady || !searchQuery.trim()) return;
    setStatus("Running semantic search...");
    try {
      const result = await sendTfRequest<SearchHit[]>({
        type: "search",
        query: searchQuery,
        topK: 3
      });
      setSearchHits(result);
      setStatus("Semantic search complete");
    } catch (error) {
      pushDebugLog(`Semantic search failed: ${error instanceof Error ? error.message : String(error)}`);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function startRecording() {
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        setStatus("Processing audio...");
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const mono16k = await audioBlobToMono16k(blob);
        try {
          const result = await sendTfRequest<{ text: string }>(
            { type: "transcribe", audio: mono16k },
            [mono16k.buffer]
          );
          setTranscript(result.text);
          setStatus("Transcription complete");
        } catch (error) {
          pushDebugLog(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
          setStatus(error instanceof Error ? error.message : String(error));
        }
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setStatus("Recording...");
      pushDebugLog("Audio recording started");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pushDebugLog(`Could not start recording: ${message}`);
      setStatus(`Could not start recording: ${message}`);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  async function startHandTracking() {
    if (streamRef.current) return;
    if (!videoRef.current || !canvasRef.current) return;
    try {
      if (!handLandmarkerRef.current) {
        setStatus("Loading hand tracker...");
        const vision = await FilesetResolver.forVisionTasks(
          "/mediapipe-wasm"
        );
        handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "/mediapipe-model/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
          },
          runningMode: "VIDEO",
          numHands: 2
        });
      }

      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setHandMessage("Tracking...");

      const ctx = canvasRef.current.getContext("2d");
      const tick = () => {
        if (!videoRef.current || !canvasRef.current || !ctx || !handLandmarkerRef.current) return;
        canvasRef.current.width = videoRef.current.videoWidth;
        canvasRef.current.height = videoRef.current.videoHeight;
        const now = performance.now();
        const result = handLandmarkerRef.current.detectForVideo(videoRef.current, now);
        drawHands(ctx, result, canvasRef.current.width, canvasRef.current.height);
        setHandsOnFrame(result.landmarks.length);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
      setStatus("Hand tracking active");
      pushDebugLog("Hand tracking started");
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : error instanceof Event
          ? "Failed to load MediaPipe resources (COEP/network error)"
          : String(error);
      pushDebugLog(`Hand tracking failed: ${message}`);
      setStatus(`Hand tracking failed: ${message}`);
    }
  }

  function stopHandTracking() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setHandsOnFrame(0);
    setHandMessage("Camera stopped");
    setStatus("Hand tracking stopped");
  }

  return (
    <main className="app">
      <header className="card">
        <h1>Browser AI Lab (WebGPU)</h1>
        <p>{gpu.reason}</p>
        <p>crossOriginIsolated: {String(isCrossOriginIsolated)}</p>
        <p className="status">Status: {status}</p>
        {!isCrossOriginIsolated && (
          <p className="warn">
            Warning: cross-origin isolation is disabled. Disable extensions for localhost or use an Incognito window.
          </p>
        )}
      </header>

      <section className="card">
        <h2>LLM Chat (Llama 3.2 1B via web-llm)</h2>
        <p>LLM status: {llmStatus}</p>
        <div className="row">
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Ask the local LLM..."
          />
          <button onClick={sendChat} disabled={chatBusy || !llmReady}>
            {chatBusy ? "Generating..." : "Send"}
          </button>
        </div>
        <div className="chat-box">
          {chatMessages.map((msg, idx) => (
            <p key={idx}>
              <strong>{msg.role}:</strong> {msg.content}
            </p>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Image Classification (Swin Tiny)</h2>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onPickImage(file);
          }}
        />
        {selectedImage && <img src={selectedImage} className="preview" alt="Selected input" />}
        <ul>
          {predictions.map((pred) => (
            <li key={pred.label}>
              {pred.label}: {(pred.score * 100).toFixed(2)}%
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Speech To Text (Whisper Tiny)</h2>
        <div className="row">
          <button onClick={startRecording} disabled={isRecording}>
            Start Recording
          </button>
          <button onClick={stopRecording} disabled={!isRecording}>
            Stop
          </button>
        </div>
        <p>{transcript || "Transcript will appear here."}</p>
      </section>

      <section className="card">
        <h2>Semantic Search (BGE Small v1.5)</h2>
        <div className="row">
          <button onClick={buildSemanticIndex} disabled={indexReady}>
            {indexReady ? "Index Ready" : "Build Index"}
          </button>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Ask semantic query..."
          />
          <button onClick={searchSemantic} disabled={!indexReady}>
            Search
          </button>
        </div>
        <ul>
          {searchHits.map((hit) => (
            <li key={`${hit.index}-${hit.score}`}>
              {(hit.score * 100).toFixed(1)}% - {hit.text}
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Hand Tracking (MediaPipe)</h2>
        <div className="row">
          <button onClick={startHandTracking} disabled={handMessage === "Tracking..."}>Start Camera</button>
          <button onClick={stopHandTracking}>Stop Camera</button>
          <span>{handMessage} | Hands detected: {handsOnFrame}</span>
        </div>
        <video ref={videoRef} className="hidden" muted playsInline />
        <canvas ref={canvasRef} className="canvas" />
      </section>

      <section className="card">
        <h2>Debug Console</h2>
        <div className="row">
          <button onClick={() => setDebugLogs([])}>Clear Logs</button>
        </div>
        <div className="debug-log">
          {debugLogs.length === 0 ? (
            <p>No logs yet.</p>
          ) : (
            debugLogs.map((entry, idx) => (
              <p key={`${idx}-${entry}`}>{entry}</p>
            ))
          )}
        </div>
      </section>
    </main>
  );
}

function drawHands(
  ctx: CanvasRenderingContext2D,
  result: HandLandmarkerResult,
  width: number,
  height: number
) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = "#00d1b2";
  ctx.fillStyle = "#00d1b2";
  for (const landmarks of result.landmarks) {
    for (const point of landmarks) {
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
