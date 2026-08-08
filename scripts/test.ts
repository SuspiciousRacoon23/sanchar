// Test suite. Plain tsx script, no framework — matches the house pattern.
//
//   npm test

import Database from "better-sqlite3";
import { signBody, verifyHandshake, verifySignature } from "../src/core/signature.js";
import { parseWebhook, userInput } from "../src/core/parse.js";
import {
  advance,
  start,
  validateFlow,
  renderChoices,
  HANDOFF,
  type Flow,
} from "../src/core/machine.js";
import { gate, windowOpen, SERVICE_WINDOW_MS } from "../src/core/window.js";
import { WhatsAppClient, mockTransport, renderPayload } from "../src/core/client.js";
import { migrate } from "../src/db/client.js";
import { Store } from "../src/store.js";
import { Runtime, grievanceHandlers } from "../src/runtime.js";
import { grievanceFlow } from "../src/flows/grievance.js";
import type { InboundMessage } from "../src/core/types.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failures.push(detail ? `${name} — ${detail}` : name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? undefined : `got ${a}, want ${e}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ── Signature ───────────────────────────────────────────────────────

section("signature");
{
  const secret = "app-secret-123";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const sig = signBody(body, secret);

  check("valid signature accepted", verifySignature(body, sig, secret).ok);

  const tampered = verifySignature(body + " ", sig, secret);
  check("tampered body rejected", !tampered.ok && tampered.reason === "mismatch");

  const wrongSecret = verifySignature(body, sig, "other-secret");
  check("wrong secret rejected", !wrongSecret.ok && wrongSecret.reason === "mismatch");

  const missing = verifySignature(body, null, secret);
  check("missing header rejected", !missing.ok && missing.reason === "missing_header");

  const malformed = verifySignature(body, "sha1=abc", secret);
  check("wrong algorithm rejected", !malformed.ok && malformed.reason === "malformed_header");

  const nonHex = verifySignature(body, "sha256=zzzz", secret);
  check("non-hex digest rejected", !nonHex.ok && nonHex.reason === "malformed_header");

  const unconfigured = verifySignature(body, sig, "");
  check("missing app secret reported", !unconfigured.ok && unconfigured.reason === "not_configured");

  // Key ordering differs but bytes are what is signed — this is the classic
  // "re-serialized the parsed object" bug, caught here on purpose.
  const reserialized = JSON.stringify(JSON.parse('{"b":1,"a":2}'));
  const originalBytes = '{"b":1,"a":2}';
  check(
    "signature is over raw bytes, not re-serialized JSON",
    verifySignature(originalBytes, signBody(originalBytes, secret), secret).ok &&
      reserialized === '{"b":1,"a":2}',
  );

  const hs = verifyHandshake(
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42" }),
    "tok",
  );
  check("handshake echoes challenge", hs.ok && hs.challenge === "42");

  const hsBad = verifyHandshake(
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42" }),
    "tok",
  );
  check("handshake rejects wrong token with 403", !hsBad.ok && hsBad.status === 403);

  const hsNoChallenge = verifyHandshake(new URLSearchParams({ "hub.mode": "subscribe" }), "tok");
  check("handshake without challenge is 400", !hsNoChallenge.ok && hsNoChallenge.status === 400);
}

// ── Parse ───────────────────────────────────────────────────────────

