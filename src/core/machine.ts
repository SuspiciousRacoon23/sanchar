// The conversation state machine.
//
// Design constraints that come straight from the government-delivery brief:
//
//   • PURE. `start` and `advance` are synchronous functions of (flow, state,
//     input). They never write a ticket, call an LLM or send a message — they
//     emit Effects and Replies for the runtime to execute. That is what makes
//     the whole conversation layer replayable in a test and auditable after
//     the fact: given the same transcript you get the same transitions.
//
//   • NO DEAD ENDS. Global commands (menu / help / agent / cancel) resolve at
//     every step, and repeated failure escalates to a human instead of looping.
//     A citizen trapped in a validation loop is a grievance, not a bug report.
//
//   • NO GENERATION IN THE TRANSACTIONAL PATH. Steps declare exact text and
//     exact choices. Where an LLM helps — understanding messy input, detecting
//     language — it runs *before* the machine and hands it a canonical string.

import type { Ctx, Effect, MachineState, Reply } from "./types.js";

// ── Flow definition ─────────────────────────────────────────────────

export type TextSpec = string | ((ctx: Ctx) => string);

export type Validator = (
  input: string,
  ctx: Ctx,
) => { ok: true; value: string } | { ok: false; message: string };

export type Choice = { id: string; title: string; description?: string; next: string };

export type Step =
  /** Send a line, continue immediately. */
  | { kind: "say"; id: string; text: TextSpec; next: string }
  /** Send a prompt and wait for a button/list tap (or the equivalent typed). */
  | {
      kind: "choose";
      id: string;
      text: TextSpec;
      choices: Choice[];
      /** Label on the list-opener button when rendered as a list (>3 choices). */
      listButton?: string;
      /** Store the chosen id under this key. */
      key?: string;
    }
  /** Send a prompt and wait for free text. */
  | { kind: "ask"; id: string; text: TextSpec; key: string; validate?: Validator; next: string }
  /** Fire an effect, continue immediately. */
  | { kind: "do"; id: string; effect: Effect | ((ctx: Ctx) => Effect); next: string }
  /** Terminal. */
  | { kind: "end"; id: string; text?: TextSpec; effect?: Effect | ((ctx: Ctx) => Effect) };

export type Flow = {
  id: string;
  entry: string;
  steps: Step[];
  /** Words that jump anywhere, at any step. Keys are matched lowercased. */
  commands?: Record<string, string>;
  /** Where to land when a human takes over. Omit to just end the session. */
  handoffStep?: string;
  /** Consecutive failures at one step before escalating. Default 3. */
  maxAttempts?: number;
};

/** Reserved target: escalate to a human. Usable as any `next`/command target. */
export const HANDOFF = "__handoff";

// Meta's hard limits. Exceeding them is a 400 from the Graph API at runtime,
// which is a miserable way to discover a typo — validateFlow catches them at boot.
export const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  bodyText: 1024,
} as const;

// ── Transition result ───────────────────────────────────────────────

export type Transition = {
  state: MachineState;
  replies: Reply[];
  effects: Effect[];
  /** The machine is now parked, waiting for the user. */
  awaiting: boolean;
  /** A terminal step was reached. */
  ended: boolean;
};

// ── Helpers ─────────────────────────────────────────────────────────

const resolveText = (spec: TextSpec, ctx: Ctx): string =>
  typeof spec === "function" ? spec(ctx) : spec;

const resolveEffect = (spec: Effect | ((ctx: Ctx) => Effect), ctx: Ctx): Effect =>
  typeof spec === "function" ? spec(ctx) : spec;

function indexSteps(flow: Flow): Map<string, Step> {
  const m = new Map<string, Step>();
  for (const s of flow.steps) m.set(s.id, s);
  return m;
}

/** Render a `choose` step to the right Meta primitive: buttons up to 3, else a list. */
export function renderChoices(text: string, step: Extract<Step, { kind: "choose" }>): Reply {
  if (step.choices.length <= LIMITS.buttons) {
    return {
      type: "buttons",
      text,
      buttons: step.choices.map((c) => ({ id: c.id, title: c.title })),
    };
  }
  return {
    type: "list",
    text,
    button: step.listButton ?? "Choose",
    rows: step.choices.map((c) => ({ id: c.id, title: c.title, description: c.description })),
  };
}

// ── Flow validation (run at boot, not at 2am) ────────────────────────

