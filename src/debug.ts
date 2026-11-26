import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { commandWord, splitSegments } from "./bash-policy.ts";
import { configForRoot } from "./config.ts";
import { logEvent } from "./log.ts";
import { readOnlyTools } from "./policy.ts";
import { applyTools, getTask, persist } from "./state.ts";
import type { Deps } from "./types.ts";

export const DEBUG_CONTEXT = [
	"WHETSTONE DEBUG. A check the operator relies on just failed.",
	"Do not propose a fix, do not change any file, do not name the cause yourself.",
	"Ask the operator what they think is going wrong, and help them test that hypothesis",
	"with questions and read-only investigation. The fix unlocks when they run /whet found <cause>.",
].join("\n");

interface BashResultEvent {
	toolName: string;
	input: Record<string, unknown>;
	isError?: boolean;
	details?: unknown;
}

function exitCode(details: unknown): number {
	if (details && typeof details === "object" && "exitCode" in details && typeof details.exitCode === "number") return details.exitCode;
	return 0;
}

/** Switch the current step into debug mode. */
export async function enterDebug(deps: Deps, ctx: ExtensionContext, command: string): Promise<void> {
	const task = getTask();
	const cur = task?.current;
	if (!task || !cur) return;
	task.returnPhase = "step";
	task.phase = "debug";
	cur.debugStartedAt = deps.now();
	cur.hintsAtDebugStart = cur.hintCount + cur.showCount + cur.solveCount;
	await applyTools(deps.pi, [...readOnlyTools(configForRoot(task.repoRoot)), "bash"]);
	await logEvent(deps, ctx, "debug_start", { step: cur.index + 1, command });
	persist(deps.pi);
	ctx.ui.notify("Whetstone: a check failed. What do you think the cause is? /whet found <cause> when you know.", "warning");
}

/** tool_result: a failing test/build command during a step starts debug mode. */
export async function onBashResult(event: BashResultEvent, ctx: ExtensionContext, deps: Deps): Promise<{ additionalContext: string } | undefined> {
	const task = getTask();
	if (!task || task.phase !== "step" || event.toolName !== "bash") return undefined;
	const config = configForRoot(task.repoRoot);
	const failed = exitCode(event.details) !== 0 || event.isError === true;
	if (!failed) return undefined;
	const command = String(event.input.command ?? "");
	const words = splitSegments(command).map(commandWord);
	if (!words.some(w => w !== null && config.testCommands.includes(w))) return undefined;
	await enterDebug(deps, ctx, command);
	return { additionalContext: DEBUG_CONTEXT };
}