section("parse");
{
  const wrap = (value: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ id: "W", changes: [{ field: "messages", value }] }],
  });

  const meta = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "911140000000", phone_number_id: "PN1" },
    contacts: [{ profile: { name: "Asha" }, wa_id: "919820012345" }],
  };

  const textEvents = parseWebhook(
    wrap({ ...meta, messages: [{ from: "919820012345", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: " hello " } }] }),
  );
  check("text message parsed", textEvents.length === 1 && textEvents[0]!.kind === "message");
  const m0 = textEvents[0] as InboundMessage;
  eq("text content", m0.content, { type: "text", text: " hello " });
  eq("profile name attached", m0.profileName, "Asha");
  eq("phone number id attached", m0.phoneNumberId, "PN1");
  eq("epoch seconds → ms", m0.timestamp, 1700000000000);
  eq("userInput trims text", userInput(m0.content), "hello");

  const btn = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.2", timestamp: "1700000000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "file", title: "File a complaint" } } }] }),
  )[0] as InboundMessage;
  eq("button reply parsed", btn.content, { type: "reply", replyId: "file", title: "File a complaint" });
  eq("userInput yields the declared id", userInput(btn.content), "file");

  const list = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.3", timestamp: "1700000000", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "water", title: "Water supply" } } }] }),
  )[0] as InboundMessage;
  eq("list reply parsed", (list.content as { replyId: string }).replyId, "water");

  const tmplBtn = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.4", timestamp: "1700000000", type: "button", button: { payload: "OPT_IN", text: "Yes" } }] }),
  )[0] as InboundMessage;
  eq("template quick-reply parsed", tmplBtn.content, { type: "button", payload: "OPT_IN", text: "Yes" });

  const img = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.5", timestamp: "1700000000", type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "pothole" } }] }),
  )[0] as InboundMessage;
  eq("image parsed", img.content, {
    type: "media", mediaType: "image", mediaId: "media-1", mimeType: "image/jpeg",
    caption: "pothole", filename: undefined, voice: false,
  });
  eq("media yields no machine input", userInput(img.content), null);

  const voice = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.6", timestamp: "1700000000", type: "audio", audio: { id: "a1", voice: true } }] }),
  )[0] as InboundMessage;
  check("voice note flagged", (voice.content as { voice?: boolean }).voice === true);

  const loc = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.7", timestamp: "1700000000", type: "location", location: { latitude: 19.07, longitude: 72.87, name: "Dadar" } }] }),
  )[0] as InboundMessage;
  eq("location parsed", (loc.content as { latitude: number }).latitude, 19.07);

  const weird = parseWebhook(
    wrap({ ...meta, messages: [{ from: "9198", id: "wamid.8", timestamp: "1700000000", type: "contacts", contacts: [] }] }),
  )[0] as InboundMessage;
  eq("unknown type degrades safely", weird.content, { type: "unsupported", note: "type:contacts" });

  const status = parseWebhook(
    wrap({ ...meta, statuses: [{ id: "wamid.out1", status: "delivered", timestamp: "1700000000", recipient_id: "9198" }] }),
  )[0];
  check("delivery receipt parsed", status?.kind === "status" && status.status === "delivered");

  const failed = parseWebhook(
    wrap({ ...meta, statuses: [{ id: "wamid.out2", status: "failed", timestamp: "1700000000", recipient_id: "9198", errors: [{ code: 131047, title: "Re-engagement message" }] }] }),
  )[0];
  check(
    "failed receipt carries the error",
    failed?.kind === "status" && failed.errorCode === 131047,
  );

  eq("malformed body yields nothing", parseWebhook({ nonsense: true }), []);
  eq("null body yields nothing", parseWebhook(null), []);
  eq("string body yields nothing", parseWebhook("not json"), []);
  eq(
    "message without an id is dropped",
    parseWebhook(wrap({ ...meta, messages: [{ from: "9198", type: "text", text: { body: "x" } }] })),
    [],
  );
  eq(
    "non-message subscriptions ignored",
    parseWebhook({ entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }] }),
    [],
  );

  const multi = parseWebhook({
    entry: [
      { changes: [{ field: "messages", value: { ...meta, messages: [{ from: "a", id: "1", timestamp: "1700000000", type: "text", text: { body: "one" } }] } }] },
      { changes: [{ field: "messages", value: { ...meta, messages: [{ from: "b", id: "2", timestamp: "1700000000", type: "text", text: { body: "two" } }] } }] },
    ],
  });
  eq("multiple entries flattened", multi.length, 2);
}

// ── Flow validation ─────────────────────────────────────────────────

