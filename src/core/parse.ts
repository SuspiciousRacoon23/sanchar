// Raw Meta webhook envelope → normalized InboundEvent[].
//
// House rule, same as the other external bridges: this NEVER throws. A webhook
// we cannot understand must still return 200 (or Meta retries it forever and
// eventually disables the subscription), so unparseable entries are dropped and
// unknown message types degrade to `unsupported` rather than blowing up.
//
// The envelope is deeply nested and every level is optional in practice:
//   body.entry[].changes[].value.{messages[],statuses[],contacts[],metadata}

import type { InboundEvent, InboundMessage, InboundStatus, MessageContent } from "./types.js";

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Meta sends epoch SECONDS as a string. Convert to ms; fall back to now. */
function toMs(v: unknown, now: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n) || n <= 0) return now;
  // Tolerate either unit — some tooling replays ms timestamps.
  return n > 1e11 ? Math.floor(n) : Math.floor(n * 1000);
}

function parseContent(msg: Record<string, unknown>): MessageContent {
  const type = str(msg.type) ?? "unknown";

  switch (type) {
    case "text": {
      const body = isObj(msg.text) ? str(msg.text.body) : undefined;
      return { type: "text", text: body ?? "" };
    }

    case "interactive": {
      const i = isObj(msg.interactive) ? msg.interactive : {};
      const kind = str(i.type);
      const node = kind === "list_reply" ? i.list_reply : kind === "button_reply" ? i.button_reply : undefined;
      if (isObj(node)) {
        return { type: "reply", replyId: str(node.id) ?? "", title: str(node.title) ?? "" };
      }
      return { type: "unsupported", note: `interactive:${kind ?? "unknown"}` };
    }

    // Quick-reply button on a template message — a different shape from
    // `interactive`, and a genuinely easy one to miss.
    case "button": {
      const b = isObj(msg.button) ? msg.button : {};
      return { type: "button", payload: str(b.payload) ?? "", text: str(b.text) ?? "" };
    }

    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker": {
      const m = isObj(msg[type]) ? (msg[type] as Record<string, unknown>) : {};
      return {
        type: "media",
        mediaType: type,
        mediaId: str(m.id) ?? "",
        mimeType: str(m.mime_type),
        caption: str(m.caption),
        filename: str(m.filename),
        voice: m.voice === true,
      };
    }

    case "location": {
      const l = isObj(msg.location) ? msg.location : {};
      const lat = typeof l.latitude === "number" ? l.latitude : Number(l.latitude);
      const lng = typeof l.longitude === "number" ? l.longitude : Number(l.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { type: "unsupported", note: "location:malformed" };
      }
      return { type: "location", latitude: lat, longitude: lng, name: str(l.name), address: str(l.address) };
    }

    case "reaction": {
      const r = isObj(msg.reaction) ? msg.reaction : {};
      return { type: "reaction", messageId: str(r.message_id) ?? "", emoji: str(r.emoji) };
    }

    // Meta's explicit "we could not deliver this to you" type — carries an
    // errors[] array explaining why (unsupported format, too large, etc.).
    case "unsupported": {
      const first = arr(msg.errors)[0];
      const title = isObj(first) ? str(first.title) : undefined;
      return { type: "unsupported", note: title ? `unsupported:${title}` : "unsupported" };
    }

    default:
      return { type: "unsupported", note: `type:${type}` };
  }
}

function parseStatus(s: Record<string, unknown>, now: number): InboundStatus | null {
  const id = str(s.id);
  const status = str(s.status);
  if (!id || !status) return null;
  if (status !== "sent" && status !== "delivered" && status !== "read" && status !== "failed") return null;

  const firstErr = arr(s.errors)[0];
  const errObj = isObj(firstErr) ? firstErr : undefined;

  return {
    kind: "status",
    id,
    status,
    recipient: str(s.recipient_id) ?? "",
    timestamp: toMs(s.timestamp, now),
    errorCode: errObj && typeof errObj.code === "number" ? errObj.code : undefined,
    errorTitle: errObj ? str(errObj.title) : undefined,
    raw: s,
  };
}

/**
 * Flatten a webhook body into normalized events.
 *
 * @param body parsed JSON (or anything — malformed input yields []).
 * @param now  injected for deterministic tests.
 */
export function parseWebhook(body: unknown, now: number = Date.now()): InboundEvent[] {
  const out: InboundEvent[] = [];
  if (!isObj(body)) return out;

  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;

    for (const change of arr(entry.changes)) {
      if (!isObj(change)) continue;
      // Ignore non-message subscriptions (account_update, template status
      // changes, quality alerts) — they arrive on the same webhook.
      if (str(change.field) !== "messages") continue;

      const value = isObj(change.value) ? change.value : {};
      const metadata = isObj(value.metadata) ? value.metadata : {};
      const phoneNumberId = str(metadata.phone_number_id) ?? "";

      // contacts[] carries the display name, correlated to messages by wa_id.
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        if (!isObj(c)) continue;
        const waId = str(c.wa_id);
        const profile = isObj(c.profile) ? str(c.profile.name) : undefined;
        if (waId && profile) names.set(waId, profile);
      }

      for (const m of arr(value.messages)) {
        if (!isObj(m)) continue;
        const id = str(m.id);
        const from = str(m.from);
        if (!id || !from) continue; // unusable without an idempotency key + sender

        const message: InboundMessage = {
          kind: "message",
          id,
          from,
          phoneNumberId,
          profileName: names.get(from),
          timestamp: toMs(m.timestamp, now),
          content: parseContent(m),
          raw: m,
        };
        out.push(message);
      }

      for (const s of arr(value.statuses)) {
        if (!isObj(s)) continue;
        const parsed = parseStatus(s, now);
        if (parsed) out.push(parsed);
      }
    }
  }

  return out;
}

/**
 * Reduce a message to the single string the state machine matches on.
 *
 * Button and list taps yield the flow-declared id (exact match); free text
 * yields the trimmed body. Media/location/reaction return null — the machine
 * treats that as "not an answer" and re-prompts, which is the correct
 * behaviour when someone photographs a form instead of filling it.
 */
export function userInput(content: MessageContent): string | null {
  switch (content.type) {
    case "text":
      return content.text.trim();
    case "reply":
      return content.replyId;
    case "button":
      return content.payload || content.text;
    default:
      return null;
  }
}
