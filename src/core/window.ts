// The 24-hour customer service window.
//
// WhatsApp policy: once a user messages you, you may reply free-form for 24
// hours. Outside that window, the ONLY thing that leaves the building is a
// pre-approved template. This is not a soft guideline — free-form sends outside
// the window are rejected by the Graph API, and repeatedly trying is a quality
// signal against the number.
//
// It is enforced here, in the send path, rather than trusted to callers. Every
// proactive notification a flow wants to send must therefore exist as an
// approved template *before* the build ships, which is exactly the constraint
// that should shape conversation design in week one.

import type { Reply } from "./types.js";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function windowOpen(lastInboundAt: number | null, now: number = Date.now()): boolean {
  if (!lastInboundAt) return false;
  return now - lastInboundAt < SERVICE_WINDOW_MS;
}

export function msRemaining(lastInboundAt: number | null, now: number = Date.now()): number {
  if (!lastInboundAt) return 0;
  return Math.max(0, SERVICE_WINDOW_MS - (now - lastInboundAt));
}

export type SendGate = { ok: true } | { ok: false; reason: "window_closed" };

/** Templates always pass; everything else needs an open window. */
export function gate(
  reply: Reply,
  lastInboundAt: number | null,
  now: number = Date.now(),
): SendGate {
  if (reply.type === "template") return { ok: true };
  return windowOpen(lastInboundAt, now) ? { ok: true } : { ok: false, reason: "window_closed" };
}
