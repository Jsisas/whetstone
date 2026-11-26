import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configForRoot, configYaml, projectConfigPath, refreshConfig, userConfigPath } from "./config.ts";
import { DEBUG_CONTEXT, enterDebug } from "./debug.ts";
import * as git from "./git.ts";
import { logEvent, readLog } from "./log.ts";
import { planningBrief } from "./plan-tool.ts";
import { toolsFor } from "./policy.ts";
import { restoreRenderer } from "./render-setting.ts";
import { applyTools, currentStep, getTask, isEnabled, persist, setEnabled, setPhase, startTask } from "./state.ts";
import { renderStats } from "./stats.ts";
import { advance, aiBrief, finishTask } from "./steps.ts";
import type { Deps } from "./types.ts";

export const SUBCOMMANDS = ["help", "status", "task", "cases", "hint", "show", "solve", "do-it", "debug", "found", "done", "next", "skip", "stats", "off", "on", "init"];

export const HELP = `Whetstone — plan-first AI coding that keeps your skills sharp

Workflow
  1. /whet task <description>   The agent reads the code and submits a step plan. It cannot edit yet.
  2. Approve the plan            Flip any step between ME (you write it) and AI (the agent writes it).
  3. AI step                     The agent edits only the files the step declared, within the line budget.
                                 Test files stay locked until you write the cases: /whet cases.
  4. ME step                     You write the code; the agent pairs with you but cannot edit.
                                 Its code blocks are withheld: /whet hint for generic examples, /whet show for your code,
                                 /whet solve for the full solution, /whet do-it to hand the step to the agent.
  5. A test or build fails       Debug mode: the agent asks for your hypothesis. /whet found <cause> unlocks the fix.
  6. Review                      Stage what you accept (git add), then /whet next and answer a short quiz on the diff.
  7. Repeat until the plan is done; you commit.

Commands
  /whet task <desc>   start a task (planning mode)
  /whet cases         write test cases; unlocks test files in an AI step
  /whet hint          ME step: allow generic code examples
  /whet show          ME step: allow code about your own codebase
  /whet solve         ME step, after show: the agent writes out the full solution with a deep explanation
  /whet do-it         ME step, after solve: the agent writes it into the files; the step becomes AI
  /whet debug         enter debug mode manually
  /whet found <cause> name the cause of a failure; leaves debug mode
  /whet done          ME step: you are finished; the agent reviews your diff
  /whet next          staging check + quiz, then the next step
  /whet skip          skip the quiz (logged)
  /whet status        current task, step, owner, hint level
  /whet stats [all]   your ME/AI share, debugging, quizzes, skill-rust warnings (this repo or all)
  /whet off | on      disable/enable Whetstone for this session (off cancels the task)
  /whet init [user]   write a commented config: .omp/whetstone.yml, or with "user" ~/.omp/agent/whetstone/config.yml
  /whet help          this text

Always on (any session): nothing, unless alwaysOn: true — then protected paths and no agent git writes apply everywhere.
Inside a task the agent never runs git writes; staging and committing are yours.`;

const REVIEW_PROMPT = (n: number) =>
	[
		`WHETSTONE — the operator finished step ${n} themselves. Review this diff.`,
		"Say what is wrong or risky, what they missed, and what you would have done differently, and why.",
		"Do not edit anything. Code blocks are allowed here.",
	].join("\n");

const SOLVE_PROMPT = (n: number, title: string, files: string[]) =>
	[
		`WHETSTONE — the operator asked for the full solution to step ${n}: ${title}.`,
		`Files: ${files.join(", ")}. You still may not edit; they will type it in themselves.`,
		"Read whatever you need first. Then give the complete code for each file as fenced blocks, as diffs or whole functions, ready to transcribe.",
		"Then explain in depth: why each design decision and alternative, which best practices it follows and why they matter here, how this code fits the overall system (callers, data flow, invariants it keeps or relies on), and what it does at the root level (runtime behavior, edge cases, failure modes).",
		"End with how to verify it: the step's verify command and what passing looks like.",
	].join("\n");

