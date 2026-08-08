// The glue: one inbound event in, persisted state and sent replies out.
//
// Ordering rule worth knowing: effects execute BEFORE the machine's replies are
// sent, and any replies an effect handler returns go out first. That is what
// lets a step that reads the database (a status lookup) answer in the same turn
// while the machine itself stays pure — the machine says "look this up", the
// handler produces the answer, and the machine's own closing line follows it.

import { randomBytes } from "node:crypto";
import type { Effect, InboundEvent, InboundMessage, MachineState, Reply } from "./core/types.js";
import { userInput } from "./core/parse.js";
import { advance, start, type Flow } from "./core/machine.js";
import { gate } from "./core/window.js";
import type { SendResult, WhatsAppClient } from "./core/client.js";
import { Store } from "./store.js";

export type EffectContext = { waId: string; store: Store; now: number };
export type EffectHandler = (
  effect: Extract<Effect, { type: "custom" }>,
  ctx: EffectContext,
) => Reply[] | Promise<Reply[]>;

export type RuntimeConfig = {
  flow: Flow;
  store: Store;
  client: WhatsAppClient;
  handlers?: Record<string, EffectHandler>;
  /** Session TTL. Defaults to 24h, matching the service window. */
  sessionTtlMs?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  refGen?: () => string;
};

// Ambiguity-free alphabet: no 0/O, no 1/I/L. Citizens read these aloud.
const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateRef(prefix = "GRV"): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  return `${prefix}-${out}`;
}

export type HandleResult = {
  /** false when the event was a duplicate, a receipt, or intentionally ignored. */
  processed: boolean;
  replies: Reply[];
  effects: Effect[];
  sends: SendResult[];
  note?: string;
};

const NOOP: HandleResult = { processed: false, replies: [], effects: [], sends: [] };

export class Runtime {
  private readonly flow: Flow;
  private readonly store: Store;
  private readonly client: WhatsAppClient;
  private readonly handlers: Record<string, EffectHandler>;
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly refGen: () => string;

  constructor(cfg: RuntimeConfig) {
    this.flow = cfg.flow;
    this.store = cfg.store;
    this.client = cfg.client;
    this.handlers = cfg.handlers ?? {};
    this.ttl = cfg.sessionTtlMs ?? Number(process.env.SANCHAR_SESSION_TTL_MS ?? 86_400_000);
    this.now = cfg.now ?? (() => Date.now());
    this.refGen = cfg.refGen ?? (() => generateRef());
  }

  async handle(event: InboundEvent): Promise<HandleResult> {
    if (event.kind === "status") {
      this.store.updateDelivery(event.id, event.status, event.errorTitle);
      return { ...NOOP, note: `receipt:${event.status}` };
    }
    return this.handleMessage(event);
  }

  private async handleMessage(msg: InboundMessage): Promise<HandleResult> {
    const now = this.now();

    // Idempotency before anything else — a redelivered webhook must be inert.
    if (!this.store.claim(msg.id, now)) {
      return { ...NOOP, note: "duplicate" };
    }
    this.store.logInbound(msg);

    const existing = this.store.get(msg.from);
    const input = userInput(msg.content);

    // A conversation a human has taken over: stay quiet. The bot talking over
    // an agent mid-thread is the single most common complaint about these
    // systems. Only an explicit restart hands control back.
    if (existing?.status === "handoff") {
      const resume = input?.trim().toLowerCase();
      if (resume !== "menu" && resume !== "start") {
        this.store.ensure(msg, existing.state, now);
        return { ...NOOP, note: "handoff_silent" };
      }
      this.store.setStatus(msg.from, "active", now);
    }

    const stale =
      !existing ||
      existing.status === "closed" ||
      (existing.lastInboundAt !== null && now - existing.lastInboundAt > this.ttl);

    // Fresh reference token for this turn. Flows read it as `data.ref`; tests
    // inject a fixed generator so transitions are byte-for-byte reproducible.
    const seeded = (data: Record<string, string>): Record<string, string> => ({
      ...data,
      ref: this.refGen(),
    });

    const base = { from: msg.from, profileName: msg.profileName ?? existing?.profileName ?? undefined };

    let transition;
    if (stale) {
      transition = start(this.flow, base, seeded({}));
      this.store.ensure(msg, transition.state, now);
    } else {
      const state: MachineState = { ...existing.state, data: seeded(existing.state.data) };
      this.store.ensure(msg, state, now);
      transition = advance(this.flow, state, input, base);
    }

    // Effects first, then their replies, then the machine's own.
    const effectReplies: Reply[] = [];
    for (const effect of transition.effects) {
      this.store.recordEffect(msg.from, effect, now);
      if (effect.type === "handoff") {
        this.store.setStatus(msg.from, "handoff", now);
        continue;
      }
      if (effect.type === "close") {
        this.store.setStatus(msg.from, "closed", now);
        continue;
      }
      const handler = this.handlers[effect.name];
      if (!handler) continue;
      try {
        effectReplies.push(...(await handler(effect, { waId: msg.from, store: this.store, now })));
      } catch (e) {
        // A failing handler must not swallow the conversation.
        effectReplies.push({
          type: "text",
          text: "Sorry — something went wrong on our side. Please try again, or type *agent*.",
        });
        this.store.recordEffect(
          msg.from,
          { type: "custom", name: "handler_error", payload: { effect: effect.name, message: (e as Error).message } },
          now,
        );
      }
    }

    this.store.saveState(msg.from, transition.state, now);

    const outgoing = [...effectReplies, ...transition.replies];
    const sends: SendResult[] = [];
    // We are replying to an inbound message, so the window is open by
    // definition — but the gate stays in the path so a proactive sender using
    // this same code cannot accidentally bypass it.
    const lastInbound = msg.timestamp;

    for (const reply of outgoing) {
      const allowed = gate(reply, lastInbound, now);
      if (!allowed.ok) {
        this.store.logOutbound(
          msg.from,
          reply,
          { ok: false, error: "window_closed", retryable: false },
          now,
        );
        continue;
      }
      const result = await this.client.send(msg.from, reply);
      this.store.logOutbound(msg.from, reply, result, now);
      sends.push(result);
    }

    if (sends.some((s) => s.ok)) this.store.touchOutbound(msg.from, now);
    if (transition.ended && this.store.get(msg.from)?.status === "active") {
      // Terminal step reached, but leave the row 'active': the next inbound
      // message restarts cleanly and the transcript stays on one thread.
    }

    return { processed: true, replies: outgoing, effects: transition.effects, sends };
  }
}

// ── Default effect handlers for the grievance flow ──────────────────

export const grievanceHandlers: Record<string, EffectHandler> = {
  create_ticket: (effect, ctx) => {
    const { ref, category, details, location } = effect.payload;
    ctx.store.createTicket(
      {
        id: ref ?? generateRef(),
        waId: ctx.waId,
        category: category ?? "other",
        details: details ?? "",
        location: location ?? "",
      },
      ctx.now,
    );
    return [];
  },

  lookup_ticket: (effect, ctx) => {
    const ref = effect.payload.ref ?? "";
    const ticket = ctx.store.getTicket(ref);
    if (!ticket) {
      return [
        {
          type: "text",
          text: `I couldn't find a complaint with reference *${ref}*. Please check the reference, or type *agent* for help.`,
        },
      ];
    }
    const filed = new Date(ticket.createdAt).toISOString().slice(0, 10);
    return [
      {
        type: "text",
        text: `*${ticket.id}*\nDepartment: ${ticket.category}\nStatus: *${ticket.status}*\nFiled: ${filed}`,
      },
    ];
  },
};
