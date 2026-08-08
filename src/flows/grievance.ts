// Worked example: a citizen grievance-intake flow.
//
// Chosen because it exercises every part of the machine that a real government
// tender asks for — a menu, a categorised intake form with validation, a
// confirmation gate, a record-creating side effect, a status lookup that has to
// read the database, and a human escape hatch reachable from anywhere.
//
// Note what is NOT here: any generated prose. Every string a citizen sees is
// written, reviewable and translatable. That is the property that survives a
// technical evaluation.

import type { Flow, Validator } from "../core/machine.js";
import { HANDOFF } from "../core/machine.js";

const minLength =
  (n: number, what: string): Validator =>
  (input) => {
    const v = input.trim();
    if (v.length < n) return { ok: false, message: `Please give a bit more detail — ${what}.` };
    if (v.length > 900) return { ok: true, value: v.slice(0, 900) };
    return { ok: true, value: v };
  };

const ticketRef: Validator = (input) => {
  const v = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^GRV-[A-Z0-9]{6}$/.test(v)) {
    return { ok: false, message: "That doesn't look like a reference. It looks like GRV-4B7K2P." };
  }
  return { ok: true, value: v };
};

export const grievanceFlow: Flow = {
  id: "grievance-v1",
  entry: "welcome",
  maxAttempts: 3,
  handoffStep: "handoff_ack",
  // Reachable at every single step. Non-negotiable for citizen services.
  commands: {
    menu: "main",
    hi: "welcome",
    hello: "welcome",
    start: "welcome",
    help: "help",
    agent: HANDOFF,
    human: HANDOFF,
    cancel: "main",
  },

  steps: [
    {
      kind: "say",
      id: "welcome",
      text: (ctx) =>
        `Namaste${ctx.profileName ? " " + ctx.profileName : ""} 🙏\nThis is the Municipal Grievance Helpline.\n\nType *menu* at any time to come back here, or *agent* to reach a person.`,
      next: "main",
    },

    {
      kind: "choose",
      id: "main",
      text: "What would you like to do?",
      listButton: "Select",
      choices: [
        { id: "file", title: "File a complaint", description: "Report a civic issue", next: "new_cat" },
        { id: "status", title: "Check status", description: "Track an existing complaint", next: "status_ask" },
        { id: "info", title: "Helpline info", description: "Timings and contacts", next: "info" },
        { id: "agent", title: "Talk to a person", description: "Hand over to staff", next: HANDOFF },
      ],
    },

    {
      kind: "choose",
      id: "new_cat",
      key: "category",
      text: "Which department does this concern?",
      listButton: "Choose",
      choices: [
        { id: "water", title: "Water supply", next: "new_details" },
        { id: "power", title: "Street lighting", next: "new_details" },
        { id: "roads", title: "Roads & potholes", next: "new_details" },
        { id: "waste", title: "Waste collection", next: "new_details" },
        { id: "other", title: "Something else", next: "new_details" },
      ],
    },

    {
      kind: "ask",
      id: "new_details",
      key: "details",
      text: "Please describe the problem in a sentence or two.",
      validate: minLength(10, "a sentence or two is enough"),
      next: "new_location",
    },

    {
      kind: "ask",
      id: "new_location",
      key: "location",
      text: "Where is it? A street name and landmark is fine.",
      validate: minLength(3, "a street name or landmark helps us find it"),
      next: "confirm",
    },

    {
      kind: "choose",
      id: "confirm",
      text: (ctx) =>
        `Please confirm:\n\n*Department:* ${ctx.data.category ?? "-"}\n*Problem:* ${ctx.data.details ?? "-"}\n*Location:* ${ctx.data.location ?? "-"}\n\nShall I register this?`,
      choices: [
        { id: "yes", title: "Yes, register", next: "create" },
        { id: "no", title: "Start over", next: "new_cat" },
      ],
    },

    {
      kind: "do",
      id: "create",
      // `ref` is seeded into ctx.data by the runtime once per inbound turn, so
      // this stays a pure function of its inputs and replays identically in a test.
      effect: (ctx) => ({
        type: "custom",
        name: "create_ticket",
        payload: {
          ref: ctx.data.ref ?? "GRV-UNKNOWN",
          category: ctx.data.category ?? "other",
          details: ctx.data.details ?? "",
          location: ctx.data.location ?? "",
        },
      }),
      next: "created",
    },

    {
      kind: "end",
      id: "created",
      text: (ctx) =>
        `✅ Registered.\n\nYour reference is *${ctx.data.ref ?? "-"}*. Please keep it — you can check progress any time by sending *menu* and choosing "Check status".`,
    },

    {
      kind: "ask",
      id: "status_ask",
      key: "lookup_ref",
      text: "Please send your complaint reference (it looks like GRV-4B7K2P).",
      validate: ticketRef,
      next: "status_do",
    },

    {
      kind: "do",
      id: "status_do",
      // The reply comes from the effect handler, which is the only thing that
      // may touch the database. The machine stays pure.
      effect: (ctx) => ({
        type: "custom",
        name: "lookup_ticket",
        payload: { ref: ctx.data.lookup_ref ?? "" },
      }),
      next: "status_end",
    },

    { kind: "end", id: "status_end", text: "Send *menu* if there's anything else." },

    {
      kind: "say",
      id: "info",
      text: "Helpline hours are 9:00–18:00, Monday to Saturday.\nEmergencies: dial 1916.\nComplaints filed here are acknowledged within one working day.",
      next: "main",
    },

    {
      kind: "say",
      id: "help",
      text: "You can type:\n*menu* — main menu\n*agent* — talk to a person\n*cancel* — start again\n\nOr just tap one of the buttons.",
      next: "main",
    },

    {
      kind: "end",
      id: "handoff_ack",
      text: "I've passed this to our staff. Someone will reply here during helpline hours.",
    },
  ],
};