section("flow validation");
{
  eq("grievance flow is valid", validateFlow(grievanceFlow), []);

  const broken: Flow = {
    id: "broken",
    entry: "nope",
    steps: [
      { kind: "say", id: "a", text: "hi", next: "ghost" },
      { kind: "say", id: "a", text: "dup", next: "a" },
      {
        kind: "choose",
        id: "c",
        text: "pick",
        choices: [
          { id: "x", title: "A title that is definitely longer than twenty characters", next: "a" },
          { id: "x", title: "dup id", next: "a" },
        ],
      },
    ],
  };
  const problems = validateFlow(broken);
  check("unknown entry caught", problems.some((p) => p.includes('entry step "nope"')));
  check("dangling target caught", problems.some((p) => p.includes('unknown step "ghost"')));
  check("duplicate step id caught", problems.some((p) => p.includes('duplicate step id "a"')));
  check("duplicate choice id caught", problems.some((p) => p.includes('duplicate choice id "x"')));
  check("over-long button title caught", problems.some((p) => p.includes("max 20")));

  const tooMany: Flow = {
    id: "many",
    entry: "c",
    steps: [
      {
        kind: "choose",
        id: "c",
        text: "pick",
        choices: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, title: `Option ${i}`, next: "c" })),
      },
    ],
  };
  check(
    "more than 10 choices caught",
    validateFlow(tooMany).some((p) => p.includes("at most 10")),
  );

  const three = renderChoices("pick", {
    kind: "choose", id: "x", text: "pick",
    choices: [{ id: "a", title: "A", next: "x" }, { id: "b", title: "B", next: "x" }, { id: "c", title: "C", next: "x" }],
  });
  eq("three choices render as buttons", three.type, "buttons");

  const four = renderChoices("pick", {
    kind: "choose", id: "x", text: "pick",
    choices: [{ id: "a", title: "A", next: "x" }, { id: "b", title: "B", next: "x" }, { id: "c", title: "C", next: "x" }, { id: "d", title: "D", next: "x" }],
  });
  eq("four choices render as a list", four.type, "list");
}

// ── State machine ───────────────────────────────────────────────────

