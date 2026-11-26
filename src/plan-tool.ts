import { isAbsolute, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { configForRoot, matchesAny } from "./config.ts";
import { logEvent } from "./log.ts";
import { isProtected, SUBMIT_PLAN, toRepoRel } from "./policy.ts";
import { applyTools, endTask, getTask, persist, startStep } from "./state.ts";
import { enterStep } from "./steps.ts";
import type { Deps, Owner, PlanStep, WhetConfig } from "./types.ts";

interface PlanParams {
	summary: string;
	steps: PlanStep[];
}

const APPROVE = "— Approve and start";
const REJECT = "— Reject and re-plan";
const CANCEL = "— Cancel task";

export function planningBrief(description: string, config: WhetConfig): string {
	const lines = [
		"WHETSTONE PLANNING MODE. You may read, search and ask, and nothing else.",
		`Produce a step plan and submit it with the ${SUBMIT_PLAN} tool. Rules:`,
		'- every step names an owner: "ME" (the operator writes the code) or "AI" (you do)',
		"- give the operator the steps that teach them the most; give yourself boilerplate and mechanical work",
		"- every step lists the repo-relative files it may touch; no step may touch a file it did not list",
		`- no step may exceed ${config.budget.lines} changed lines or ${config.budget.files} files`,
		"- every step names the exact command that proves it works",
	];
	if (config.corePaths.length > 0) lines.push(`- steps touching ${config.corePaths.join(", ")} must be owned by ME`);
	lines.push(`Task: ${description}`);
	return lines.join("\n");
}

function text(t: string, isError = false) {
	return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** First validation failure for the plan, or null. Normalizes file paths in place. */
export function validatePlan(steps: PlanStep[], root: string, config: WhetConfig): string | null {
	for (const [i, step] of steps.entries()) {
		const n = i + 1;
		if (step.files.length === 0) return `step ${n} lists no files.`;
		for (const [k, f] of step.files.entries()) {
			const rel = isAbsolute(f) || f.split(/[\\/]/).includes("..") ? null : toRepoRel(root, root, f);
			if (rel === null) return `step ${n}: "${f}" is outside the repository.`;
			if (isProtected(rel, resolve(root, rel), config)) return `step ${n}: "${f}" is protected.`;
			step.files[k] = rel;
		}
		if (step.estimatedLines > config.budget.lines) return `step ${n} estimates ${step.estimatedLines} lines, budget is ${config.budget.lines}.`;
		if (step.files.length > config.budget.files) return `step ${n} touches ${step.files.length} files, budget is ${config.budget.files}.`;
	}
	return null;
}

export function registerPlanTool(deps: Deps): void {
	const { pi } = deps;
	const z = pi.zod;
	pi.registerTool({
		name: SUBMIT_PLAN,
		label: "Whetstone: submit plan",
		description:
			"Submit the Whetstone step plan for the operator to approve. Each step has an owner (ME = operator, AI = you), the files it may touch, a line estimate and a verify command.",
		approval: "read",
		defaultInactive: true,
		parameters: z.object({
			summary: z.string().describe("One sentence: what this task changes"),
			steps: z
				.array(
					z.object({
						title: z.string(),
						owner: z.enum(["ME", "AI"]),
						files: z.array(z.string()).describe("Repo-relative paths this step may touch"),
						estimatedLines: z.number().int().min(0),
						verify: z.string().describe("Exact command that proves this step works"),
					}),
				)
				.min(1),
		}),
		async execute(_id: string, params: PlanParams, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const task = getTask();
			const rejected = async (msg: string) => {
				await logEvent(deps, ctx, "plan_rejected", { reason: "validation", message: msg });
				return text(`WHETSTONE_PLAN_REJECTED: ${msg} Fix it and call ${SUBMIT_PLAN} again.`, true);
			};
			if (!task || task.phase !== "planning") return rejected("no task is being planned.");
			const config = configForRoot(task.repoRoot);
			const steps: PlanStep[] = params.steps.map(s => ({ ...s, files: [...s.files] }));
			const invalid = validatePlan(steps, task.repoRoot, config);
			if (invalid) return rejected(invalid);

			const notes: string[] = [];
			for (const [i, step] of steps.entries()) {
				if (step.owner === "AI" && config.corePaths.length > 0 && step.files.some(f => matchesAny(config.corePaths, f))) {
					step.owner = "ME";
					notes.push(`Step ${i + 1} is now ME: it touches core paths.`);
					await logEvent(deps, ctx, "owner_flipped", { step: i + 1, owner: "ME", reason: "core" });
				}
			}
			task.steps = steps;
			task.summary = params.summary;
			task.phase = "approval";
			await logEvent(deps, ctx, "plan_submitted", { steps: steps.length, me: steps.filter(s => s.owner === "ME").length });
			persist(pi);

			if (!ctx.hasUI) {
				task.phase = "planning";
				persist(pi);
				return text("WHETSTONE_PLAN_REJECTED: no operator UI available.", true);
			}

			while (true) {
				const rows = steps.map((s, i) => `${i + 1}. ${s.owner}  ${s.title}  (${s.files.join(", ")})`);
				const choice = await ctx.ui.select(`Whetstone plan — ${params.summary}`, [...rows, APPROVE, REJECT, CANCEL], {
					helpText: "Pick a step to flip its owner between ME and AI.",
				});
				const row = choice === undefined ? -1 : rows.indexOf(choice);
				if (row !== -1) {
					const step = steps[row]!;
					step.owner = (step.owner === "ME" ? "AI" : "ME") as Owner;
					notes.push(`Operator set step ${row + 1} to ${step.owner}.`);
					await logEvent(deps, ctx, "owner_flipped", { step: row + 1, owner: step.owner, reason: "operator" });
					persist(pi);
					continue;
				}
				if (choice === APPROVE) {
					await logEvent(deps, ctx, "plan_approved", { steps: steps.length, me: steps.filter(s => s.owner === "ME").length });
					startStep(0, config, deps.now());
					const brief = await enterStep(deps, ctx);
					persist(pi);
					return text(["Plan approved.", ...notes, "", brief].join("\n"));
				}
				if (choice === REJECT) {
					const why = (await ctx.ui.input("What should change?"))?.trim();
					task.phase = "planning";
					await logEvent(deps, ctx, "plan_rejected", { reason: "operator", message: why ?? "" });
					persist(pi);
					return text(
						`WHETSTONE_PLAN_REJECTED: the operator rejected this plan. ${why ? `Operator: ${why}` : "Ask what to change, then submit again."}`,
						true,
					);
				}
				if (choice === undefined) {
					task.phase = "planning";
					await logEvent(deps, ctx, "plan_rejected", { reason: "dismissed", message: "" });
					persist(pi);
					return text("WHETSTONE_PLAN_REJECTED: the operator closed the plan picker. Ask what to change, then submit again.", true);
				}
				// cancel
				await logEvent(deps, ctx, "task_end", { reason: "cancelled" });
				endTask();
				await applyTools(pi, task.savedTools);
				persist(pi);
				return text("WHETSTONE: task cancelled by the operator. Stop working on it.");
			}
		},
	} as never);
}
