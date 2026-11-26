import { dirname, join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configForRoot } from "./config.ts";
import * as git from "./git.ts";
import { addText, getIndex } from "./ladder.ts";
import { logEvent } from "./log.ts";
import { FINISH_STEP, readOnlyTools, toolsFor, toRepoRel } from "./policy.ts";
import { runQuiz } from "./quiz.ts";
import { enableRenderer, restoreRenderer } from "./render-setting.ts";
import { applyTools, currentStep, endTask, getTask, persist, setPhase, startStep } from "./state.ts";
import type { Deps, PlanStep, TaskState, WhetConfig } from "./types.ts";

export function aiBrief(task: TaskState, config: WhetConfig): string {
	const cur = task.current!;
	const step = task.steps[cur.index]!;
	const lines = [
		`WHETSTONE — STEP ${cur.index + 1}/${task.steps.length} IS YOURS: ${step.title}`,
		`Files you may touch: ${step.files.join(", ")}`,
		`Budget: ${config.budget.lines} changed lines.`,
		`Proves it works: ${step.verify}`,
	];
	if (cur.testsLocked) lines.push("Test files are locked until the operator writes test cases with /whet cases.");
	lines.push(`Run the verify command, then call ${FINISH_STEP}.`);
	return lines.join("\n");
}

export function meBrief(task: TaskState): string {
	const cur = task.current!;
	const step = task.steps[cur.index]!;
	return [
		`WHETSTONE — STEP ${cur.index + 1}/${task.steps.length} IS THE OPERATOR'S: ${step.title}`,
		"You may not edit any file. Work as their pair: ask what they plan to do, explain concepts,",
		"point at the files and lines that matter. Do not write the code for them.",
		"Code blocks you produce are withheld unless they quote code already in this repository.",
		`Files: ${step.files.join(", ")}`,
		`Proves it works: ${step.verify}`,
		"The operator runs /whet done when finished.",
	].join("\n");
}

/** Index the step's files for the hint ladder and turn on the reply renderer. */
export async function prepareMeStep(deps: Deps, ctx: ExtensionContext, task: TaskState, step: PlanStep): Promise<void> {
	for (const f of step.files) {
		try {
			const file = Bun.file(join(task.repoRoot, f));
			if (await file.exists()) addText(getIndex(), await file.text());
		} catch {
			// unreadable file: nothing to index
		}
	}
	if (!(await enableRenderer(deps.pi))) {
		ctx.ui.notify("Whetstone: reply renderer unavailable; withheld code may flash on screen while streaming.", "warning");
	}
}

/** Enter the current step (already set by startStep): baseline, tools, logging. Returns the brief. */
export async function enterStep(deps: Deps, ctx: ExtensionContext): Promise<string> {
	const task = getTask()!;
	const cur = task.current!;
	const step = task.steps[cur.index]!;
	const config = configForRoot(task.repoRoot);
	cur.baseTree = await git.writeTree(deps.pi, task.repoRoot);
	await applyTools(deps.pi, toolsFor(task, config));
	await logEvent(deps, ctx, "step_start", { step: cur.index + 1, owner: step.owner, files: step.files });
	if (step.owner === "AI") return aiBrief(task, config);
	await prepareMeStep(deps, ctx, task, step);
	return meBrief(task);
}

