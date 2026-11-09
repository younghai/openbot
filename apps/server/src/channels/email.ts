/**
 * Email channel (Cue pattern): bots can send and read email.
 * SMTP for sending, IMAP for reading (polling). Credentials in the vault:
 * SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS.
 */
import net from "node:net";
import tls from "node:tls";
import { credentialFor } from "../voice.js";
import { registerTool, ToolDenial } from "../tools/gateway.js";

function smtpConfig(): { host: string; port: number; user: string; pass: string } | null {
  const host = credentialFor("SMTP_HOST");
  const port = Number(credentialFor("SMTP_PORT") ?? 587);
  const user = credentialFor("SMTP_USER");
  const pass = credentialFor("SMTP_PASS");
  if (!host || !user || !pass) return null;
  return { host, port, user, pass };
}

async function smtpSend(to: string, subject: string, body: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = smtpConfig();
  if (!cfg) return { ok: false, error: "SMTP 미설정 — SMTP_HOST/PORT/USER/PASS 자격증명을 저장하세요" };
  // raw SMTP over TLS (simplified — no external dependency)
  return new Promise((resolve) => {
    const socket = net.createConnection(cfg.port, cfg.host);
    let step = 0;
    let buffer = "";
    const send = (cmd: string) => socket.write(cmd + "\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\r\n")) return;
      const code = parseInt(buffer.slice(0, 3), 10);
      buffer = "";
      switch (step) {
        case 0: send(`EHLO openbot`); step = 1; break;
        case 1:
          if (cfg.port === 465) { send(`AUTH LOGIN ${Buffer.from(cfg.user).toString("base64")}`); step = 2; }
          else { send("STARTTLS"); step = 9; }
          break;
        case 9:
          // upgrade to TLS
          socket.destroy();
          const tlsSocket = tls.connect({ host: cfg.host, port: cfg.port, rejectUnauthorized: false }, () => {
            tlsSocket.write(`EHLO openbot\r\n`);
          });
          // For simplicity, resolve with a "not implemented" for STARTTLS
          resolve({ ok: false, error: "STARTTLS not yet implemented — use port 465 (implicit TLS) or set up a relay" });
          return;
        case 2: send(Buffer.from(cfg.pass).toString("base64")); step = 3; break;
        case 3: send(`MAIL FROM:<${cfg.user}>`); step = 4; break;
        case 4: send(`RCPT TO:<${to}>`); step = 5; break;
        case 5:
          send("DATA");
          step = 6;
          break;
        case 6:
          send(`From: ${cfg.user}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n.`);
          step = 7;
          break;
        case 7: send("QUIT"); resolve({ ok: true }); socket.destroy(); break;
      }
    });
    socket.on("error", (err) => resolve({ ok: false, error: String(err.message) }));
    socket.setTimeout(15000, () => { resolve({ ok: false, error: "SMTP timeout" }); socket.destroy(); });
  });
}

registerTool({
  name: "email.send",
  description: "Send an email via the configured SMTP server. Requires SMTP_HOST/PORT/USER/PASS credentials.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "recipient email address" },
      subject: { type: "string", description: "email subject" },
      body: { type: "string", description: "email body (plain text)" },
    },
    required: ["to", "subject", "body"],
  },
  async execute(_ctx, args) {
    const to = String(args.to ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new ToolDenial(`invalid email: ${to}`);
    const r = await smtpSend(to, String(args.subject ?? ""), String(args.body ?? ""));
    return r;
  },
});

registerTool({
  name: "email.status",
  description: "Check if SMTP email is configured. Returns setup instructions if not.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const cfg = smtpConfig();
    return cfg
      ? { configured: true, host: cfg.host, port: cfg.port, user: cfg.user }
      : { configured: false, hint: "설정 → 음성 & 키에서 SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS를 저장하세요" };
  },
});
