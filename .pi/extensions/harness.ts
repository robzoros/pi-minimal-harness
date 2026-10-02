/**
 * pi-minimal-harness — the Pi extension.
 *
 * Deliberately thin. The workflow itself lives in `.pi/extensions/lib/`, where
 * it is testable without Pi: the state machine decides what runs next, each
 * agent runs as its own process, and this file only connects that to the
 * terminal, the slash commands and the session.
 *
 * Registered commands:
 *   /harness-run <task>    start a workflow
 *   /harness-answer <text> answer a workflow that is waiting for you
 *   /harness-config        show and validate the configuration
 *   /harness-model <agent> pick a model and effort for one agent
 *   /harness-status        what phase the workflow is in, and why
 *
 * Plus an `input` hook: with `harness.auto_start` on, a plain request starts a
 * workflow — unless one is already waiting for you, in which case the message
 * IS the answer. That order is deliberate and reversing it would swallow your
 * reply as a new task.
 *
 * All agent-to-agent traffic is English. Anything the user reads — the status
 * line, the question a workflow asks you, the notifications — is in the
 * language they used.
 *
 * NOTE: every module under `lib/` is imported by a test. This file used to have
 * none, which let a syntax error ship unnoticed. `tests/extension.test.mjs`
 * exists so that cannot happen again.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { promises as fs } from "node:fs";
import path from "node:path";

import { findModelRef, modelChoices, supportedReasoningLevels, type PiModel } from "./lib/runner.ts";
import { loadConfig, restoreFromEntries, runWorkflow, SUSPENSION_ENTRY, type RunOutcome } from "./lib/driver.ts";
import { isTerminal } from "./lib/transitions.ts";
import { validateConfig, formatChecks, hasErrors } from "./lib/validate.ts";
import { AGENT_NAMES, parseConfig } from "./lib/config.ts";
import { setAgentFields } from "./lib/settings.ts";

const STATUS_KEY = "pi-minimal-harness";
/**
 * Session modes where the harness may take over a message. `json` and `print`
 * are one-shot runs — the harness's own subagents — and their prompt must go
 * straight to the model.
 */
const INTERACTIVE_MODES: readonly string[] = ["tui", "rpc"];
const CONFIG_NAMES = ["harness.config.yaml", ".agents/harness/harness.config.yaml"];

interface Harness {
  /** The last completed run, or null. */
  run: RunOutcome | null;
  /** Two concurrent workflows would fight over the session. */
  busy: boolean;
  running: boolean;
  /** Live run in flight, so status can say so and /harness-abort can stop it. */
  active: AbortController | null;
  /** What the live run is doing, for the status line. */
  phase: string | null;
}

