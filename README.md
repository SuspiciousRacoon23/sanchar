# Sanchar

WhatsApp Business Cloud API runtime — signature-verified webhook ingest, a
deterministic conversation state machine, and a defensible audit log.

Built as a Baxtage bid asset for citizen-service and enterprise chatbot work
(the GeM "AI/ML/DL as a Service" and "Custom Bid for Services" categories). The
point is to have something working to demo in a technical presentation, and a
core that a real engagement is delivered on rather than restarted from.

**Status:** webhook + state machine + audit log complete and tested. No Meta
account required to run it. Not deployed.

```
npm install
npm run migrate
npm run dev        # terminal 1 — starts on :3100
npm run repl       # terminal 2 — talk to the bot
npm test           # 137 checks
```

---

## What works today

- **Webhook** — GET subscription handshake, POST ingest, HMAC-SHA256 signature
  verification over the raw body, fast 200 ACK with processing off the response
  path, and idempotency so Meta's redelivery is inert.
- **State machine** — flows declared as data (`say` / `choose` / `ask` / `do` /
  `end`), pure and synchronous, emitting replies and effects rather than
  performing them. Global commands, validation with retry limits, escalation to
  a human, no dead ends.
- **Send client** — Graph API payload rendering for text, buttons, lists and
  templates, with Meta's length and count limits enforced. Transport is
  injected, so everything runs against a mock until credentials arrive.
- **24-hour service window** — enforced in the send path, not left to callers.
- **Audit log** — every message in and out, in observed order, with delivery
  receipts correlated back to the row.
- **Worked flow** — `src/flows/grievance.ts`, a municipal grievance intake with
  categorised capture, a confirmation gate, ticket creation and status lookup.

## What is not built

Admin console for human handoff · media download from Meta · template
submission and management · outbox with retry/backoff · multilingual routing ·
the retrieval layer for informational answers · rate-limit and tier handling.

---

## Layout

```
src/core/         framework-agnostic, no I/O
  types.ts        raw envelope vs normalized domain events
  signature.ts    X-Hub-Signature-256 + the GET handshake
  parse.ts        webhook → InboundEvent[], never throws
  machine.ts      the state machine + flow validation
  window.ts       the 24-hour rule
  client.ts       Graph API rendering and send
src/db/           schema (explicit SQL) + migration
src/store.ts      conversations, audit log, effects, tickets
src/runtime.ts    ingest → machine → effects → send → persist
src/webhook.ts    transport-agnostic webhook logic
src/server.ts     standalone node:http server
src/adapters/     Next.js App Router mount
src/flows/        conversation definitions
scripts/          test suite + mock Meta harness
```

## Design decisions worth knowing

**The machine is pure.** `start` and `advance` are synchronous functions of
(flow, state, input). They never write a record or call a model — they emit
`Effect`s that the runtime executes. That is what makes a conversation
replayable in a test and auditable afterwards. A step that must read the
database (the status lookup) emits an effect whose handler returns the reply.

**No generation in the transactional path.** Every string a citizen sees is
written and reviewable. Where a model helps — understanding messy input,
detecting language, translating — it runs *before* the machine and hands it a
canonical string. A hallucinated answer about an entitlement is real harm and a
fast route to being blacklisted.

**Flows are validated at boot.** `validateFlow` catches dangling targets,
duplicate ids, over-long button titles and too many choices before the server
starts, rather than as a Graph API 400 at 2am.

**Signatures are checked over raw bytes.** `JSON.stringify(await req.json())` is
not byte-identical to what Meta signed. Both the node server and the Next
adapter read the raw body. This is the single most common way these
integrations end up silently accepting forged traffic.

**The audit log keys outbound rows locally.** The Graph API can return 2xx with
no parseable message id; keying audit rows on that makes every such send
collide and vanish. Outbound rows get their own unique key and carry Meta's id
in a separate column for receipt correlation.

**Transcripts order by observed sequence, not timestamp.** Meta timestamps
inbound messages to the second; we timestamp outbound to the millisecond.
Sorting by time lets the next turn's question sort ahead of the previous turn's
answer, so the record reads as though the bot answered something it had not
been asked. Both defects are covered by regression tests.

---

## Going live — the provisioning chain

Provisioning, not engineering, is the critical path. Start it early; build
against the mock meanwhile.

1. **Meta Business Account** for the company.
2. **Business Verification** — Certificate of Incorporation, GST certificate,
   and a utility bill or bank statement. Legal name and address must match
   *exactly* across all of them. Days to weeks, and rejected for trivial
   mismatches. **This gates everything.**
3. **Developer app** with the WhatsApp product added → creates the WABA.
4. **A dedicated phone number** — must not currently be on regular WhatsApp or
   the Business app, and cannot go back once migrated.
5. **Display name approval.**
6. Copy `.env.example` → `.env` and fill in the four `WA_*` values. The runtime
   flips from mock to live automatically once the token and phone number id are
   present.
7. Point the webhook at `https://…/webhook` with your `WA_VERIFY_TOKEN` and
   subscribe to the `messages` field.

New numbers start capped at 250 unique recipients per 24 hours and tier up on
volume and quality rating. If a tender states user volumes, that ramp is a real
constraint worth naming in the bid.

## Before bidding: the residency constraint

Meta sunset the on-premises WhatsApp API, so **every** message transits Meta's
infrastructure. No WhatsApp deployment can satisfy a strict "data must not leave
India" requirement. Application data — conversations, records, integrations —
stays on infrastructure you control; the message transport does not.

State this in the technical bid. Buyers who care about residency will have a
position, and naming it upfront reads as competence; discovering it during
delivery reads as the opposite. Where sovereign messaging is genuinely required,
the answer is an on-prem assistant over web or SMS, not WhatsApp.

Layer DPDP Act 2023 obligations on top: consent capture, purpose limitation, a
stated retention policy (prune the audit log; never skip writing it), and a
named grievance officer.

---

## Mounting into Next.js

```ts
// src/app/api/whatsapp/route.ts
import { createWhatsAppRoute } from "sanchar/adapters/next";

export const runtime = "nodejs";        // node:crypto + better-sqlite3
export const dynamic = "force-dynamic";
export const { GET, POST } = createWhatsAppRoute(deps);
```

`POST` must read `await req.text()`. Reading `req.json()` and re-stringifying
breaks every signature check.
