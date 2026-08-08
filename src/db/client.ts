// SQLite, driven with explicit SQL rather than an ORM.
//
// Deliberate: the schema is five tables and the runtime has to be droppable
// into either a fresh Next app or SoftSol without dragging a migration
// toolchain along. When it merges into a Next codebase, these tables port to
// Drizzle in an afternoon — the SQL below is already the shape of that schema.

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.SANCHAR_DB_PATH ?? "./data/sanchar.db";

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  instance = new Database(DB_PATH);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  return instance;
}

export function migrate(target: Database.Database = db()): void {
  target.exec(`
    -- One row per citizen/customer conversation, keyed by their WhatsApp id.
    CREATE TABLE IF NOT EXISTS conversations (
      wa_id            TEXT PRIMARY KEY,
      phone_number_id  TEXT NOT NULL DEFAULT '',
      profile_name     TEXT,
      flow_id          TEXT NOT NULL,
      step_id          TEXT NOT NULL,
      data             TEXT NOT NULL DEFAULT '{}',   -- JSON: everything collected
      attempts         INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'active', -- active | handoff | closed
      assigned_to      TEXT,
      -- Drives the 24-hour service window. Null means we have never heard
      -- from them, so only templates may be sent.
      last_inbound_at  INTEGER,
      last_outbound_at INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS conv_status_idx ON conversations(status, updated_at);

    -- Immutable audit log. Every byte in and out, in order. Tenders ask for
    -- this explicitly; DPDP retention rules get applied by pruning it, never
    -- by not writing it.
    CREATE TABLE IF NOT EXISTS messages (
      -- Inbound rows key on the wamid, which is what makes redelivery a no-op.
      -- Outbound rows key on a locally generated id instead: the Graph API can
      -- return 2xx with no parseable wamid, and keying on that would make every
      -- such send collide and vanish under INSERT OR IGNORE. An audit log that
      -- silently drops rows is worse than no audit log.
      id           TEXT PRIMARY KEY,
      -- Meta's id for this message. Set for inbound always, for outbound only
      -- once the send succeeds. Delivery receipts correlate on this.
      wamid        TEXT,
      wa_id        TEXT NOT NULL,
      direction    TEXT NOT NULL,           -- in | out
      type         TEXT NOT NULL,
      body         TEXT,                    -- human-readable rendering
      raw          TEXT,                    -- JSON as sent/received
      status       TEXT,                    -- sent | delivered | read | failed
      error        TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS msg_conv_idx ON messages(wa_id, created_at);
    CREATE INDEX IF NOT EXISTS msg_wamid_idx ON messages(wamid);

    -- Idempotency. Meta redelivers on any non-200 and occasionally just
    -- because; without this a retried webhook advances the flow twice and the
    -- citizen's form silently skips a question.
    CREATE TABLE IF NOT EXISTS processed (
      id         TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    -- Effects the machine emitted that a human has to action.
    CREATE TABLE IF NOT EXISTS effects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_id       TEXT NOT NULL,
      name        TEXT NOT NULL,
      payload     TEXT NOT NULL DEFAULT '{}',
      resolved_at INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS eff_open_idx ON effects(resolved_at, created_at);

    -- Worked example of a flow side-effect with a real record behind it.
    CREATE TABLE IF NOT EXISTS tickets (
      id         TEXT PRIMARY KEY,
      wa_id      TEXT NOT NULL,
      category   TEXT NOT NULL,
      details    TEXT NOT NULL,
      location   TEXT,
      status     TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ticket_conv_idx ON tickets(wa_id, created_at);
  `);
}