async function configPath(cwd: string): Promise<string | null> {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(cwd, name);
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

/** The status line: what is happening RIGHT NOW, not the last finished thing. */
function statusText(harness: Harness): string | undefined {
  if (harness.running) {
    return `harness: running · ${harness.phase ?? "starting"}`;
  }
  const run = harness.run;
  if (!run) return undefined;
  const parts = [`harness: ${run.state.phase}`];
  if (run.state.maxRetries > 0) parts.push(`retry ${run.state.retry}/${run.state.maxRetries}`);
  if (run.state.suspended) parts.push(run.state.suspended.reason);
  return parts.join(" · ");
}

/**
 * A UI handle that survives the session being replaced.
 *
 * `setStatus` lives on ExtensionUIContext, reached through an EVENT's ctx —
 * ExtensionAPI has no `ui` member at all. Worse, that ctx is invalidated by a
 * reload or a session switch, and a workflow outlives both: the first status
 * update after one threw "This extension ctx is stale" and killed the process
 * mid-run.
 *
 * So every call goes through here. Losing the footer after a reload is
 * cosmetic; losing the run is not.
 */
function tolerantUi(ctx: ExtensionContext): { notify: (m: string, l?: "info" | "warning" | "error") => void; setStatus: (t: string | undefined) => void } {
  return {
    notify: (message, level) => {
      try {
        ctx.ui.notify(message, level ?? "info");
      } catch {
        // the session was replaced; the run continues without the notice
      }
    },
    setStatus: (text) => {
      try {
        ctx.ui.setStatus(STATUS_KEY, text);
      } catch {
        // same
      }
    },
  };
}

function refresh(ui: ReturnType<typeof tolerantUi>, harness: Harness): void {
  ui.setStatus(statusText(harness));
}

export default async function harnessExtension(pi: ExtensionAPI) {
  const harness: Harness = { run: null, busy: false, running: false, active: null, phase: null };
  let runCounter = 0;

  const driverOptions = (ctx: ExtensionContext, ui: ReturnType<typeof tolerantUi>, extra: Record<string, unknown> = {}) => ({
    task: harness.run?.state.task ?? "",
    runId: harness.run?.state.runId ?? `run-${++runCounter}`,
    config: { agents: {} },
    projectDir: ctx.cwd,
    cwd: ctx.cwd,
    notify: (message: string, level?: "info" | "warning" | "error") => ui.notify(message, level),
    persist: (payload: unknown) => pi.appendEntry(SUSPENSION_ENTRY, payload),
    ...extra,
  });

  /** Start a workflow, or say why it cannot start. */
  const start = async (ctx: ExtensionContext, task: string): Promise<void> => {
    const ui = tolerantUi(ctx);
    const file = await configPath(ctx.cwd);
    if (!file) {
      ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
      return;
    }
    const raw = await fs.readFile(file, "utf8");
    const checks = validateConfig(parseConfig(raw));
    if (hasErrors(checks)) {
      const fatal = checks.filter((c) => !c.ok && c.severity === "error");
      ctx.ui.notify(`The configuration is not usable:\n${formatChecks(fatal)}`, "error");
      return;
    }
    if (harness.busy) {
      ctx.ui.notify("A harness workflow is already running.", "warning");
      return;
    }
    harness.busy = true;
    harness.running = true;
    harness.active = new AbortController();
    harness.phase = "planner";
    try {
      const outcome = await runWorkflow({
        ...driverOptions(ctx, ui, {
          signal: harness.active.signal,
          onStep: (agent) => {
            harness.phase = agent;
            refresh(ui, harness);
          },
        }),
        task,
        runId: `run-${++runCounter}`,
        config: await loadConfig(file),
      } as Parameters<typeof runWorkflow>[0]);
      harness.run = outcome;
      report(ui, outcome);
    } catch (error) {
      ui.notify(`The workflow failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      harness.busy = false;
      refresh(ui, harness);
    }
  };

  /**
   * Answer a suspended workflow.
   *
   * THE USER'S OWN WORDS ARE THE ANSWER. An earlier version opened a
   * three-option menu for a plan awaiting approval, which was wrong twice
   * over: `/harness-answer <text>` threw the text away and showed the menu
   * instead, and a user who had something else to say had no way to say it.
   * A workflow must never be reachable only through canned options.
   *
   * So: text is taken as given. When there is none, a free-text box is opened —
   * never a closed menu. The action is inferred by `inferAction`, which defaults
   * to `revise`, so an ambiguous reply can never approve anything by accident.
   */
  const answer = async (ctx: ExtensionContext, text: string, forced?: "approve" | "revise" | "stop"): Promise<boolean> => {
    const ui = tolerantUi(ctx);
    const run = harness.run;
    if (!run || run.state.phase !== "SUSPENDED") return false;
    const file = await configPath(ctx.cwd);
    if (!file) return false;

    let reply = text.trim();
    if (!reply && !forced && ctx.hasUI) {
      const typed = await ctx.ui.input("What should the planner do with this plan?");
      reply = typed?.trim() ?? "";
    }
    if (!reply && !forced) {
      ui.notify("Still waiting: reply here in your own words, or run /harness-answer <what you want>.", "warning");
      return true;
    }

    harness.busy = true;
    harness.running = true;
    harness.active = new AbortController();
    harness.phase = run.state.suspended?.resumeAgent ?? "resuming";
    try {
      const outcome = await runWorkflow(
        {
          ...driverOptions(ctx, ui, {
            userAnswer: reply,
            ...(forced ? { userAction: forced } : {}),
            signal: harness.active.signal,
            onStep: (agent) => {
              harness.phase = agent;
              refresh(ui, harness);
            },
          }),
          config: await loadConfig(file),
        } as Parameters<typeof runWorkflow>[0],
        run.state,
      );
      harness.run = outcome;
      report(ui, outcome);
      return true;
    } catch (error) {
      ui.notify(`The workflow could not continue: ${error instanceof Error ? error.message : String(error)}`, "error");
      return true;
    } finally {
      // Always released. A held `busy` here is what strands a suspended
      // workflow: nothing answers it and nothing says why.
      harness.busy = false;
      harness.active = null;
      harness.phase = null;
      refresh(ui, harness);
    }
  };

  // Runs after the workflow, which is exactly when the ctx may have gone stale.
  const report = (ui: { notify: (m: string, l?: "info" | "warning" | "error") => void }, outcome: RunOutcome): void => {
    if (outcome.stopped === "done") {
      ui.notify(`Workflow finished after ${outcome.stepCount} step(s).`, "info");
      return;
    }
    if (outcome.stopped === "suspended") {
      ui.notify(
        `Workflow paused (${outcome.state.suspended?.reason}): ${outcome.reason}\n\n` +
          "Reply here in your own words — approve it, or say what to change. `/harness-answer <text>` does the same. `/harness-status` shows where it is.",
        "warning",
      );
      return;
    }
    ui.notify(`Workflow stopped: ${outcome.reason}`, "error");
  };

  // A session that ended suspended resumes suspended: the payload is in the
  // session, and /reload replaces the runtime without touching it.
  pi.on("session_start", (_event, ctx) => {
    const restored = restoreFromEntries(ctx.sessionManager.getBranch() as unknown[]);
    harness.run = restored ? { state: restored, stepCount: 0, stopped: "suspended", reason: restored.suspended?.question.question ?? "" } : null;
    refresh(tolerantUi(ctx), harness);
  });

  pi.on("input", async (event, ctx) => {
    // Auto-start is for a human at a terminal. A `json` or `print` session is a
    // ONE-SHOT invocation whose prompt has to reach the model — and one of those
    // sessions is what this harness spawns for every agent. Without this guard
    // the extension swallowed its own subagents' prompts: the child printed a
    // session header, produced no message, and exited 0.
    if (!INTERACTIVE_MODES.includes(ctx.mode)) return { action: "continue" };
    if (event.source !== "interactive" && event.source !== "rpc") return { action: "continue" };
    if (event.streamingBehavior) return { action: "continue" };
    if (harness.running) {
      // The harness owns the session while a step is in flight. Letting the
      // message through to the model was wrong: the model is not who was
      // asked. Swallowing it without a word is worse, so say what is happening.
      ctx.ui.notify(
        "A harness workflow is running (" +
          `${harness.phase ?? "starting"}` +
          "). Your message was not sent to the model. " +
          "/harness-status shows it; /harness-abort stops it.",
        "info",
      );
      return { action: "handled" };
    }
    const text = event.text.trim();
    if (!text || text.startsWith("/")) return { action: "continue" };

    // Order matters: a waiting workflow gets the reply. Reversed, your answer
    // would start a second workflow instead.
    if (harness.run?.state.phase === "SUSPENDED" && !harness.busy) {
      harness.running = true;
      void answer(ctx, text).finally(() => {
        harness.running = false;
      });
      return { action: "handled" };
    }

    const file = await configPath(ctx.cwd);
    if (!file) return { action: "continue" };
    const config = await loadConfig(file);
    if (!config.autoStart) return { action: "continue" };
    harness.running = true;
    void start(ctx, text).finally(() => {
      harness.running = false;
    });
    return { action: "handled" };
  });

  pi.registerCommand("harness-run", {
    description: "Run a task through the harness workflow",
    handler: async (args, ctx) => {
      if (harness.busy) {
        ctx.ui.notify("A harness workflow is already running.", "warning");
        return;
      }
      const task = args.trim();
      if (!task) {
        ctx.ui.notify("Usage: /harness-run <what you want done>", "info");
        return;
      }
      await start(ctx, task);
    },
  });

  pi.registerCommand("harness-answer", {
    description: "Answer a workflow that is waiting for you",
    handler: async (args, ctx) => {
      // With no argument, `answer` opens a free-text box — so this must not
      // short-circuit on usage, or there is no way to answer without one.
      if (!(await answer(ctx, args.trim()))) {
        ctx.ui.notify("No harness workflow is waiting. Start one with /harness-run <task>, or /harness-status to see where it is.", "warning");
      }
    },
  });

  pi.registerCommand("harness-status", {
    description: "Show the phase the harness workflow is in",
    handler: async (_args, ctx) => {
      if (!harness.run) {
        ctx.ui.notify("No harness workflow has run in this session. Start one with /harness-run <task>.", "info");
        return;
      }
      const run = harness.run;
      const lines = [`${statusText(harness)} — stopped: ${run.stopped}`, run.reason];
      if (!isTerminal(run.state.phase)) lines.push(`steps so far: ${run.stepCount}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("harness-abort", {
    description: "Stop the harness workflow that is running",
    handler: async (_args, ctx) => {
      if (!harness.running || !harness.active) {
        ctx.ui.notify("No harness workflow is running.", "info");
        return;
      }
      harness.active.abort();
      ctx.ui.notify("Stopping the workflow. The agent in flight is being killed.", "info");
      // The run finishes on its own; nothing here waits for it.
      for (let i = 0; i < 300 && harness.running; i++) await new Promise((r) => setTimeout(r, 100));
      refresh(tolerantUi(ctx), harness);
      ctx.ui.notify("Workflow stopped.", "info");
    },
  });

  pi.registerCommand("harness-config", {
    description: "Show and validate the harness configuration",
    handler: async (_args, ctx) => {
      const file = await configPath(ctx.cwd);
      if (!file) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const checks = validateConfig(parseConfig(await fs.readFile(file, "utf8")), {
        availableTools: pi.getAllTools().map((t) => t.name),
        usableModels: modelChoices(ctx.modelRegistry, (m: PiModel) => ctx.modelRegistry.hasConfiguredAuth(m))
          .filter((c) => c.usable)
          .map((c) => c.label),
      });
      const failed = checks.filter((c) => !c.ok);
      ctx.ui.notify(
        failed.length === 0 ? `Configuration valid: ${checks.length} checks passed.\n${formatChecks(checks)}` : `${failed.length} finding(s):\n${formatChecks(checks)}`,
        failed.some((c) => c.severity === "error") ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("harness-model", {
    description: "Choose the model and effort for one agent",
    handler: async (args, ctx) => {
      const file = await configPath(ctx.cwd);
      if (!file) {
        ctx.ui.notify("No harness configuration found (harness.config.yaml).", "error");
        return;
      }
      const requested = args.trim().split(/\s+/).filter(Boolean)[0];
      if (requested && !(AGENT_NAMES as readonly string[]).includes(requested)) {
        ctx.ui.notify(`Unknown agent "${requested}". Expected one of ${AGENT_NAMES.join(", ")}.`, "error");
        return;
      }

      const pick = (agent: string): void => {
        // Only models Pi would actually run. Offering the whole catalog is how
        // you end up configuring one that fails minutes into a workflow.
        const choices = modelChoices(ctx.modelRegistry, (m: PiModel) => ctx.modelRegistry.hasConfiguredAuth(m));
        const usable = choices.filter((c) => c.usable);
        if (usable.length === 0) {
          ctx.ui.notify(
            `No usable model for "${agent}". Every model in the catalog is unauthenticated — run /models and authenticate a provider.`,
            "error",
          );
          return;
        }
        void ctx.ui
          .select(`Model for "${agent}" (${usable.length} of ${choices.length} usable)`, usable.map((c) => c.label))
          .then(async (choice) => {
            if (!choice) return;
            const model = findModelRef(choice, ctx.modelRegistry);
            if (!model) {
              ctx.ui.notify(`Model "${choice}" is not in Pi's catalog.`, "error");
              return;
            }
            const levels = supportedReasoningLevels(model);
            const effort = (await ctx.ui.select(`Reasoning effort for "${choice}"`, [...levels])) ?? levels[0];
            await fs.writeFile(
              file,
              setAgentFields(await fs.readFile(file, "utf8"), agent, {
                model: `${model.provider}/${model.id}`,
                reasoning: String(effort),
              }),
              "utf8",
            );
            ctx.ui.notify(`agents.${agent} set to ${model.provider}/${model.id} (${effort}).`, "info");
          });
      };

      if (requested) pick(requested);
      else void ctx.ui.select("Which agent?", [...AGENT_NAMES, "Cancel"]).then((choice) => {
        if (choice && choice !== "Cancel") pick(choice);
      });
    },
  });
}