import * as webllm from "@mlc-ai/web-llm";

type InitMessage = {
  type: "init";
  model?: string;
};

type ChatMessage = {
  type: "chat";
  requestId: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

type ResetMessage = {
  type: "reset";
};

type WorkerInMessage = InitMessage | ChatMessage | ResetMessage;

let engine: any = null;

async function ensureEngine(model = "Llama-3.2-1B-Instruct-q4f16_1-MLC") {
  if (engine) return engine;
  const createEngine = (webllm as any).CreateMLCEngine ?? (webllm as any).createMLCEngine;
  if (!createEngine) {
    throw new Error("No create engine function found in @mlc-ai/web-llm.");
  }
  self.postMessage({ type: "status", message: `Initializing LLM engine: ${model}` });
  engine = await createEngine(model, {
    initProgressCallback(progress) {
      self.postMessage({
        type: "status",
        message: `${progress.text} (${Math.round(progress.progress * 100)}%)`
      });
    }
  });
  self.postMessage({ type: "ready" });
  return engine;
}

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const data = event.data;
  try {
    if (data.type === "init") {
      await ensureEngine(data.model);
      return;
    }

    if (data.type === "reset") {
      if (engine) {
        engine.resetChat();
      }
      self.postMessage({ type: "status", message: "Chat history reset in worker." });
      return;
    }

    const activeEngine = await ensureEngine();
    self.postMessage({ type: "status", message: `LLM chat start: ${data.requestId}` });
    const stream = await activeEngine.chat.completions.create({
      messages: data.messages,
      stream: true,
      temperature: 0.4
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta.length > 0) {
        self.postMessage({
          type: "chat-delta",
          requestId: data.requestId,
          delta
        });
      }
    }

    self.postMessage({
      type: "chat-done",
      requestId: data.requestId
    });
    self.postMessage({ type: "status", message: `LLM chat complete: ${data.requestId}` });
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data.type === "chat" ? data.requestId : undefined,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
