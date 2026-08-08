// Domain types for the WhatsApp Cloud API runtime.
//
// Two layers live here on purpose:
//   1. The *raw* Meta webhook envelope, typed loosely (`unknown` at the leaves).
//      Meta adds message types without warning; anything that assumes a shape
//      will throw in production the first time a user sends a sticker reaction.
//   2. The *normalized* domain events the rest of the system speaks. Nothing
//      outside parse.ts should ever touch the raw envelope.

// ── Raw envelope (parse defensively; never trust these) ─────────────
export type RawWebhook = {
  object?: unknown;
  entry?: unknown;
};

// ── Normalized inbound ──────────────────────────────────────────────

/** What the user actually sent, reduced to the shapes we can act on. */
export type MessageContent =
  | { type: "text"; text: string }
  /** Tap on an interactive button or list row. `replyId` is OUR id — the one
   *  the flow declared — which is why choice matching is exact, not fuzzy. */
  | { type: "reply"; replyId: string; title: string }
  /** Quick-reply button attached to a template message. */
  | { type: "button"; payload: string; text: string }
  | {
      type: "media";
      mediaType: "image" | "audio" | "video" | "document" | "sticker";
      mediaId: string;
      mimeType?: string;
      caption?: string;
      filename?: string;
      /** Voice notes arrive as audio with voice=true. Worth distinguishing:
       *  a citizen sending a voice note usually cannot type. */
      voice?: boolean;
    }
  | { type: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | { type: "reaction"; messageId: string; emoji?: string }
  /** Anything Meta sends that we do not model. Kept so the audit log is
   *  complete and the user still gets a coherent reply. */
  | { type: "unsupported"; note: string };

export type InboundMessage = {
  kind: "message";
  /** wamid — globally unique, and our idempotency key. Meta WILL redeliver. */
  id: string;
  /** Sender's wa_id (E.164 without '+', e.g. 919820012345). */
  from: string;
  /** Which of our numbers received it — multi-number deployments need this. */
  phoneNumberId: string;
  profileName?: string;
  /** Epoch ms (Meta sends epoch seconds as a string). */
  timestamp: number;
  content: MessageContent;
  raw: unknown;
};

/** Delivery receipts for messages WE sent. Drives the audit log and the
 *  quality-rating early-warning signal. */
export type InboundStatus = {
  kind: "status";
  /** wamid of the outbound message this refers to. */
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  recipient: string;
  timestamp: number;
  errorCode?: number;
  errorTitle?: string;
  raw: unknown;
};

export type InboundEvent = InboundMessage | InboundStatus;

// ── Outbound replies ────────────────────────────────────────────────
// Declarative. Flows describe what to say; client.ts renders it to the
// Graph API payload and enforces Meta's length/count limits.

export type ReplyButton = { id: string; title: string };
export type ReplyRow = { id: string; title: string; description?: string };

export type Reply =
  | { type: "text"; text: string; previewUrl?: boolean }
  | { type: "buttons"; text: string; buttons: ReplyButton[]; header?: string; footer?: string }
  | { type: "list"; text: string; button: string; rows: ReplyRow[]; header?: string; footer?: string }
  /** The only thing sendable outside the 24-hour service window. */
  | { type: "template"; name: string; language: string; variables?: string[] };

// ── Effects ─────────────────────────────────────────────────────────
// The state machine is pure: it never writes a ticket or pages a human, it
// *emits* the intent. The runtime executes them. That is what makes the
// whole conversation layer replayable in tests.

export type Effect =
  | { type: "handoff"; reason: string }
  | { type: "close" }
  | { type: "custom"; name: string; payload: Record<string, string> };

// ── Conversation state ──────────────────────────────────────────────

export type ConversationStatus = "active" | "handoff" | "closed";

export type MachineState = {
  flowId: string;
  stepId: string;
  /** Everything collected so far, keyed by the step's `key`. */
  data: Record<string, string>;
  /** Consecutive validation failures at the current step. */
  attempts: number;
};

export type Ctx = {
  from: string;
  profileName?: string;
  data: Record<string, string>;
};
