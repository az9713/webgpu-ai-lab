export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ImagePrediction = {
  label: string;
  score: number;
};

export type SearchHit = {
  index: number;
  text: string;
  score: number;
};