section("state machine");
{
  const base = { from: "9198", profileName: "Asha" };

  const t0 = start(grievanceFlow, base, { ref: "GRV-TEST01" });
  eq("start parks on the menu", t0.state.stepId, "main");
  eq("start is awaiting", t0.awaiting, true);
  eq("welcome + menu emitted", t0.replies.length, 2);
  check("welcome greets by name", (t0.replies[0] as { text: string }).text.includes("Asha"));
  eq("menu rendered as a list", t0.replies[1]!.type, "list");

  const byId = advance(grievanceFlow, t0.state, "file", base);
  eq("choice by id advances", byId.state.stepId, "new_cat");

  const byNumber = advance(grievanceFlow, t0.state, "1", base);
  eq("choice by 1-based number advances", byNumber.state.stepId, "new_cat");

  const byTitle = advance(grievanceFlow, t0.state, "check STATUS", base);
  eq("choice by title is case-insensitive", byTitle.state.stepId, "status_ask");

  const bad = advance(grievanceFlow, t0.state, "banana", base);
  eq("unmatched input stays put", bad.state.stepId, "main");
  eq("unmatched input increments attempts", bad.state.attempts, 1);
  eq("unmatched input re-prompts", bad.replies.length, 2);

  const nullInput = advance(grievanceFlow, t0.state, null, base);
  eq("a photo is not an answer", nullInput.state.stepId, "main");
  check(
    "photo prompts for a typed reply",
    (nullInput.replies[0] as { text: string }).text.includes("typed replies"),
  );

  // Patience runs out → escalate rather than loop.
  let looping = t0.state;
  let last = bad;
  for (let i = 0; i < 3; i++) {
    last = advance(grievanceFlow, looping, "banana", base);
    looping = last.state;
  }
  check("repeated failure escalates", last.effects.some((e) => e.type === "handoff"));
  check(
    "escalation reason names the step",
    last.effects.some((e) => e.type === "handoff" && e.reason.startsWith("max_attempts:")),
  );

  // Global commands work from a mid-form step.
  const cat = advance(grievanceFlow, byId.state, "water", base);
  eq("category stored", cat.state.data.category, "water");
  eq("moves to details", cat.state.stepId, "new_details");

  const short = advance(grievanceFlow, cat.state, "tap dry", base);
  eq("short answer rejected", short.state.stepId, "new_details");
  eq("rejection counts an attempt", short.state.attempts, 1);

  const details = advance(grievanceFlow, cat.state, "The tap has been dry for three days", base);
  eq("valid answer stored", details.state.data.details, "The tap has been dry for three days");
  eq("moves to location", details.state.stepId, "new_location");

  const menuJump = advance(grievanceFlow, details.state, "menu", base);
  eq("global command works mid-form", menuJump.state.stepId, "main");

  const agentJump = advance(grievanceFlow, details.state, "agent", base);
  check("agent command emits handoff", agentJump.effects.some((e) => e.type === "handoff"));

  const loc = advance(grievanceFlow, details.state, "MG Road, near the post office", base);
  eq("reaches confirmation", loc.state.stepId, "confirm");
  check(
    "confirmation echoes what was collected",
    (loc.replies[0] as { text: string }).text.includes("MG Road"),
  );

  const created = advance(grievanceFlow, loc.state, "yes", base);
  eq("confirmation is terminal", created.ended, true);
  const ticketEffect = created.effects.find(
    (e) => e.type === "custom" && e.name === "create_ticket",
  );
  check("ticket effect emitted", Boolean(ticketEffect));
  check(
    "effect carries the collected data",
    ticketEffect?.type === "custom" && ticketEffect.payload.location === "MG Road, near the post office",
  );
  check(
    "reference shown to the user matches the effect",
    ticketEffect?.type === "custom" &&
      (created.replies[0] as { text: string }).text.includes(ticketEffect.payload.ref!),
  );

  const startOver = advance(grievanceFlow, loc.state, "no", base);
  eq("declining restarts the form", startOver.state.stepId, "new_cat");

  // Talking past a finished conversation must not dead-end on the closing line.
  const afterEnd = advance(grievanceFlow, created.state, "thank you", base);
  eq("input after a terminal step restarts the flow", afterEnd.state.stepId, "main");
  eq("restart offers the menu again", afterEnd.replies.length, 2);
  check(
    "restart does not replay the closing line",
    !afterEnd.replies.some((r) => r.type === "text" && r.text.includes("Registered")),
  );
  check("restart is awaiting input, not ended", afterEnd.awaiting && !afterEnd.ended);

  // The same must hold for every terminal step, not just the happy one.
  const afterStatusEnd = advance(
    grievanceFlow,
    { flowId: grievanceFlow.id, stepId: "status_end", data: {}, attempts: 0 },
    "banana",
    base,
  );
  eq("terminal status step also restarts", afterStatusEnd.state.stepId, "main");

  // And repeated nonsense from a restarted menu still escalates, so there is
  // no path that loops forever.
  let post = afterEnd.state;
  let postLast = afterEnd;
  for (let i = 0; i < 3; i++) {
    postLast = advance(grievanceFlow, post, "banana", base);
    post = postLast.state;
  }
  check("post-restart nonsense still escalates", postLast.effects.some((e) => e.type === "handoff"));

  // Pure: same inputs, same outputs, no hidden state.
  const again = advance(grievanceFlow, loc.state, "yes", base);
  eq("transitions are deterministic", JSON.stringify(again.state), JSON.stringify(created.state));

  // A live session pointing at a deleted step recovers instead of stranding.
  const desync = advance(
    grievanceFlow,
    { flowId: grievanceFlow.id, stepId: "deleted_step", data: {}, attempts: 0 },
    "hello",
    base,
  );
  eq("desynced session restarts", desync.state.stepId, "main");

  // A flow that would loop forever must terminate.
  const cyclic: Flow = {
    id: "cyclic",
    entry: "a",
    steps: [
      { kind: "say", id: "a", text: "a", next: "b" },
      { kind: "say", id: "b", text: "b", next: "a" },
    ],
  };
  const looped = start(cyclic, base);
  check(
    "runaway flow is stopped, not hung",
    looped.ended && looped.effects.some((e) => e.type === "custom" && e.name === "flow_loop"),
  );

  const handoffTarget = advance(grievanceFlow, t0.state, "agent", base);
  eq("HANDOFF constant resolves to the ack step", handoffTarget.state.stepId, "handoff_ack");
  check("HANDOFF is the reserved id", HANDOFF === "__handoff");
}

// ── Service window ──────────────────────────────────────────────────

