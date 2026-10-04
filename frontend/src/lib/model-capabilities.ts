export type ModelCategory = "all" | "vision" | "reasoning" | "coding" | "fast";

export interface ModelMetadata {
  id: string;
  name: string;
  org: string;
  category: "vision" | "reasoning" | "coding" | "fast";
  badges: string[];
  description: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsCoding: boolean;
}

const VISION_KEYWORDS = [
  "vision",
  "multimodal",
  "vl",
  "ocr",
  "fuyu",
  "neva",
  "deplot",
  "llava",
  "omni",
  "4o",
  "pixtral",
  "paligemma",
  "qwen-vl",
  "internvl",
  "phi-3-vision",
  "cogvlm",
  "minicpm-v",
  "gemini",
  "claude-3-5",
];

const REASONING_KEYWORDS = [
  "reasoning",
  "deepseek-r1",
  "qwq",
  "o1",
  "o3",
  "nemotron-4",
  "llama-3.1-405b",
  "thinking",
  "reflection",
];

const CODING_KEYWORDS = [
  "coder",
  "code",
  "starcoder",
  "codellama",
  "qwen2.5-coder",
  "deepseek-coder",
  "devops",
  "granite-code",
];

/**
 * Checks if a given model ID supports vision (images, diagrams, documents).
 */
export function isVisionModel(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return VISION_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Checks if a given model ID is a deep reasoning / thinking model.
 */
export function isReasoningModel(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return REASONING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Checks if a given model ID is fine-tuned for code synthesis & debugging.
 */
export function isCodingModel(modelId?: string): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return CODING_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Categorizes any model ID into vision, reasoning, coding, or fast general chat.
 */
export function getModelCategory(modelId?: string): "vision" | "reasoning" | "coding" | "fast" {
  if (isVisionModel(modelId)) return "vision";
  if (isReasoningModel(modelId)) return "reasoning";
  if (isCodingModel(modelId)) return "coding";
  return "fast";
}

/**
 * Extracts organization name from a model ID (e.g. meta/llama -> Meta).
 */
export function getModelOrg(modelId: string): string {
  if (!modelId) return "AI";
  const parts = modelId.split("/");
  if (parts.length > 1) {
    const rawOrg = parts[0].toLowerCase();
    if (rawOrg.includes("meta")) return "Meta";
    if (rawOrg.includes("deepseek")) return "DeepSeek";
    if (rawOrg.includes("nvidia")) return "NVIDIA";
    if (rawOrg.includes("google")) return "Google";
    if (rawOrg.includes("mistral")) return "Mistral";
    if (rawOrg.includes("adept")) return "Adept";
    if (rawOrg.includes("bigcode")) return "BigCode";
    if (rawOrg.includes("databricks")) return "Databricks";
    if (rawOrg.includes("qwen") || rawOrg.includes("alibaba")) return "Qwen";
    if (rawOrg.includes("openai")) return "OpenAI";
    if (rawOrg.includes("anthropic")) return "Anthropic";
    if (rawOrg.includes("01-ai")) return "01.AI";
    if (rawOrg.includes("ai21")) return "AI21 Labs";
    return parts[0];
  }
  const id = modelId.toLowerCase();
  if (/^(gpt-|o[134]-|chatgpt|text-embedding)/.test(id)) return "OpenAI";
  if (id.startsWith("claude")) return "Anthropic";
  if (id.startsWith("gemini") || id.startsWith("gemma")) return "Google";
  if (id.startsWith("deepseek")) return "DeepSeek";
  if (id.startsWith("qwen") || id.startsWith("qwq")) return "Qwen";
  if (id.startsWith("nemotron")) return "NVIDIA";
  if (id.startsWith("llama")) return "Meta";
  if (id.startsWith("grok")) return "xAI";
  if (id.startsWith("mistral") || id.startsWith("ministral") || id.startsWith("codestral")) return "Mistral";
  return "AI";
}

/**
 * Returns formatted metadata and capability badges for a model.
 */
export function getModelMetadata(modelId: string): ModelMetadata {
  const category = getModelCategory(modelId);
  const supportsVision = isVisionModel(modelId);
  const supportsReasoning = isReasoningModel(modelId);
  const supportsCoding = isCodingModel(modelId);
  const org = getModelOrg(modelId);

  const parts = modelId.split("/");
  const shortName = parts.length > 1 ? parts.slice(1).join("/") : modelId;

  const badges: string[] = [];
  if (supportsVision) badges.push("👁️ Vision & Docs");
  if (supportsReasoning) badges.push("🧠 Deep Reasoning");
  if (supportsCoding) badges.push("💻 Code Specialist");
  if (category === "fast") badges.push("⚡ Fast Chat");

  let description = "High-speed instruct model for general assistance and DevOps commands.";
  if (supportsVision) {
    description = "Multimodal model: reads photos, UI screenshots, architecture diagrams, and documents.";
  } else if (supportsReasoning) {
    description = "Deep reasoning model: multi-step chain-of-thought analysis for complex systems.";
  } else if (supportsCoding) {
    description = "Code specialist: optimized for scripts, Dockerfiles, and container debugging.";
  }

  return {
    id: modelId,
    name: shortName,
    org,
    category,
    badges,
    description,
    supportsVision,
    supportsReasoning,
    supportsCoding,
  };
}
