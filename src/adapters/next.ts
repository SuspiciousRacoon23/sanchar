// Next.js App Router adapter.
//
// Drop into any Next app (a fresh one, or SoftSol) as
// `src/app/api/whatsapp/route.ts`:
//
//     import { createWhatsAppRoute } from "sanchar/adapters/next";
//     export const runtime = "nodejs";        // node:crypto + better-sqlite3
//     export const dynamic = "force-dynamic";
//     export const { GET, POST } = createWhatsAppRoute(deps);
//
// The one thing that must not change: POST reads `await req.text()`, the raw
// body. Reading `await req.json()` and re-stringifying it produces a different
// byte sequence and every signature check will fail.

import { handleEvent, handleVerification, type WebhookDeps } from "../webhook.js";

type MinimalRequest = {
  url: string;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
};

export function createWhatsAppRoute(deps: WebhookDeps) {
  return {
    async GET(req: MinimalRequest): Promise<Response> {
      const params = new URL(req.url).searchParams;
      const r = handleVerification(params, deps);
      return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } });
    },

    async POST(req: MinimalRequest): Promise<Response> {
      const raw = await req.text();
      const { response, work } = handleEvent(
        raw,
        req.headers.get("x-hub-signature-256"),
        deps,
      );
      // On serverless, awaiting here is the safe default — the function may be
      // frozen the moment the response is returned, dropping in-flight work.
      // Swap to `waitUntil(work)` on a platform that supports it.
      await work;
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": response.contentType },
      });
    },
  };
}