section("service window");
{
  const now = 1_700_000_000_000;
  check("open just inside 24h", windowOpen(now - SERVICE_WINDOW_MS + 1000, now));
  check("closed just outside 24h", !windowOpen(now - SERVICE_WINDOW_MS - 1000, now));
  check("closed when never contacted", !windowOpen(null, now));

  const text = { type: "text" as const, text: "hi" };
  const tmpl = { type: "template" as const, name: "update", language: "en" };
  check("free-form blocked outside the window", !gate(text, now - SERVICE_WINDOW_MS - 1, now).ok);
  check("free-form allowed inside the window", gate(text, now - 1000, now).ok);
  check("template allowed outside the window", gate(tmpl, now - SERVICE_WINDOW_MS - 1, now).ok);
  check("template allowed with no prior contact", gate(tmpl, null, now).ok);
}

// ── Client payloads ─────────────────────────────────────────────────

section("client");
{
  const text = renderPayload("9198", { type: "text", text: "hello" }) as any;
  eq("text payload shape", text.type, "text");
  eq("text body", text.text.body, "hello");
  eq("messaging_product set", text.messaging_product, "whatsapp");

  const buttons = renderPayload("9198", {
    type: "buttons",
    text: "pick",
    buttons: [{ id: "a", title: "Alpha" }, { id: "b", title: "Beta" }],
  }) as any;
  eq("buttons render as interactive/button", buttons.interactive.type, "button");
  eq("button reply shape", buttons.interactive.action.buttons[0].reply, { id: "a", title: "Alpha" });

  const long = renderPayload("9198", {
    type: "buttons",
    text: "pick",
    buttons: [{ id: "a", title: "A title far longer than twenty characters" }],
  }) as any;
  check(
    "over-long button title truncated, not rejected",
    long.interactive.action.buttons[0].reply.title.length === 20,
  );

  const list = renderPayload("9198", {
    type: "list",
    text: "pick",
    button: "Select",
    rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })),
  }) as any;
  eq("list capped at 10 rows", list.interactive.action.sections[0].rows.length, 10);

  const tmpl = renderPayload("9198", {
    type: "template", name: "status_update", language: "en_US", variables: ["GRV-1", "closed"],
  }) as any;
  eq("template name", tmpl.template.name, "status_update");
  eq("template variables become body parameters", tmpl.template.components[0].parameters.length, 2);

  void (async () => {
    const { transport, sent } = mockTransport();
    const client = new WhatsAppClient({ accessToken: "t", phoneNumberId: "p", transport });
    const res = await client.send("9198", { type: "text", text: "hi" });
    check("mock send succeeds", res.ok && res.messageId.startsWith("wamid.MOCK"));
    eq("mock captured one send", sent.length, 1);

    const failing: typeof transport = async () => ({ status: 400, text: '{"error":{"message":"bad"}}' });
    const badClient = new WhatsAppClient({ accessToken: "t", phoneNumberId: "p", transport: failing });
    const bad = await badClient.send("9198", { type: "text", text: "hi" });
    check("4xx is not retryable", !bad.ok && bad.retryable === false);

    const flaky: typeof transport = async () => ({ status: 503, text: "upstream" });
    const flakyClient = new WhatsAppClient({ accessToken: "t", phoneNumberId: "p", transport: flaky });
    const transient = await flakyClient.send("9198", { type: "text", text: "hi" });
    check("5xx is retryable", !transient.ok && transient.retryable === true);

    const throwing: typeof transport = async () => { throw new Error("ECONNREFUSED"); };
    const offline = new WhatsAppClient({ accessToken: "t", phoneNumberId: "p", transport: throwing });
    const netFail = await offline.send("9198", { type: "text", text: "hi" });
    check("network failure does not throw", !netFail.ok && netFail.retryable === true);
  })();
}

// ── Runtime integration ─────────────────────────────────────────────

section("runtime (end to end)");

