import crypto from "node:crypto";
import { getSecret } from "./config.js";

function key(): Buffer {
  return crypto.createHash("sha256").update(getSecret()).digest();
}

/** AES-256-GCM. Output: v1:<iv-b64>:<tag-b64>:<data-b64> */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(enc: string): string {
  const [version, ivB64, tagB64, dataB64] = enc.split(":");
  if (version !== "v1") throw new Error("unknown ciphertext version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function tryDecrypt(enc: string | null | undefined): string | undefined {
  if (!enc) return undefined;
  try {
    return decrypt(enc);
  } catch {
    return undefined;
  }
}

/** Never log or echo raw keys; only report whether they exist. */
export function maskPresent(enc: string | null | undefined): boolean {
  return Boolean(enc && enc.startsWith("v1:"));
}
