// Graph API send client.
//
// Transport is injected, which is the whole point: the runtime is fully
// exercisable — flows, retries, audit log, the lot — against a mock transport
// while Meta Business Verification is still pending. Swapping in `fetch` at
// go-live changes one env var, not the code.
//
// House rule from the other bridges: never throw. Callers get a discriminated
// result and decide whether to retry, because "the message did not send" is a
// normal operating condition, not an exception.

import type { Reply } from "./types.js";
import { LIMITS } from "./machine.js";

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: string }>;

export type ClientConfig = {
  accessToken: string;
  phoneNumberId: string;
  graphVersion?: string;
  transport?: Transport;
};

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; status?: number; retryable: boolean };

const fetchTransport: Transport = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, text: await res.text() };
};

/** Truncate rather than let the Graph API 400 on a long dynamic string. */
function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Reply → Graph API message payload. Exported for tests and the mock harness. */
export function renderPayload(to: string, reply: Reply): Record<string, unknown> {
  const base = { messaging_product: "whatsapp", recipient_type: "individual", to };

  switch (reply.type) {
    case "text":
      return {
        ...base,
        type: "text",
        text: { body: clamp(reply.text, 4096), preview_url: reply.previewUrl ?? false },
      };

    case "buttons":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "button",
          ...(reply.header ? { header: { type: "text", text: clamp(reply.header, 60) } } : {}),
          body: { text: clamp(reply.text, LIMITS.bodyText) },
          ...(reply.footer ? { footer: { text: clamp(reply.footer, 60) } } : {}),
          action: {
            buttons: reply.buttons.slice(0, LIMITS.buttons).map((b) => ({
              type: "reply",
              reply: { id: b.id, title: clamp(b.title, LIMITS.buttonTitle) },
            })),
          },
        },
      };

    case "list":
      return {
        ...base,
        type: "interactive",
        interactive: {
          type: "list",
          ...(reply.header ? { header: { type: "text", text: clamp(reply.header, 60) } } : {}),
          body: { text: clamp(reply.text, LIMITS.bodyText) },
          ...(reply.footer ? { footer: { text: clamp(reply.footer, 60) } } : {}),
          action: {
            button: clamp(reply.button, LIMITS.buttonTitle),
            sections: [
              {
                title: "Options",
                rows: reply.rows.slice(0, LIMITS.listRows).map((r) => ({
                  id: r.id,
                  title: clamp(r.title, LIMITS.listRowTitle),
                  ...(r.description
                    ? { description: clamp(r.description, LIMITS.listRowDescription) }
                    : {}),
                })),
              },
            ],
          },
        },
      };

    case "template":
      return {
        ...base,
        type: "template",
        template: {
          name: reply.name,
          language: { code: reply.language },
          ...(reply.variables && reply.variables.length
            ? {
                components: [
                  {
                    type: "body",
                    parameters: reply.variables.map((v) => ({ type: "text", text: v })),
                  },
                ],
              }
            : {}),
        },
      };
  }
}

export class WhatsAppClient {
  private readonly token: string;
  private readonly phoneNumberId: string;
  private readonly version: string;
  private readonly transport: Transport;

  constructor(cfg: ClientConfig) {
    this.token = cfg.accessToken;
    this.phoneNumberId = cfg.phoneNumberId;
    this.version = cfg.graphVersion ?? "v21.0";
    this.transport = cfg.transport ?? fetchTransport;
  }

  private url(path: string): string {
    return `https://graph.facebook.com/${this.version}/${this.phoneNumberId}/${path}`;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<SendResult> {
    let res: { status: number; text: string };
    try {
      res = await this.transport(this.url(path), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Network-level failure — always worth another attempt.
      return { ok: false, error: (e as Error).message, retryable: true };
    }

    if (res.status >= 200 && res.status < 300) {
      try {
        const body = JSON.parse(res.text) as { messages?: Array<{ id?: string }> };
        const id = body.messages?.[0]?.id;
        if (id) return { ok: true, messageId: id };
      } catch {
        // 2xx with an unparseable body: it almost certainly went out, but we
        // have no wamid to correlate the delivery receipt against.
      }
      return { ok: true, messageId: "" };
    }

    // 5xx and 429 are transient; 4xx means the payload or token is wrong and
    // retrying just burns rate limit.
    const retryable = res.status >= 500 || res.status === 429;
    return { ok: false, error: res.text.slice(0, 500), status: res.status, retryable };
  }

  send(to: string, reply: Reply): Promise<SendResult> {
    return this.post("messages", renderPayload(to, reply));
  }

  /** Blue ticks. Cheap, and it visibly tells the user they were heard. */
  markRead(messageId: string): Promise<SendResult> {
    return this.post("messages", {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  }
}

/** Records everything, sends nothing. The default until Meta credentials land. */
export function mockTransport(log: Array<{ url: string; body: unknown }> = []): {
  transport: Transport;
  sent: Array<{ url: string; body: unknown }>;
} {
  let n = 0;
  const transport: Transport = async (url, init) => {
    log.push({ url, body: JSON.parse(init.body) });
    return {
      status: 200,
      text: JSON.stringify({ messages: [{ id: `wamid.MOCK${++n}` }] }),
    };
  };
  return { transport, sent: log };
}