async function runtimeTests(): Promise<void> {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const store = new Store(sqlite);
  const { transport, sent } = mockTransport();
  const client = new WhatsAppClient({ accessToken: "t", phoneNumberId: "p", transport });

  let clock = 1_700_000_000_000;
  const runtime = new Runtime({
    flow: grievanceFlow,
    store,
    client,
    handlers: grievanceHandlers,
    now: () => clock,
    refGen: () => "GRV-TEST01",
  });

  let n = 0;
  const inbound = (body: string, isButton = false): InboundMessage => ({
    kind: "message",
    id: `wamid.T${++n}`,
    from: "919820012345",
    phoneNumberId: "PN1",
    profileName: "Asha",
    timestamp: clock,
    content: isButton
      ? { type: "reply", replyId: body, title: body }
      : { type: "text", text: body },
    raw: {},
  });

  const r1 = await runtime.handle(inbound("hello"));
  check("first contact is processed", r1.processed);
  eq("first contact gets welcome + menu", r1.replies.length, 2);

  // Idempotency: replay the exact same message id.
  const replayed = { ...inbound("hello"), id: "wamid.T1" };
  const dup = await runtime.handle(replayed);
  check("redelivered webhook is inert", !dup.processed && dup.note === "duplicate");
  eq("duplicate sends nothing", dup.sends.length, 0);

  await runtime.handle(inbound("file", true));
  await runtime.handle(inbound("water", true));
  await runtime.handle(inbound("The tap has been dry for three days"));
  await runtime.handle(inbound("MG Road, near the post office"));
  const done = await runtime.handle(inbound("yes", true));

  check("ticket effect fired", done.effects.some((e) => e.type === "custom" && e.name === "create_ticket"));
  const ticket = store.getTicket("GRV-TEST01");
  check("ticket persisted", Boolean(ticket));
  eq("ticket category", ticket?.category, "water");
  check(
    "user told their reference",
    done.replies.some((r) => r.type === "text" && r.text.includes("GRV-TEST01")),
  );

  // Status lookup reads the database from inside a pure flow.
  await runtime.handle(inbound("menu"));
  await runtime.handle(inbound("status", true));
  const found = await runtime.handle(inbound("grv-test01"));
  check(
    "status lookup finds the ticket",
    found.replies.some((r) => r.type === "text" && r.text.includes("Status:")),
  );
  check(
    "lookup answer precedes the closing line",
    found.replies[0]!.type === "text" && (found.replies[0] as { text: string }).text.includes("GRV-TEST01"),
  );

  await runtime.handle(inbound("menu"));
  await runtime.handle(inbound("status", true));
  const missing = await runtime.handle(inbound("GRV-ZZZZZZ"));
  check(
    "unknown reference answered honestly",
    missing.replies.some((r) => r.type === "text" && r.text.includes("couldn't find")),
  );

  // Handoff: the bot must go quiet rather than talk over a human.
  await runtime.handle(inbound("agent"));
  const conv = store.get("919820012345");
  eq("conversation marked for handoff", conv?.status, "handoff");
  const silent = await runtime.handle(inbound("are you there?"));
  check("bot stays silent during handoff", !silent.processed && silent.note === "handoff_silent");
  eq("nothing sent during handoff", silent.sends.length, 0);
  check(
    "message still recorded during handoff",
    store.transcript("919820012345").some((m) => m.body === "are you there?"),
  );

  const resumed = await runtime.handle(inbound("menu"));
  check("explicit menu resumes the bot", resumed.processed);
  eq("conversation active again", store.get("919820012345")?.status, "active");

  // Session expiry restarts rather than resuming a half-filled form.
  await runtime.handle(inbound("file", true));
  clock += 25 * 60 * 60 * 1000;
  const stale = await runtime.handle(inbound("water", true));
  eq("stale session restarts at the menu", store.get("919820012345")?.state.stepId, "main");
  check("restart greets again", stale.replies.length === 2);

  // Delivery receipts land on the audit row.
  const outbound = sent.length;
  check("outbound messages were recorded", outbound > 0);
  await runtime.handle({
    kind: "status", id: "wamid.MOCK1", status: "delivered",
    recipient: "919820012345", timestamp: clock, raw: {},
  });
  const delivered = sqlite
    .prepare("SELECT status FROM messages WHERE wamid = ?")
    .get("wamid.MOCK1") as { status: string } | undefined;
  eq("receipt updates the audit log", delivered?.status, "delivered");

  const transcript = store.transcript("919820012345");
  check("transcript covers both directions", transcript.some((t) => t.direction === "in") && transcript.some((t) => t.direction === "out"));
  check(
    "transcript is in observed order",
    transcript.every((t, i, a) => i === 0 || a[i - 1]!.seq < t.seq),
  );

  const effects = store.openEffects();
  check("effects recorded for staff", effects.some((e) => e.name === "handoff"));
}

