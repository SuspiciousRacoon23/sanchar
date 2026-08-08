// Standalone webhook server. Zero HTTP dependencies — node:http is enough for
// three routes, and it keeps this mountable anywhere.
//
//   GET  /webhook   Meta subscription handshake
//   POST /webhook   inbound messages and delivery receipts
//   GET  /health    liveness + configuration state
//   GET  /transcript?wa=…   the audit log for one conversation

import { createServer, type IncomingMessage } from "node:http";
import { config, signatureRequired } from "./config.js";
import { db, migrate } from "./db/client.js";
import { Store } from "./store.js";
import { WhatsAppClient, type Transport } from "./core/client.js";
import { Runtime, grievanceHandlers } from "./runtime.js";
import { grievanceFlow } from "./flows/grievance.js";
import { validateFlow } from "./core/machine.js";
import { handleEvent, handleVerification, type WebhookDeps } from "./webhook.js";

// ── Boot checks ─────────────────────────────────────────────────────

const problems = validateFlow(grievanceFlow);
if (problems.length) {
  console.error("✗ flow validation failed:");
  for (const p of problems) console.error("  -", p);
  process.exit(1);
}

migrate(db());

// ── Client: real or printing-mock ───────────────────────────────────

let mockSeq = 0;
const printingTransport: Transport = async (_url, init) => {
  const payload = JSON.parse(init.body) as Record<string, any>;
  const to = payload.to ?? "?";
  if (payload.type === "text") {
    console.log(`  → ${to}: ${payload.text.body}`);
  } else if (payload.type === "interactive") {
    const i = payload.interactive;
    console.log(`  → ${to}: ${i.body.text}`);
    const opts =
      i.type === "button"
        ? i.action.buttons.map((b: any) => `[${b.reply.id}] ${b.reply.title}`)
        : i.action.sections[0].rows.map((r: any) => `[${r.id}] ${r.title}`);
    for (const o of opts) console.log(`      ${o}`);
  } else if (payload.status === "read") {
    // Blue-tick call; not worth printing.
  } else {
    console.log(`  → ${to}: ${JSON.stringify(payload).slice(0, 200)}`);
  }
  // Counter, not Date.now() — two messages in one turn land in the same
  // millisecond and duplicate ids would misrepresent the audit log.
  return { status: 200, text: JSON.stringify({ messages: [{ id: `wamid.MOCK${++mockSeq}` }] }) };
};

const client = new WhatsAppClient({
  accessToken: config.accessToken,
  phoneNumberId: config.phoneNumberId || "MOCK_PHONE_ID",
  graphVersion: config.graphVersion,
  transport: config.live ? undefined : printingTransport,
});

const runtime = new Runtime({
  flow: grievanceFlow,
  store: new Store(),
  client,
  handlers: grievanceHandlers,
});

const deps: WebhookDeps = {
  runtime,
  appSecret: config.appSecret,
  verifyToken: config.verifyToken,
  requireSignature: signatureRequired(),
  onError: (e) => console.error("✗ processing error:", e.message),
};

// ── Server ──────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        mode: config.live ? "live" : "mock",
        signatureRequired: deps.requireSignature,
        flow: grievanceFlow.id,
      }),
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/transcript") {
    const wa = url.searchParams.get("wa");
    if (!wa) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "wa query param required" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(new Store().transcript(wa), null, 2));
    return;
  }

  if (url.pathname === "/webhook") {
    if (req.method === "GET") {
      const r = handleVerification(url.searchParams, deps);
      res.writeHead(r.status, { "content-type": r.contentType });
      res.end(r.body);
      return;
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      const sig = req.headers["x-hub-signature-256"];
      const { response, work } = handleEvent(
        raw,
        typeof sig === "string" ? sig : null,
        deps,
      );
      res.writeHead(response.status, { "content-type": response.contentType });
      res.end(response.body);
      // Acknowledged; finish the conversation work off the response path.
      work.catch((e) => console.error("✗ background error:", (e as Error).message));
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(config.port, () => {
  console.log(`Sanchar listening on :${config.port}  [${config.live ? "LIVE" : "MOCK"}]`);
  if (!config.live) {
    console.log("  no Meta credentials — outbound messages print here instead of sending");
  }
  if (!deps.requireSignature) {
    console.log("  ⚠ WA_APP_SECRET unset — webhook signatures are NOT verified (local only)");
  }
  console.log(`  drive it with:  npm run repl`);
});
