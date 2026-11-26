import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { matchesAny } from "./config.ts";
import { resetIndex } from "./ladder.ts";
import type { Phase, PlanStep, StepState, TaskState, WhetConfig } from "./types.ts";

// Module globals: shared by the main session and its subagents, so subagents inherit the gate.
let task: TaskState | null = null;
let enabled = true;

export const STATE_ENTRY = "whetstone-state";

export function getTask(): TaskState | null {
	return task;
}

export function isEnabled(): boolean {
	return enabled;
}

export function setEnabled(on: boolean): void {
	enabled = on;
}

export type TaskInit = Pick<TaskState, "id" | "description" | "repoRoot" | "repoKey" | "savedTools">;

export function startTask(init: TaskInit): TaskState {
	task = {
		...init,
		summary: "",
		phase: "planning",
		steps: [],
		current: null,
		returnPhase: null,
		quizResult: null,
	};
	resetIndex();
	return task;
}

export function endTask(): TaskState | null {
	const ended = task;
	task = null;
	resetIndex();
	return ended;
}

export function setPhase(phase: Phase): void {
	if (task) task.phase = phase;
}

export function currentStep(): PlanStep | null {
	return task?.current ? (task.steps[task.current.index] ?? null) : null;
}

export function startStep(index: number, config: WhetConfig, now: number): StepState {
	if (!task) throw new Error("Whetstone: no task");
	const step = task.steps[index];
	if (!step) throw new Error(`Whetstone: no step ${index + 1}`);
	task.current = {
		index,
		startedAt: now,
		testsLocked: step.owner === "AI" && step.files.some(f => matchesAny(config.testPatterns, f)),
		hintLevel: 0,
		debugger: null,
		hintCount: 0,
		showCount: 0,
		solveCount: 0,
		debugStartedAt: null,
		hintsAtDebugStart: 0,
		baseTree: null,
	};
	task.phase = "step";
	task.returnPhase = null;
	task.quizResult = null;
	resetIndex();
	return task.current;
}

/** Activate the subset of `names` that exists in this session. */
export async function applyTools(pi: ExtensionAPI, names: readonly string[]): Promise<void> {
	const known = new Set(pi.getAllTools().map(t => t.name));
	await pi.setActiveTools([...new Set(names)].filter(n => known.has(n)));
}

export function persist(pi: ExtensionAPI): void {
	pi.appendEntry(STATE_ENTRY, { v: 1, enabled, task });
}

interface StateEntry {
	type?: string;
	customType?: string;
	data?: { v?: number; enabled?: boolean; task?: TaskState | null };
}

/** Restore from session entries (newest `whetstone-state` wins). Returns whether one was found. */
export function restore(entries: readonly unknown[]): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as StateEntry;
		if (e?.type !== "custom" || e.customType !== STATE_ENTRY || !e.data) continue;
		enabled = e.data.enabled !== false;
		task = e.data.task ? structuredClone(e.data.task) : null;
		if (task?.phase === "quiz") task.phase = "review";
		resetIndex();
		return true;
	}
	enabled = true;
	task = null;
	resetIndex();
	return false;
}

export function __resetForTests(): void {
	task = null;
	enabled = true;
	resetIndex();
}
