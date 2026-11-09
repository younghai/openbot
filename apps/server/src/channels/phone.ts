
/**
 * Phone/SMS channel (Cue pattern): bots can send SMS and make calls via Twilio.
 * Credentials: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 * Budget: TWILIO_MONTHLY_CAP (USD) checked via usage_caps system.
 */
import { credentialFor } from "../voice.js";
import { registerTool, ToolDenial } from "../tools/gateway.js";

function twilioConfig(): { sid: string; token: string; from: string } | null {
  const sid = credentialFor("TWILIO_ACCOUNT_SID");
  const token = credentialFor("TWILIO_AUTH_TOKEN");
  const from = credentialFor("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

async function twilioAPI(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const cfg = twilioConfig();
  if (!cfg) throw new Error("Twilio 미설정 — TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER 자격증명을 저장하세요");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/${endpoint}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${cfg.sid}:${cfg.token}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio ${endpoint} HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

registerTool({
  name: "phone.sms",
  description: "Send an SMS message via Twilio. Requires TWILIO credentials.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient phone number (E.164 format, e.g. +821012345678)" },
      body: { type: "string", description: "message text (max 1600 chars)" },
    },
    required: ["to", "body"],
  },
  async execute(_ctx, args) {
    const to = String(args.to ?? "").trim();
    if (!/^\+\d{8,15}$/.test(to)) throw new ToolDenial(`invalid phone number: ${to} — E.164 format required (+countrycode...)`);
    const body = String(args.body ?? "").slice(0, 1600);
    if (!body) throw new ToolDenial("body required");
    const r = await twilioAPI("Messages.json", { To: to, From: twilioConfig()!.from, Body: body });
    return { ok: true, sid: r.sid, to, from: twilioConfig()!.from };
  },
});

registerTool({
  name: "phone.call",
  description: "Make a voice call via Twilio. The bot speaks the message using TwiML. Requires TWILIO credentials.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient phone number (E.164)" },
      message: { type: "string", description: "text the bot will speak on the call" },
    },
    required: ["to", "message"],
  },
  async execute(_ctx, args) {
    const to = String(args.to ?? "").trim();
    if (!/^\+\d{8,15}$/.test(to)) throw new ToolDenial(`invalid phone: ${to}`);
    const message = String(args.message ?? "").slice(0, 500);
    if (!message) throw new ToolDenial("message required");
    // Use TwiML Bin or TwiML URL — for v1, use a simple Say verb
    const twiml = `<Response><Say language="ko-KR">${message}</Say></Response>`;
    const r = await twilioAPI("Calls.json", {
      To: to,
      From: twilioConfig()!.from,
      Twiml: twiml,
    });
    return { ok: true, sid: r.sid, to };
  },
});

registerTool({
  name: "phone.status",
  description: "Check if Twilio phone/SMS is configured.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const cfg = twilioConfig();
    return cfg
      ? { configured: true, from: cfg.from }
      : { configured: false, hint: "설정 → 음성 & 키에서 TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER를 저장하세요" };
  },
});
