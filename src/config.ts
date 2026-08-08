// Environment wiring, in one place, with an explicit "not configured yet" mode.
//
// The runtime deliberately boots without Meta credentials: Business
// Verification takes days to weeks, and none of the conversation work should be
// blocked behind it. With no access token the client swaps to a mock transport
// that prints what WOULD have been sent, and everything else — webhook,
// signature checks, state machine, audit log — behaves identically.

import { readFileSync, existsSync } from "node:fs";

// Minimal .env loader; avoids a dependency for four variables.
function loadEnvFile(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

export const config = {
  appSecret: process.env.WA_APP_SECRET ?? "",
  verifyToken: process.env.WA_VERIFY_TOKEN ?? "",
  accessToken: process.env.WA_ACCESS_TOKEN ?? "",
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID ?? "",
  graphVersion: process.env.WA_GRAPH_VERSION ?? "v21.0",
  port: Number(process.env.PORT ?? 3100),
  /** True once Meta credentials exist and messages will really leave. */
  live: Boolean(process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID),
};

/**
 * Signature verification is mandatory in live mode. Locally, with no app
 * secret, it is skipped so the mock harness can drive the webhook — but the
 * server refuses to start live without it rather than silently accepting
 * unsigned traffic.
 */
export function signatureRequired(): boolean {
  return config.live || Boolean(config.appSecret);
}
