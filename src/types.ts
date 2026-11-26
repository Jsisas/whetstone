import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type Owner = "ME" | "AI";
export type Phase = "planning" | "approval" | "step" | "debug" | "review" | "quiz";

export interface PlanStep {
	title: string;
	owner: Owner;
	files: string[];
	estimatedLines: number;
	verify: string;
}

export interface StepState {
	index: number;
	startedAt: number;
	testsLocked: boolean;
	hintLevel: 0 | 1 | 2;
	debugger: "me" | "ai" | null;
	hintCount: number;
	showCount: number;
	debugStartedAt: number | null;
	/** hintCount + showCount when debug mode began */
	hintsAtDebugStart: number;
	/** `git write-tree` of the index when the step began; diffs and budgets are measured against it. */
	baseTree: string | null;
}

export interface QuizResult {
	score: string;
	passed: boolean;
	skipped: boolean;
	graded: "model" | "self" | "none";
}

export interface TaskState {
	id: string;
	description: string;
	summary: string;
	phase: Phase;
	repoRoot: string;
	repoKey: string;
	steps: PlanStep[];
	current: StepState | null;
	returnPhase: Phase | null;
	quizResult: QuizResult | null;
	savedTools: string[];
}

export interface WhetConfig {
	alwaysOn: boolean;
	explanatory: boolean;
	corePaths: string[];
	testPatterns: string[];
	protectedPaths: string[];
	budget: { lines: number; files: number };
	quiz: { length: number; passRatio: number };
	allowedCommands: string[];
	testCommands: string[];
	extraReadOnlyTools: string[];
	extraShellTools: string[];
	targetMeRatio: number;
	rustWeeks: number;
}

export type LogEvent =
	| "task_start"
	| "plan_submitted"
	| "plan_rejected"
	| "plan_approved"
	| "owner_flipped"
	| "step_start"
	| "cases_entered"
	| "hint"
	| "show"
	| "bash_approved"
	| "bash_blocked"
	| "tool_blocked"
	| "debug_start"
	| "found"
	| "step_end"
	| "quiz_pass"
	| "quiz_fail"
	| "quiz_skip"
	| "task_end"
	| "whet_off"
	| "whet_on";

export interface LogRecord {
	ts: string;
	repo: string;
	session: string;
	task: string | null;
	event: LogEvent;
	[k: string]: unknown;
}

/** Shared runtime dependencies; tests inject a clock and a temp data dir. */
export interface Deps {
	pi: ExtensionAPI;
	agentDir: string;
	dataDir: string;
	now: () => number;
}
