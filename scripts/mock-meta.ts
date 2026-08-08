// Drives the webhook exactly as Meta would: real envelope shape, real
// X-Hub-Signature-256, real HTTP. This is what makes the bot demoable in a
// technical presentation months before Business Verification clears.
//
//   npm run repl                  interactive session
//   npm run mock -- "hello"       one message
//   npm run mock -- "#file"       tap the button whose id is `file`
//
// Prefix a message with '#' to simulate a button/list tap rather than typing.

import { createInterface } from "node:readline";
import { signBody } from "../src/core/signature.js";
import { config } from "../src/config.js";

const BASE = `http://127.0.0.1:${config.port}`;
const FROM = process.env.MOCK_FROM ?? "919820012345";
const NAME = process.env.MOCK_NAME ?? "Test Citizen";

let seq = 0;

function envelope(from: string, body: string): string {
  const id = `wamid.MOCK${Date.now()}${seq++}`;
  const ts = Math.floor(Date.now() / 1000).toString();

  const message = body.startsWith("#")
    ? {
        from,
        id,
        timestamp: ts,
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: body.slice(1), title: body.slice(1) },
        },
      }
    : { from, id, timestamp: ts, type: "text", text: { body } };

  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "MOCK_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "911140000000", phone_number_id: "MOCK_PHONE_ID" },
              contacts: [{ profile: { name: NAME }, wa_id: from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  });
}

async function send(body: string): Promise<void> {
  const raw = envelope(FROM, body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.appSecret) headers["x-hub-signature-256"] = signBody(raw, config.appSecret);

  const res = await fetch(`${BASE}/webhook`, { method: "POST", headers, body: raw });
  if (!res.ok) {
    console.error(`✗ webhook returned ${res.status}: ${await res.text()}`);
  }
}

let seen = 0;

async function fetchTranscript(): Promise<Array<{ direction: string; body: string }> | null> {
  try {
    const res = await fetch(`${BASE}/transcript?wa=${FROM}`);
    if (!res.ok) return null;
    return (await res.json()) as Array<{ direction: string; body: string }>;
  } catch {
    return null;
  }
}

/**
 * The webhook ACKs before the turn finishes, so poll until the transcript stops
 * growing rather than guessing at a delay — otherwise a turn's later replies
 * bleed into the next one and the demo reads as if the bot lost its place.
 */
async function drain(): Promise<void> {
  let stableFor = 0;
  let length = seen;

  for (let i = 0; i < 60 && stableFor < 3; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const rows = await fetchTranscript();
    if (!rows) {
      console.error("✗ could not reach the server — is `npm run dev` running?");
      return;
    }
    if (rows.length !== length) {
      stableFor = 0;
      length = rows.length;
      continue;
    }
    // Only start counting toward "settled" once this turn has actually
    // produced something. Otherwise the poll can declare stability before the
    // server has written a single row, and the turn's replies bleed into the
    // next one.
    if (rows.length > seen) stableFor++;
  }

  const rows = await fetchTranscript();
  if (!rows) return;
  for (const row of rows.slice(seen)) {
    if (row.direction === "out") console.log(`  ← ${row.body.replace(/\n/g, "\n    ")}`);
  }
  seen = rows.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repl = args.includes("--repl");
  const oneShot = args.filter((a) => !a.startsWith("--")).join(" ");

  // Sync the transcript cursor so a REPL session only prints new turns.
  try {
    const res = await fetch(`${BASE}/transcript?wa=${FROM}`);
    if (res.ok) seen = ((await res.json()) as unknown[]).length;
  } catch {
    console.error(`✗ no server on ${BASE} — start it with \`npm run dev\``);
    process.exit(1);
  }

  if (!repl) {
    await send(oneShot || "hello");
    await drain();
    return;
  }

  console.log(`Mock WhatsApp session as ${NAME} <${FROM}>`);
  console.log("Type a message, or #<id> to tap a button. Ctrl-C to exit.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "  → " });
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text) {
      await send(text);
      await drain();
    }
    rl.prompt();
  }
}

void main();