export function validateFlow(flow: Flow): string[] {
  const problems: string[] = [];
  const steps = indexSteps(flow);
  const seen = new Set<string>();

  for (const s of flow.steps) {
    if (seen.has(s.id)) problems.push(`duplicate step id "${s.id}"`);
    seen.add(s.id);
  }

  const target = (from: string, to: string) => {
    if (to === HANDOFF) return;
    if (!steps.has(to)) problems.push(`step "${from}" points at unknown step "${to}"`);
  };

  if (!steps.has(flow.entry)) problems.push(`entry step "${flow.entry}" does not exist`);
  if (flow.handoffStep && !steps.has(flow.handoffStep)) {
    problems.push(`handoffStep "${flow.handoffStep}" does not exist`);
  }

  for (const [word, to] of Object.entries(flow.commands ?? {})) {
    if (word !== word.toLowerCase()) problems.push(`command "${word}" must be lowercase`);
    target(`command:${word}`, to);
  }

  for (const s of flow.steps) {
    switch (s.kind) {
      case "say":
      case "ask":
      case "do":
        target(s.id, s.next);
        break;
      case "choose": {
        if (s.choices.length === 0) problems.push(`step "${s.id}" has no choices`);
        if (s.choices.length > LIMITS.listRows) {
          problems.push(
            `step "${s.id}" has ${s.choices.length} choices; WhatsApp allows at most ${LIMITS.listRows}`,
          );
        }
        const ids = new Set<string>();
        for (const c of s.choices) {
          if (ids.has(c.id)) problems.push(`step "${s.id}" has duplicate choice id "${c.id}"`);
          ids.add(c.id);
          const cap = s.choices.length <= LIMITS.buttons ? LIMITS.buttonTitle : LIMITS.listRowTitle;
          if (c.title.length > cap) {
            problems.push(`step "${s.id}" choice "${c.id}" title is ${c.title.length} chars; max ${cap}`);
          }
          if (c.description && c.description.length > LIMITS.listRowDescription) {
            problems.push(
              `step "${s.id}" choice "${c.id}" description is ${c.description.length} chars; max ${LIMITS.listRowDescription}`,
            );
          }
          target(s.id, c.next);
        }
        break;
      }
      case "end":
        break;
    }
  }

  return problems;
}

// ── Core: entering a step ───────────────────────────────────────────

const MAX_CHAIN = 25; // guard against a mis-declared say→say cycle

function makeCtx(state: MachineState, base: Omit<Ctx, "data">): Ctx {
  return { ...base, data: state.data };
}

/**
 * Walk forward from `stepId`, executing auto-advancing steps (`say`, `do`),
 * until the flow parks on input (`choose`, `ask`) or terminates (`end`).
 */
function enter(
  flow: Flow,
  stepId: string,
  state: MachineState,
  base: Omit<Ctx, "data">,
): Transition {
  const steps = indexSteps(flow);
  const replies: Reply[] = [];
  const effects: Effect[] = [];
  let current = stepId;
  let next: MachineState = { ...state, stepId: current, attempts: 0 };

  for (let hops = 0; hops < MAX_CHAIN; hops++) {
    if (current === HANDOFF) {
      effects.push({ type: "handoff", reason: "requested" });
      if (flow.handoffStep) {
        current = flow.handoffStep;
        continue;
      }
      return { state: { ...next, stepId: HANDOFF }, replies, effects, awaiting: false, ended: true };
    }

    const step = steps.get(current);
    if (!step) {
      // A live session pointing at a step that no longer exists (flow was
      // edited under it). Restarting beats stranding the user.
      effects.push({ type: "custom", name: "flow_desync", payload: { stepId: current } });
      current = flow.entry;
      continue;
    }

    const ctx = makeCtx(next, base);
    next = { ...next, stepId: step.id, attempts: 0 };

    switch (step.kind) {
      case "say":
        replies.push({ type: "text", text: resolveText(step.text, ctx) });
        current = step.next;
        break;

      case "do":
        effects.push(resolveEffect(step.effect, ctx));
        current = step.next;
        break;

      case "choose":
        replies.push(renderChoices(resolveText(step.text, ctx), step));
        return { state: next, replies, effects, awaiting: true, ended: false };

      case "ask":
        replies.push({ type: "text", text: resolveText(step.text, ctx) });
        return { state: next, replies, effects, awaiting: true, ended: false };

      case "end":
        if (step.text) replies.push({ type: "text", text: resolveText(step.text, ctx) });
        if (step.effect) effects.push(resolveEffect(step.effect, ctx));
        return { state: next, replies, effects, awaiting: false, ended: true };
    }
  }

  // Only reachable from a genuinely broken flow; fail loudly but safely.
  effects.push({ type: "custom", name: "flow_loop", payload: { stepId: current } });
  return { state: next, replies, effects, awaiting: false, ended: true };
}

