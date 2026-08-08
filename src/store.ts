// Persistence for conversations, the audit log, and idempotency.
//
// Everything here is synchronous — better-sqlite3 is, and for a webhook that
// must answer in milliseconds that is a feature, not a limitation.

import type { Database } from "better-sqlite3";
import { db as defaultDb } from "./db/client.js";
import type {
  ConversationStatus,
  Effect,
  InboundMessage,
  MachineState,
  Reply,
} from "./core/types.js";
import type { SendResult } from "./core/client.js";

export type Conversation = {
  waId: string;
  phoneNumberId: string;
  profileName: string | null;
  state: MachineState;
  status: ConversationStatus;
  assignedTo: string | null;
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  wa_id: string;
  phone_number_id: string;
  profile_name: string | null;
  flow_id: string;
  step_id: string;
  data: string;
  attempts: number;
  status: string;
  assigned_to: string | null;
  last_inbound_at: number | null;
  last_outbound_at: number | null;
  created_at: number;
  updated_at: number;
};

function hydrate(r: Row): Conversation {
  let data: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(r.data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, string>;
    }
  } catch {
    // Corrupt JSON must not strand the conversation — start it clean.
  }
  return {
    waId: r.wa_id,
    phoneNumberId: r.phone_number_id,
    profileName: r.profile_name,
    state: { flowId: r.flow_id, stepId: r.step_id, data, attempts: r.attempts },
    status: (["active", "handoff", "closed"] as const).includes(r.status as ConversationStatus)
      ? (r.status as ConversationStatus)
      : "active",
    assignedTo: r.assigned_to,
    lastInboundAt: r.last_inbound_at,
    lastOutboundAt: r.last_outbound_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Store {
  constructor(private readonly d: Database = defaultDb()) {}

  /**
   * Idempotency gate. Returns true exactly once per message id — the caller
   * proceeds only on true. Meta redelivers on any non-200 and sometimes
   * spontaneously; without this, a retry re-answers the same question.
   */
  claim(messageId: string, now: number = Date.now()): boolean {
    const res = this.d
      .prepare("INSERT OR IGNORE INTO processed (id, created_at) VALUES (?, ?)")
      .run(messageId, now);
    return res.changes > 0;
  }

  get(waId: string): Conversation | null {
    const row = this.d.prepare("SELECT * FROM conversations WHERE wa_id = ?").get(waId) as
      | Row
      | undefined;
    return row ? hydrate(row) : null;
  }

  /** Create the conversation row if this is a first contact. */
  ensure(msg: InboundMessage, state: MachineState, now: number = Date.now()): Conversation {
    this.d
      .prepare(
        `INSERT INTO conversations
           (wa_id, phone_number_id, profile_name, flow_id, step_id, data, attempts,
            status, last_inbound_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT(wa_id) DO UPDATE SET
           phone_number_id = excluded.phone_number_id,
           profile_name    = COALESCE(excluded.profile_name, conversations.profile_name),
           last_inbound_at = excluded.last_inbound_at,
           updated_at      = excluded.updated_at`,
      )
      .run(
        msg.from,
        msg.phoneNumberId,
        msg.profileName ?? null,
        state.flowId,
        state.stepId,
        JSON.stringify(state.data),
        state.attempts,
        msg.timestamp,
        now,
        now,
      );
    return this.get(msg.from)!;
  }

  saveState(waId: string, state: MachineState, now: number = Date.now()): void {
    this.d
      .prepare(
        `UPDATE conversations
            SET flow_id = ?, step_id = ?, data = ?, attempts = ?, updated_at = ?
          WHERE wa_id = ?`,
      )
      .run(state.flowId, state.stepId, JSON.stringify(state.data), state.attempts, now, waId);
  }

  setStatus(waId: string, status: ConversationStatus, now: number = Date.now()): void {
    this.d
      .prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE wa_id = ?")
      .run(status, now, waId);
  }

  touchOutbound(waId: string, now: number = Date.now()): void {
    this.d
      .prepare("UPDATE conversations SET last_outbound_at = ?, updated_at = ? WHERE wa_id = ?")
      .run(now, now, waId);
  }

  // ── Audit log ─────────────────────────────────────────────────────

  logInbound(msg: InboundMessage): void {
    const body =
      msg.content.type === "text"
        ? msg.content.text
        : msg.content.type === "reply"
          ? `[${msg.content.replyId}] ${msg.content.title}`
          : msg.content.type === "button"
            ? `[${msg.content.payload}] ${msg.content.text}`
            : msg.content.type === "media"
              ? `<${msg.content.mediaType}:${msg.content.mediaId}>`
              : msg.content.type === "location"
                ? `<location ${msg.content.latitude},${msg.content.longitude}>`
                : msg.content.type === "reaction"
                  ? `<reaction ${msg.content.emoji ?? ""}>`
                  : `<${msg.content.note}>`;

    this.d
      .prepare(
        `INSERT OR IGNORE INTO messages (id, wamid, wa_id, direction, type, body, raw, created_at)
         VALUES (?, ?, ?, 'in', ?, ?, ?, ?)`,
      )
      .run(msg.id, msg.id, msg.from, msg.content.type, body, JSON.stringify(msg.raw), msg.timestamp);
  }

  logOutbound(waId: string, reply: Reply, result: SendResult, now: number = Date.now()): void {
    const body =
      reply.type === "text"
        ? reply.text
        : reply.type === "template"
          ? `<template ${reply.name}>`
          : reply.text;

    this.d
      .prepare(
        `INSERT INTO messages (id, wamid, wa_id, direction, type, body, raw, status, error, created_at)
         VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.nextOutboundId(waId, now),
        result.ok && result.messageId ? result.messageId : null,
        waId,
        reply.type,
        body,
        JSON.stringify(reply),
        result.ok ? "sent" : "failed",
        result.ok ? null : result.error,
        now,
      );
  }

  /** Monotonic within a process, unique across processes. Never collides, so
   *  no outbound audit row is ever silently discarded. */
  private outboundSeq = 0;
  private nextOutboundId(waId: string, now: number): string {
    return `out.${waId}.${now}.${process.pid}.${++this.outboundSeq}`;
  }

  /** Delivery receipt for something we sent. Correlates on the Meta id. */
  updateDelivery(messageId: string, status: string, error?: string): void {
    this.d
      .prepare("UPDATE messages SET status = ?, error = COALESCE(?, error) WHERE wamid = ?")
      .run(status, error ?? null, messageId);
  }

  /**
   * The conversation in the order it actually happened.
   *
   * Ordered by insertion sequence, NOT by created_at. Inbound rows carry Meta's
   * timestamp, which has one-second granularity; outbound rows carry
   * millisecond server time. Sorting by time therefore lets the next turn's
   * inbound message (…221000) sort ahead of the previous turn's reply
   * (…221162), and the transcript reads as though the bot answered a question
   * it had not been asked yet. For a record that has to stand up in a
   * grievance audit, observed order is the only defensible order.
   */
  transcript(
    waId: string,
    limit = 100,
  ): Array<{ seq: number; direction: string; body: string; createdAt: number }> {
    return this.d
      .prepare(
        `SELECT rowid AS seq, direction, body, created_at AS createdAt
           FROM messages WHERE wa_id = ? ORDER BY rowid ASC LIMIT ?`,
      )
      .all(waId, limit) as Array<{ seq: number; direction: string; body: string; createdAt: number }>;
  }

  // ── Effects ───────────────────────────────────────────────────────

  recordEffect(waId: string, effect: Effect, now: number = Date.now()): void {
    const name = effect.type === "custom" ? effect.name : effect.type;
    const payload =
      effect.type === "custom"
        ? effect.payload
        : effect.type === "handoff"
          ? { reason: effect.reason }
          : {};
    this.d
      .prepare("INSERT INTO effects (wa_id, name, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(waId, name, JSON.stringify(payload), now);
  }

  openEffects(limit = 50): Array<{ id: number; waId: string; name: string; payload: string; createdAt: number }> {
    return this.d
      .prepare(
        `SELECT id, wa_id AS waId, name, payload, created_at AS createdAt
           FROM effects WHERE resolved_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      )
      .all(limit) as Array<{ id: number; waId: string; name: string; payload: string; createdAt: number }>;
  }

  // ── Worked example: grievance tickets ─────────────────────────────

  createTicket(
    t: { id: string; waId: string; category: string; details: string; location?: string },
    now: number = Date.now(),
  ): void {
    this.d
      .prepare(
        `INSERT OR IGNORE INTO tickets (id, wa_id, category, details, location, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.waId, t.category, t.details, t.location ?? null, now);
  }

  getTicket(id: string): { id: string; category: string; status: string; createdAt: number } | null {
    const row = this.d
      .prepare("SELECT id, category, status, created_at AS createdAt FROM tickets WHERE id = ?")
      .get(id) as { id: string; category: string; status: string; createdAt: number } | undefined;
    return row ?? null;
  }
}
