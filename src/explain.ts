import { configForRoot } from "./config.ts";
import { getTask, isEnabled } from "./state.ts";
import type { TaskState } from "./types.ts";

const BASE = [
	"# Whetstone explanatory mode",
	"The operator is using this session to learn as well as to ship. While a Whetstone task is active:",
	"- Before and after each substantive action, say why in one or two sentences: the reason, the alternative you rejected, the tradeoff.",
	"- Add short insight notes specific to this codebase or change (never generic programming advice), at most three per reply, in exactly this form:",
	"  `★ Insight ─────────────────────────────────────`",
	"  - point one",
	"  - point two",
	"  `─────────────────────────────────────────────────`",
	"- Name the concepts, patterns and invariants you rely on, so the operator can look them up.",
	"- Keep explanations in prose and lists; never put explanations inside fenced code blocks.",
].join("\n");

const ADDENDA = {
	planning: "While planning, explain why each step has the owner and boundaries you chose.",
	ai: "You own this step: narrate the plan before editing and summarize what changed and why after.",
	me: "This step is the operator's: teach. Ask what they think first, explain the concept, point at files and line ranges, and let them write the code. In debug, teach method: hypotheses, how to test each, what evidence rules one out.",
	review: "Review like a mentor: explain what the diff does and why each risk matters.",
};

export function explainBlock(task: TaskState): string | null {
	let addendum: string;
	switch (task.phase) {
		case "planning":
		case "approval":
			addendum = ADDENDA.planning;
			break;
		case "step":
			addendum = task.current && task.steps[task.current.index]?.owner === "AI" ? ADDENDA.ai : ADDENDA.me;
			break;
		case "debug":
			addendum = ADDENDA.me;
			break;
		case "review":
		case "quiz":
			addendum = ADDENDA.review;
			break;
	}
	return `${BASE}\n${addendum}`;
}

interface AgentStartEvent {
	reason: "prompt" | "revive";
	systemPrompt: string[];
}

export function onBeforeAgentStart(e: AgentStartEvent): { systemPrompt: string[] } | undefined {
	if (e.reason === "revive" || !isEnabled()) return undefined;
	const task = getTask();
	if (!task || !configForRoot(task.repoRoot).explanatory) return undefined;
	const block = explainBlock(task);
	return block ? { systemPrompt: [...e.systemPrompt, block] } : undefined;
}
