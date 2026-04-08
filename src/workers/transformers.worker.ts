import { pipeline, env } from "@xenova/transformers";

env.allowLocalModels = false;

type ClassifyMessage = {
  type: "classify";
  requestId: string;
  image: string;
};

type TranscribeMessage = {
  type: "transcribe";
  requestId: string;
  audio: Float32Array;
};

type IndexMessage = {
  type: "index";
  requestId: string;
  docs: string[];
};

type SearchMessage = {
  type: "search";
  requestId: string;
  query: string;
  topK?: number;
};

type WorkerInMessage = ClassifyMessage | TranscribeMessage | IndexMessage | SearchMessage;

let imageClassifierPromise: ReturnType<typeof pipeline> | null = null;
let asrPromise: ReturnType<typeof pipeline> | null = null;
let embeddingPromise: ReturnType<typeof pipeline> | null = null;

let indexedDocs: string[] = [];
let indexedVectors: number[][] = [];

async function getImageClassifier() {
  if (!imageClassifierPromise) {
    self.postMessage({ type: "status", message: "Loading image model: Swin Tiny..." });
    imageClassifierPromise = (async () => {
      const candidates = [
        "Xenova/swin-tiny-patch4-window7-224",
        "Xenova/swin-base-patch4-window7-224-in22k",
        "Xenova/vit-base-patch16-224"
      ];

      let lastError: unknown = null;
      for (const model of candidates) {
        try {
          self.postMessage({ type: "status", message: `Trying image model: ${model}` });
          const classifier = await pipeline("image-classification", model, { quantized: true });
          self.postMessage({ type: "status", message: `Image model ready: ${model}` });
          return classifier;
        } catch (error) {
          lastError = error;
          self.postMessage({
            type: "status",
            message: `Image model failed: ${model} (${error instanceof Error ? error.message : String(error)})`
          });
        }
      }

      throw lastError ?? new Error("No image classification model could be loaded.");
    })();
    imageClassifierPromise.catch(() => { imageClassifierPromise = null; });
  }
  return imageClassifierPromise;
}

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

async function getEmbeddings() {
  if (!embeddingPromise) {
    self.postMessage({ type: "status", message: "Loading embedding model: BGE Small..." });
    embeddingPromise = pipeline(
      "feature-extraction",
      "Xenova/bge-small-en-v1.5",
      { quantized: true }
    );
    embeddingPromise.catch(() => { embeddingPromise = null; });
  }
  return embeddingPromise;
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

async function embedText(text: string): Promise<number[]> {
  const embedder = await getEmbeddings();
  const output = await embedder(text, {
    pooling: "mean",
    normalize: true
  });
  return Array.from(output.data as Float32Array);
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const data = event.data;
  try {
    if (data.type === "classify") {
      self.postMessage({ type: "status", message: "Running image classification..." });
      const classifier = await getImageClassifier();
      const predictions = await classifier(data.image, { topk: 5 });
      self.postMessage({
        type: "result",
        requestId: data.requestId,
        payload: predictions
      });
      return;
    }

    if (data.type === "transcribe") {
      self.postMessage({ type: "status", message: "Transcribing audio..." });
      const asr = await getAsr();
      const output = await asr(data.audio, {
        return_timestamps: false,
        language: "english"
      });
      self.postMessage({
        type: "result",
        requestId: data.requestId,
        payload: output
      });
      return;
    }

    if (data.type === "index") {
      self.postMessage({ type: "status", message: "Building semantic index..." });
      indexedDocs = data.docs;
      indexedVectors = [];
      for (const doc of data.docs) {
        indexedVectors.push(await embedText(doc));
      }
      self.postMessage({
        type: "result",
        requestId: data.requestId,
        payload: { count: indexedDocs.length }
      });
      return;
    }

    const queryVector = await embedText(data.query);
    const hits = indexedVectors
      .map((vector, index) => ({
        index,
        text: indexedDocs[index],
        score: cosineSimilarity(queryVector, vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, data.topK ?? 3);

    self.postMessage({
      type: "result",
      requestId: data.requestId,
      payload: hits
    });
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    if (message.includes("<!doctype")) {
      message += " (Received HTML instead of model JSON/weights. Usually bad model path, blocked remote fetch, or extension/proxy rewrite.)";
    }
    if (data.type === "transcribe" && message.toLowerCase().includes("unauthorized")) {
      message += " (Model requires HuggingFace login. Check that the model is public or provide an access token.)";
    }
    self.postMessage({
      type: "error",
      requestId: data.requestId,
      error: message
    });
  }
};
