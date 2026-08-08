// Transport-agnostic webhook logic, so the same code serves the standalone
// node server and a Next.js route handler without duplication.

import { parseWebhook } from "./core/parse.js";
import { verifyHandshake, verifySignature } from "./core/signature.js";
import type { Runtime } from "./runtime.js";

export type WebhookDeps = {
  runtime: Runtime;
  appSecret: string;
  verifyToken: string;
  /** When false (local/mock only), an unsigned body is accepted. */
  requireSignature: boolean;
  onError?: (e: Error) => void;
};

export type WebhookResponse = { status: number; body: string; contentType: string };

const text = (status: number, body: string): WebhookResponse => ({
  status,
  body,
  contentType: "text/plain",
});

/** GET — Meta's one-time subscription handshake. */
export function handleVerification(params: URLSearchParams, deps: WebhookDeps): WebhookResponse {
  const result = verifyHandshake(params, deps.verifyToken);
  return result.ok ? text(200, result.challenge) : text(result.status, "");
}

/**
 * POST — signature check, then ACK.
 *
 * The 200 goes out before the conversation is processed, on purpose. Meta
 * retries anything that is not a prompt 2xx and will disable a subscription
 * that keeps timing out, so the webhook's only job is: authenticate, persist
 * nothing slow, acknowledge. Processing continues on the returned promise.
 */
export function handleEvent(
  rawBody: string,
  signature: string | null,
  deps: WebhookDeps,
): { response: WebhookResponse; work: Promise<void> } {
  if (deps.requireSignature) {
    const check = verifySignature(rawBody, signature, deps.appSecret);
    if (!check.ok) {
      // 403, never 400: a rejected signature must not look like a malformed
      // payload Meta should retry.
      return { response: text(403, check.reason), work: Promise.resolve() };
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Acknowledge anyway. A body we cannot parse will never parse on retry,
    // and a retry storm is worse than a dropped malformed event.
    return { response: text(200, "EVENT_RECEIVED"), work: Promise.resolve() };
  }

  const events = parseWebhook(parsed);
  const work = (async () => {
    for (const event of events) {
      try {
        await deps.runtime.handle(event);
      } catch (e) {
        deps.onError?.(e as Error);
      }
    }
  })();

  return { response: text(200, "EVENT_RECEIVED"), work };
}