export function registerFinishTool(deps: Deps): void {
	const z = deps.pi.zod;
	deps.pi.registerTool({
		name: FINISH_STEP,
		label: "Whetstone: finish step",
		description: "Call when your Whetstone step is done and its verify command passes. The operator then reviews and stages it.",
		approval: "read",
		defaultInactive: true,
		parameters: z.object({
			summary: z.string().describe("What you changed and why"),
			filesChanged: z.array(z.string()).describe("Repo-relative paths you changed"),
		}),
		async execute(_id: string, params: { summary: string; filesChanged: string[] }, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const reject = (msg: string) => ({ isError: true, content: [{ type: "text" as const, text: `WHETSTONE_STEP_REJECTED: ${msg}` }] });
			const task = getTask();
			const step = currentStep();
			if (!task || task.phase !== "step" || !step || step.owner !== "AI" || !task.current) return reject("no AI step is active.");
			const n = task.current.index + 1;
			const declared = step.files.map(f => f.replace(/^\.\//, ""));
			for (const p of params.filesChanged) {
				const rel = toRepoRel(task.repoRoot, ctx.cwd, p);
				if (rel === null || !declared.includes(rel)) return reject(`"${p}" was not declared by step ${n}.`);
			}
			const config = configForRoot(task.repoRoot);
			const actual = await git.changedLines(deps.pi, task.repoRoot, declared, task.current.baseTree);
			if (actual > config.budget.lines) {
				return reject(`${actual} lines changed, budget is ${config.budget.lines}. Revert the excess or ask the operator to re-plan.`);
			}
			setPhase("review");
			await applyTools(deps.pi, [...readOnlyTools(config), "bash"]);
			persist(deps.pi);
			ctx.ui.notify(`Whetstone: step ${n} finished. Review the diff, stage what you accept, then /whet next.`, "info");
			return { content: [{ type: "text" as const, text: "Step finished. Stop here; the operator reviews and stages now." }] };
		},
	} as never);
}

function area(files: string[]): string {
	const dir = dirname(files[0] ?? ".");
	if (dir === "." || dir === "") return ".";
	return dir.split("/").slice(0, 2).join("/");
}

/** /whet next: staging gate, quiz, then the next step or the end of the task. */
export async function advance(deps: Deps, ctx: ExtensionContext): Promise<void> {
	const { pi } = deps;
	const task = getTask();
	if (!task) {
		ctx.ui.notify("WHETSTONE: no task. /whet task <desc> to start.", "error");
		return;
	}
	const step = currentStep();
	const cur = task.current;
	if (!step || !cur || (task.phase !== "review" && task.phase !== "quiz")) {
		const how = step?.owner === "ME" ? "/whet done" : "the agent calls whet_finish_step";
		ctx.ui.notify(`WHETSTONE: finish the step first (${how}).`, "error");
		return;
	}
	const config = configForRoot(task.repoRoot);
	const root = task.repoRoot;
	const files = step.files.map(f => f.replace(/^\.\//, ""));

	const unstaged = new Set(await git.unstagedFiles(pi, root));
	const notStaged = files.filter(f => unstaged.has(f));
	if (notStaged.length > 0) {
		ctx.ui.notify(`WHETSTONE: stage what you accept first — ${notStaged.join(", ")} are not staged.`, "error");
		return;
	}
	let changed: string[];
	if (cur.baseTree) {
		changed = await git.changedFiles(pi, root, files, cur.baseTree);
	} else {
		const staged = new Set(await git.stagedFiles(pi, root));
		changed = files.filter(f => staged.has(f) || unstaged.has(f));
	}

	if (changed.length === 0 || config.quiz.length === 0) {
		task.quizResult = { score: "0/0", passed: true, skipped: true, graded: "none" };
	} else if (!task.quizResult || (!task.quizResult.passed && !task.quizResult.skipped)) {
		setPhase("quiz");
		persist(pi);
		task.quizResult = await runQuiz(deps, ctx, task, config, changed);
		setPhase("review");
		persist(pi);
		if (!task.quizResult.passed) return;
	}

	const result = task.quizResult!;
	await logEvent(deps, ctx, "step_end", {
		step: cur.index + 1,
		owner: step.owner,
		files,
		area: area(files),
		lines: await git.changedLines(pi, root, files, cur.baseTree),
		debugger: cur.debugger,
		quizScore: result.score,
		quizSkipped: result.skipped,
		quizGraded: result.graded,
		hintLevel: cur.hintLevel,
		hintCount: cur.hintCount,
		showCount: cur.showCount,
		durationMs: deps.now() - cur.startedAt,
	});
	task.quizResult = null;
	if (step.owner === "ME") await restoreRenderer(pi);

	const next = cur.index + 1;
	if (next < task.steps.length) {
		startStep(next, config, deps.now());
		const brief = await enterStep(deps, ctx);
		persist(pi);
		pi.sendMessage({ customType: "whetstone", display: true, content: brief }, { deliverAs: "nextTurn", triggerTurn: true });
		return;
	}
	await finishTask(deps, ctx, "complete");
	const mine = task.steps.filter(s => s.owner === "ME").length;
	ctx.ui.notify(`Whetstone: task complete — ${task.steps.length} steps, ${mine} of them yours. Commit when ready.`, "info");
}

/** End the task: log, restore the operator's tools and renderer setting, persist. */
export async function finishTask(deps: Deps, ctx: ExtensionContext, reason: string, event: "task_end" | "whet_off" = "task_end"): Promise<void> {
	const task = getTask();
	if (!task) return;
	const extra: Record<string, unknown> = event === "task_end" ? { reason } : { step: task.current ? task.current.index + 1 : null };
	await logEvent(deps, ctx, event, extra);
	endTask();
	await applyTools(deps.pi, task.savedTools);
	await restoreRenderer(deps.pi);
	persist(deps.pi);
}
