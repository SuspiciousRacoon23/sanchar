// Webhook authenticity. Without this, anyone who learns the callback URL can
// POST forged citizen messages into the system — which for a government
// grievance bot means forged complaints in an audited record.
//
// Two independent checks, both required by Meta and both easy to get subtly
// wrong:
//   • GET  — the one-time subscription handshake (hub.verify_token/hub.challenge)
//   • POST — HMAC-SHA256 of the RAW body against the app secret
//
// The raw-body point is the classic bug: frameworks parse JSON and hand you an
// object, and `JSON.stringify(obj)` is NOT byte-identical to what Meta signed
// (key order, unicode escaping, whitespace). Always hash the bytes as received.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Constant-time compare that tolerates length mismatch (timingSafeEqual throws). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_header" | "malformed_header" | "mismatch" };

/**
 * Verify the `X-Hub-Signature-256` header against the raw request body.
 *
 * @param rawBody exact bytes/string as received — never a re-serialized object
 * @param header  value of X-Hub-Signature-256, e.g. "sha256=ab12…"
 * @param appSecret Meta App Secret
 */
export function verifySignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  appSecret: string,
): SignatureResult {
  if (!appSecret) return { ok: false, reason: "not_configured" };
  if (!header) return { ok: false, reason: "missing_header" };

  const [algo, received] = header.split("=", 2);
  if (algo !== "sha256" || !received) return { ok: false, reason: "malformed_header" };
  // Reject anything that is not lowercase hex before it reaches the comparison.
  if (!/^[0-9a-f]+$/.test(received)) return { ok: false, reason: "malformed_header" };

  const expected = createHmac("sha256", appSecret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody)
    .digest("hex");

  return safeEqual(expected, received) ? { ok: true } : { ok: false, reason: "mismatch" };
}

/** Produce the header Meta would send. Used by the mock harness and the tests. */
export function signBody(rawBody: string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

export type HandshakeResult = { ok: true; challenge: string } | { ok: false; status: 403 | 400 };

/**
 * The GET subscription handshake. Meta calls the callback URL once when you
 * save it in the console and expects the challenge echoed back as plain text.
 */
export function verifyHandshake(
  params: URLSearchParams,
  verifyToken: string,
): HandshakeResult {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) return { ok: false, status: 400 };
  if (!verifyToken || !token || !safeEqual(token, verifyToken)) return { ok: false, status: 403 };
  return { ok: true, challenge };
}