// ── Public API ──────────────────────────────────────────────────────

/** Begin a fresh conversation at the flow's entry step. */
export function start(flow: Flow, base: Omit<Ctx, "data">, data: Record<string, string> = {}): Transition {
  const state: MachineState = { flowId: flow.id, stepId: flow.entry, data: { ...data }, attempts: 0 };
  return enter(flow, flow.entry, state, base);
}

/** Match typed input against a choice: exact id, then 1-based index, then title. */
function matchChoice(step: Extract<Step, { kind: "choose" }>, input: string): Choice | undefined {
  const trimmed = input.trim();
  const exact = step.choices.find((c) => c.id === trimmed);
  if (exact) return exact;

  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 1 && n <= step.choices.length) return step.choices[n - 1];

  const lower = trimmed.toLowerCase();
  return step.choices.find((c) => c.title.toLowerCase() === lower);
}

/**
 * Feed one user input into a parked conversation.
 *
 * `input` is the canonical string from `userInput()` — a button id, or trimmed
 * text. Pass `null` for a message that carries no answer (a photo, a location,
 * a reaction); the machine re-prompts rather than mis-parsing it.
 */
export function advance(
  flow: Flow,
  state: MachineState,
  input: string | null,
  base: Omit<Ctx, "data">,
): Transition {
  const steps = indexSteps(flow);
  const maxAttempts = flow.maxAttempts ?? 3;
  const step = steps.get(state.stepId);

  // Global commands win over any step-level interpretation, always.
  if (input !== null) {
    const word = input.trim().toLowerCase();
    const commandTarget = flow.commands?.[word];
    if (commandTarget) return enter(flow, commandTarget, { ...state, attempts: 0 }, base);
  }

  // Parked somewhere that cannot consume input: a step that vanished under a
  // live session, an auto-advancing step we should never have rested on, or a
  // terminal step the user has kept talking past. All three restart the flow.
  //
  // Restarting matters most for the terminal case. Re-entering the same `end`
  // step would replay its closing line for every further message — a dead end
  // that never escalates and reads, to a citizen, as a bot that has stopped
  // listening. A finished conversation followed by a new message is a new
  // conversation.
  if (!step || (step.kind !== "choose" && step.kind !== "ask")) {
    return enter(flow, flow.entry, { ...state, data: state.data, attempts: 0 }, base);
  }

  const ctx = makeCtx(state, base);

  /** Shared failure path: nudge, and escalate once patience runs out. */
  const retry = (message: string): Transition => {
    const attempts = state.attempts + 1;
    if (attempts >= maxAttempts) {
      const escalated = enter(flow, HANDOFF, { ...state, attempts: 0 }, base);
      return {
        ...escalated,
        replies: [
          { type: "text", text: "Let me connect you to a person who can help." },
          ...escalated.replies,
        ],
        effects: [
          { type: "handoff", reason: `max_attempts:${step.id}` },
          ...escalated.effects.filter((e) => e.type !== "handoff"),
        ],
      };
    }
    const reprompt =
      step.kind === "choose"
        ? renderChoices(resolveText(step.text, ctx), step)
        : ({ type: "text", text: resolveText(step.text, ctx) } as Reply);
    return {
      state: { ...state, attempts },
      replies: [{ type: "text", text: message }, reprompt],
      effects: [],
      awaiting: true,
      ended: false,
    };
  };

  if (input === null) {
    return retry("Sorry — I can only read typed replies or the options below.");
  }

  if (step.kind === "choose") {
    const choice = matchChoice(step, input);
    if (!choice) return retry("Sorry, I didn't catch that. Please pick one of the options.");
    const data = step.key ? { ...state.data, [step.key]: choice.id } : state.data;
    return enter(flow, choice.next, { ...state, data, attempts: 0 }, base);
  }

  // step.kind === "ask"
  const result = step.validate ? step.validate(input, ctx) : ({ ok: true, value: input } as const);
  if (!result.ok) return retry(result.message);
  const data = { ...state.data, [step.key]: result.value };
  return enter(flow, step.next, { ...state, data, attempts: 0 }, base);
}
