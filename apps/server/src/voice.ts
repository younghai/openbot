import { db, now } from "./db.js";
import { decrypt, encrypt, maskPresent } from "./crypto.js";

export type TtsProviderName = "browser" | "elevenlabs" | "openai" | "cartesia" | "fish";

export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigError";
  }
}

export function credentialFor(key: string): string | undefined {
  const row = db.prepare("SELECT value_enc FROM credentials WHERE key=?").get(key) as { value_enc: string } | undefined;
  return maskPresent(row?.value_enc) ? decrypt(row!.value_enc) : undefined;
}

export function setCredential(key: string, value: string): void {
  db.prepare(
    "INSERT INTO credentials (key, value_enc, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_enc=excluded.value_enc, updated_at=excluded.updated_at"
  ).run(key, encrypt(value), now());
}

const KEY_FOR: Record<TtsProviderName, string | null> = {
  browser: null,
  elevenlabs: "ELEVENLABS_API_KEY",
  openai: "OPENAI_API_KEY",
  cartesia: "CARTESIA_API_KEY",
  fish: "FISH_API_KEY",
};

export function listCredentialStatus(): { key: string; present: boolean }[] {
  const keys = ["ELEVENLABS_API_KEY", "OPENAI_API_KEY", "CARTESIA_API_KEY", "FISH_API_KEY", "COMPOSIO_API_KEY", "PIPEDREAM_API_KEY", "TELEGRAM_BOT_TOKEN"];
  return keys.map((key) => ({ key, present: credentialFor(key) !== undefined }));
}

/** Synthesize speech with a BYO-key provider. Throws VoiceConfigError when the key is missing. */
export async function synthesize(text: string, provider: TtsProviderName, voice?: string): Promise<{ audio: Buffer; contentType: string }> {
  if (provider === "browser") {
    throw new VoiceConfigError("provider 'browser' is handled client-side via the Web Speech API; the server has nothing to synthesize");
  }
  const keyName = KEY_FOR[provider]!;
  const key = credentialFor(keyName);
  if (!key) throw new VoiceConfigError(`no ${keyName} stored: add it under Settings → Voice & Credentials`);

  const input = text.slice(0, 4000);
  switch (provider) {
    case "elevenlabs": {
      const voiceId = voice || "21m00Tcm4TlvDq8ikWAM";
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text: input, model_id: "eleven_multilingual_v2" }),
        signal: AbortSignal.timeout(60_000),
      });
      return await audioFrom(res, provider);
    }
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: voice || "alloy", input, response_format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      });
      return await audioFrom(res, provider);
    }
    case "cartesia": {
      const res = await fetch("https://api.cartesia.ai/tts/bytes", {
        method: "POST",
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          model_id: "sonic-2",
          transcript: input,
          voice: { mode: "id", id: voice || "79a125e8-cd51-484c-a393-7c1d36128bda" },
          output_format: { container: "mp3", encoding: "mp3", sample_rate: 44100 },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      return await audioFrom(res, provider);
    }
    case "fish": {
      const res = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ text: input, reference_id: voice || "default", format: "mp3" }),
        signal: AbortSignal.timeout(60_000),
      });
      return await audioFrom(res, provider);
    }
  }
}

async function audioFrom(res: Response, provider: string): Promise<{ audio: Buffer; contentType: string }> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${provider} TTS HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error(`${provider} TTS returned empty audio`);
  return { audio: buf, contentType: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg" };
}

/** Whisper-based dictation (OpenAI key). */
export async function transcribe(file: File): Promise<string> {
  const key = credentialFor("OPENAI_API_KEY");
  if (!key) throw new VoiceConfigError("no OPENAI_API_KEY stored for speech-to-text; use browser dictation instead");
  const form = new FormData();
  form.append("file", file, file.name || "audio.webm");
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`whisper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string };
  return json.text ?? "";
}
