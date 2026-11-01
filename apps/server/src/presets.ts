/**
 * Model provider presets — data, not code paths. The Settings UI reads this
 * list through GET /api/presets and prefills the provider form; adding a new
 * local runtime (LM Studio, vLLM, llama.cpp …) means one more entry here.
 */

export interface ModelPreset {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic" | "mock";
  baseUrl: string | null;
  requiresKey: boolean;
  /** how installed models can be listed; null = manual model input only */
  discover: "ollama-tags" | null;
  note: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "ollama",
    name: "Ollama (로컬)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    requiresKey: false,
    discover: "ollama-tags",
    note: "이 머신의 Ollama 데몬을 모델로 씁니다. 키 불필요.",
  },
  {
    id: "lmstudio",
    name: "LM Studio (로컬)",
    kind: "openai-compatible",
    baseUrl: "http://localhost:1234/v1",
    requiresKey: false,
    discover: null,
    note: "LM Studio의 로컬 서버(OpenAI 호환). 키 불필요.",
  },
];

export interface PresetModel {
  name: string;
  capabilities?: string[];
}

export async function presetModels(presetId: string): Promise<PresetModel[]> {
  const preset = MODEL_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset '${presetId}'`);
  if (preset.discover !== "ollama-tags") return [];
  const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`ollama /api/tags HTTP ${res.status}`);
  const json = (await res.json()) as { models?: { name: string; details?: { capabilities?: string[] } }[] };
  return (json.models ?? []).map((m) => ({ name: m.name, capabilities: m.details?.capabilities }));
}