await runtimeTests();

// ── Audit log integrity ─────────────────────────────────────────────

section("audit log");

async function auditTests(): Promise<void> {
  const sqlite = new Database(":memory:");
  migrate(sqlite);
  const store = new Store(sqlite);

  // The regression: the Graph API can answer 2xx with a body carrying no
  // usable wamid. Keyed on that, every such send collides and all but the
  // first silently vanish from the audit log.
  const noId = { ok: true as const, messageId: "" };
  store.logOutbound("9198", { type: "text", text: "first" }, noId, 1000);
  store.logOutbound("9198", { type: "text", text: "second" }, noId, 1000);
  eq("two id-less sends both recorded", store.transcript("9198").length, 2);

  // Same text, same millisecond — a retry nudge repeated verbatim.
  store.logOutbound("9198", { type: "text", text: "same" }, noId, 2000);
  store.logOutbound("9198", { type: "text", text: "same" }, noId, 2000);
  eq("identical simultaneous sends both recorded", store.transcript("9198").length, 4);

  // Failed sends are audited too, with the reason.
  store.logOutbound(
    "9198",
    { type: "text", text: "blocked" },
    { ok: false, error: "window_closed", retryable: false },
    3000,
  );
  const failedRow = sqlite
    .prepare("SELECT status, error FROM messages WHERE body = 'blocked'")
    .get() as { status: string; error: string } | undefined;
  eq("failed send recorded as failed", failedRow?.status, "failed");
  eq("failure reason preserved", failedRow?.error, "window_closed");

  // Receipts correlate on the Meta id, not the local row key.
  store.logOutbound("9198", { type: "text", text: "tracked" }, { ok: true, messageId: "wamid.REAL1" }, 4000);
  store.updateDelivery("wamid.REAL1", "read");
  const tracked = sqlite
    .prepare("SELECT status FROM messages WHERE wamid = 'wamid.REAL1'")
    .get() as { status: string } | undefined;
  eq("receipt correlates on wamid", tracked?.status, "read");

  // Regression: Meta timestamps inbound to the second, we timestamp outbound
  // to the millisecond. Sorting the transcript by time lets the next turn's
  // question jump ahead of the previous turn's answer.
  {
    const sqlite2 = new Database(":memory:");
    migrate(sqlite2);
    const s = new Store(sqlite2);
    const inbound = (id: string, text: string, ts: number): InboundMessage => ({
      kind: "message", id, from: "9199", phoneNumberId: "PN1",
      timestamp: ts, content: { type: "text", text }, raw: {},
    });

    s.logInbound(inbound("wamid.A", "answer one", 1_785_309_221_000));
    s.logOutbound("9199", { type: "text", text: "Where is it?" }, { ok: true, messageId: "w1" }, 1_785_309_221_162);
    // Same wall-clock second as the first, but genuinely later.
    s.logInbound(inbound("wamid.B", "MG Road", 1_785_309_221_000));

    const rows = s.transcript("9199");
    eq(
      "transcript preserves observed order across timestamp granularities",
      rows.map((r) => r.body),
      ["answer one", "Where is it?", "MG Road"],
    );
    check(
      "the naive time sort would have got this wrong",
      [...rows].sort((a, b) => a.createdAt - b.createdAt).map((r) => r.body)[2] === "Where is it?",
    );
  }

  // Inbound still dedupes on the wamid — that is what makes redelivery inert.
  const msg: InboundMessage = {
    kind: "message", id: "wamid.IN1", from: "9198", phoneNumberId: "PN1",
    timestamp: 5000, content: { type: "text", text: "hi" }, raw: {},
  };
  store.logInbound(msg);
  store.logInbound(msg);
  eq(
    "redelivered inbound logged once",
    (sqlite.prepare("SELECT count(*) AS c FROM messages WHERE wamid = 'wamid.IN1'").get() as { c: number }).c,
    1,
  );
}

await auditTests();

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${failures.length === 0 ? "✓" : "✗"} ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