function statusText(): string {
	const head = `Whetstone: ${isEnabled() ? "on" : "off"}. `;
	const task = getTask();
	if (!task) return `${head}No task. /whet task <desc> to start.`;
	const step = currentStep();
	const cur = task.current;
	if (!step || !cur) return `${head}"${task.description}" — ${task.phase}.`;
	const hints = ["none", "hint", "show", "solve"][cur.hintLevel];
	return `${head}"${task.description}" — ${task.phase}, step ${cur.index + 1}/${task.steps.length} (${step.owner}): ${step.title}; hints: ${hints}; tests ${cur.testsLocked ? "locked" : "unlocked"}.`;
}

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export function registerCommands(deps: Deps): void {
	const { pi } = deps;
	const error = (ctx: ExtensionContext, msg: string) => ctx.ui.notify(msg, "error");

	const inMeStep = () => {
		const t = getTask();
		return !!t && (t.phase === "step" || t.phase === "debug") && currentStep()?.owner === "ME";
	};

	const ladder = (level: 1 | 2): Handler => async (_args, ctx) => {
		const t = getTask();
		const cur = t?.current;
		const name = level === 1 ? "hint" : "show";
		if (!t || !cur || !inMeStep()) return error(ctx, "WHETSTONE: the hint ladder applies to your own (ME) steps.");
		if (cur.hintLevel >= level) return ctx.ui.notify(`Whetstone: already at ${name}.`, "info");
		cur.hintLevel = level;
		if (level === 1) cur.hintCount++;
		else cur.showCount++;
		await logEvent(deps, ctx, name, { step: cur.index + 1, level, msSinceStepStart: deps.now() - cur.startedAt });
		persist(pi);
		ctx.ui.notify(
			level === 1 ? "Whetstone: hint level — generic code examples allowed." : "Whetstone: show level — code about your codebase allowed.",
			"info",
		);
	};

	const solve: Handler = async (_args, ctx) => {
		const t = getTask();
		const cur = t?.current;
		const step = currentStep();
		if (!t || !cur || !step || !inMeStep()) return error(ctx, "WHETSTONE: /whet solve applies to your own (ME) steps.");
		if (cur.hintLevel < 2) return error(ctx, "WHETSTONE: climb the ladder first — /whet show, then /whet solve.");
		if (cur.hintLevel >= 3) return ctx.ui.notify("Whetstone: already at solve.", "info");
		cur.hintLevel = 3;
		cur.solveCount++;
		await logEvent(deps, ctx, "solve", { step: cur.index + 1, level: 3, msSinceStepStart: deps.now() - cur.startedAt });
		persist(pi);
		ctx.ui.notify("Whetstone: solve level — the agent writes out the solution; you type it in.", "info");
		await pi.sendUserMessage(SOLVE_PROMPT(cur.index + 1, step.title, step.files));
	};

	const doIt: Handler = async (_args, ctx) => {
		const t = getTask();
		const cur = t?.current;
		const step = currentStep();
		if (!t || !cur || !step || t.phase !== "step" || step.owner !== "ME") {
			return error(ctx, "WHETSTONE: /whet do-it hands your current ME step to the agent (not during debug or review).");
		}
		if (cur.hintLevel < 3) return error(ctx, "WHETSTONE: /whet solve first, then /whet do-it.");
		step.owner = "AI";
		const config = configForRoot(t.repoRoot);
		await logEvent(deps, ctx, "owner_flipped", { step: cur.index + 1, owner: "AI", reason: "do-it" });
		await restoreRenderer(pi);
		await applyTools(pi, toolsFor(t, config));
		persist(pi);
		ctx.ui.notify("Whetstone: step handed to the agent — it now counts as an AI step.", "info");
		pi.sendMessage(
			{ customType: "whetstone", display: true, content: aiBrief(t, config) },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
	};

	const handlers: Record<string, Handler> = {
		solve,
		"do-it": doIt,
		async help() {
			pi.sendMessage({ customType: "whetstone-help", display: true, excludeFromContext: true, content: HELP });
		},

		async status(_args, ctx) {
			ctx.ui.notify(statusText(), "info");
		},

		async task(args, ctx) {
			if (getTask()) return error(ctx, "WHETSTONE: finish the current task or /whet off first.");
			const description = args.trim();
			if (!description) return error(ctx, "WHETSTONE: describe the task, e.g. /whet task add retry to the HTTP client.");
			if (ctx.mode !== "tui") return error(ctx, "WHETSTONE: Whetstone needs the interactive TUI.");
			const root = await git.repoRoot(pi, ctx.cwd);
			if (!root) return error(ctx, "WHETSTONE: not inside a git repository.");
			if (!isEnabled()) return error(ctx, "WHETSTONE: Whetstone is off. /whet on first.");
			const config = await refreshConfig(root, deps.agentDir, w => ctx.ui.notify(w, "warning"));
			const task = startTask({
				id: crypto.randomUUID(),
				description,
				repoRoot: root,
				repoKey: await git.repoKey(pi, root),
				savedTools: pi.getActiveTools(),
			});
			await logEvent(deps, ctx, "task_start", { description });
			await applyTools(pi, toolsFor(task, config));
			persist(pi);
			ctx.ui.notify(`Whetstone: planning "${description}". The agent can only read until you approve a plan.`, "info");
			pi.sendMessage(
				{ customType: "whetstone", display: true, content: planningBrief(description, config) },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
		},

		async cases(_args, ctx) {
			const t = getTask();
			const cur = t?.current;
			if (!t || !cur || t.phase !== "step" || currentStep()?.owner !== "AI" || !cur.testsLocked) {
				return error(ctx, "WHETSTONE: no locked test files in this step.");
			}
			const text = await ctx.ui.editor("Your test cases", "# one case per line: input -> expected\n");
			const cases = (text ?? "").split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
			if (cases.length === 0) return ctx.ui.notify("WHETSTONE: no cases entered; tests stay locked.", "warning");
			cur.testsLocked = false;
			await logEvent(deps, ctx, "cases_entered", { step: cur.index + 1, lines: cases.length });
			persist(pi);
			await pi.sendUserMessage(`Test cases from the operator — implement tests for exactly these:\n${cases.join("\n")}`);
		},

		hint: ladder(1),
		show: ladder(2),

		async debug(_args, ctx) {
			const t = getTask();
			if (!t || t.phase !== "step") return error(ctx, "WHETSTONE: debug mode starts from an active step.");
			await enterDebug(deps, ctx, "(manual)");
			pi.sendMessage({ customType: "whetstone", display: false, content: DEBUG_CONTEXT }, { deliverAs: "nextTurn" });
		},

		async found(args, ctx) {
			const cause = args.trim();
			if (!cause) return error(ctx, "WHETSTONE: name the cause, e.g. /whet found the timestamp is parsed as local time.");
			const t = getTask();
			const cur = t?.current;
			if (!t || !cur || t.phase !== "debug") return error(ctx, "WHETSTONE: not in debug mode.");
			cur.debugger = cur.hintCount + cur.showCount + cur.solveCount > cur.hintsAtDebugStart ? "ai" : "me";
			await logEvent(deps, ctx, "found", { step: cur.index + 1, cause, debugger: cur.debugger });
			setPhase(t.returnPhase ?? "step");
			t.returnPhase = null;
			await applyTools(pi, toolsFor(t, configForRoot(t.repoRoot)));
			persist(pi);
			const owner = currentStep()?.owner;
			await pi.sendUserMessage(
				`The operator found the cause: ${cause}${owner === "AI" ? "\nFix it within the step's files." : "\nHelp them confirm it; they write the fix."}`,
			);
		},

		async done(_args, ctx) {
			const t = getTask();
			const cur = t?.current;
			const step = currentStep();
			if (!t || !cur || !step || t.phase !== "step" || step.owner !== "ME") return error(ctx, "WHETSTONE: /whet done ends your own (ME) step.");
			let diff: string;
			try {
				diff = await git.worktreeDiff(pi, t.repoRoot, step.files, git.DIFF_LIMIT, cur.baseTree);
			} catch (e) {
				if (!(e instanceof git.GitError)) throw e;
				return error(ctx, `WHETSTONE: could not diff ${step.files.join(", ")}: ${e.message}. The step stays active; fix git and run /whet done again.`);
			}
			if (!diff.trim()) return ctx.ui.notify(`Whetstone: nothing changed in ${step.files.join(", ")}.`, "warning");
			setPhase("review");
			await applyTools(pi, toolsFor(t, configForRoot(t.repoRoot)));
			await restoreRenderer(pi);
			persist(pi);
			await pi.sendUserMessage(`${REVIEW_PROMPT(cur.index + 1)}\n\n${diff}`);
		},

		async next(_args, ctx) {
			await advance(deps, ctx);
		},

		async skip(_args, ctx) {
			const t = getTask();
			if (!t || (t.phase !== "review" && t.phase !== "quiz")) return error(ctx, "WHETSTONE: nothing to skip.");
			t.quizResult = { score: "skipped", passed: true, skipped: true, graded: "none" };
			await logEvent(deps, ctx, "quiz_skip", { step: (t.current?.index ?? 0) + 1, reason: "operator" });
			persist(pi);
			ctx.ui.notify("Whetstone: quiz skipped. That is on the record. /whet next to continue.", "warning");
		},

		async stats(args, ctx) {
			const all = args.trim() === "all";
			const root = await git.repoRoot(pi, ctx.cwd);
			const repoKey = all || !root ? null : await git.repoKey(pi, root);
			const config = root ? configForRoot(root) : configForRoot("");
			const content = renderStats(await readLog(deps.dataDir), { repoKey, now: deps.now(), config });
			pi.sendMessage({ customType: "whetstone-stats", display: true, excludeFromContext: true, content });
		},

		async off(_args, ctx) {
			setEnabled(false);
			if (getTask()) await finishTask(deps, ctx, "off", "whet_off");
			else {
				await logEvent(deps, ctx, "whet_off", { step: null });
				persist(pi);
			}
			ctx.ui.notify("Whetstone off for this session. /whet on re-enables it.", "info");
		},

		async on(_args, ctx) {
			setEnabled(true);
			await logEvent(deps, ctx, "whet_on");
			persist(pi);
			ctx.ui.notify("Whetstone on.", "info");
		},

		async init(args, ctx) {
			let path: string;
			let root: string | null = null;
			if (args.trim() === "user") {
				path = userConfigPath(deps.agentDir);
			} else {
				root = await git.repoRoot(pi, ctx.cwd);
				if (!root) return error(ctx, "WHETSTONE: not inside a git repository. /whet init user writes the user config.");
				path = projectConfigPath(root);
			}
			if (existsSync(path)) return error(ctx, `WHETSTONE: ${path} already exists.`);
			await mkdir(dirname(path), { recursive: true });
			await Bun.write(path, configYaml());
			await refreshConfig(root, deps.agentDir, w => ctx.ui.notify(w, "warning"));
			ctx.ui.notify(`Whetstone: wrote ${path}.`, "info");
		},
	};

	pi.registerCommand("whet", {
		description: "Whetstone: plan-first AI coding that keeps your skills sharp — /whet help",
		getArgumentCompletions(prefix: string) {
			const p = prefix.trimStart();
			if (p.includes(" ")) return null;
			const items = SUBCOMMANDS.filter(s => s.startsWith(p)).map(s => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify(`${statusText()} Run /whet help for the workflow.`, "info");
				return;
			}
			const space = trimmed.search(/\s/);
			const sub = space === -1 ? trimmed : trimmed.slice(0, space);
			const rest = space === -1 ? "" : trimmed.slice(space + 1);
			const handler = handlers[sub];
			if (!handler) {
				ctx.ui.notify(`WHETSTONE: unknown subcommand "${sub}". /whet help lists them.`, "error");
				return;
			}
			await handler(rest, ctx);
		},
	});
}
