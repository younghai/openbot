
/**
 * Bot wallet (Cue pattern): payment.send with approval queue integration.
 * "이 책 사줘" → 봇이 결제 요청 → 승인 버튼 → 실행.
 * Uses Stripe PaymentIntent API. Credentials: STRIPE_SECRET_KEY.
 * Budget: PAYMENT_MONTHLY_CAP (USD, stored in usage_caps).
 */
import { credentialFor } from "../voice.js";
import { registerTool, ToolDenial, audit } from "../tools/gateway.js";
import type { ToolContext } from "../tools/gateway.js";

function stripeKey(): string | null { return credentialFor("STRIPE_SECRET_KEY") ?? null; }

registerTool({
  name: "payment.send",
  description: "Create a payment via Stripe. ALWAYS requires user approval (the approval queue handles this). Amount in cents.",
  parameters: {
    type: "object",
    properties: {
      amount: { type: "number", description: "amount in cents (e.g. 1500 = $15.00)" },
      currency: { type: "string", description: "ISO currency code (e.g. usd, krw)" },
      description: { type: "string", description: "what is being paid for" },
      paymentMethod: { type: "string", description: "Stripe payment method ID (pm_...)" },
    },
    required: ["amount", "currency", "description", "paymentMethod"],
  },
  async execute(_ctx, args) {
    const key = stripeKey();
    if (!key) throw new Error("Stripe 미설정 — STRIPE_SECRET_KEY 자격증명을 저장하세요");
    const amount = Number(args.amount ?? 0);
    if (amount <= 0 || amount > 100_000_00) throw new ToolDenial(`invalid amount: ${amount}`);
    const currency = String(args.currency ?? "usd").toLowerCase();
    const pm = String(args.paymentMethod ?? "");
    if (!pm.startsWith("pm_")) throw new ToolDenial("paymentMethod must be a Stripe pm_... id");
    const res = await fetch("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        amount: String(Math.round(amount)),
        currency,
        description: String(args.description ?? "").slice(0, 200),
        payment_method: pm,
        confirm: "true",
      }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Stripe HTTP ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return { ok: true, id: json.id, amount, currency, status: json.status };
  },
});

registerTool({
  name: "payment.status",
  description: "Check if Stripe payments are configured.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const key = stripeKey();
    return key
      ? { configured: true }
      : { configured: false, hint: "설정 → 음성 & 키에서 STRIPE_SECRET_KEY를 저장하세요" };
  },
});
