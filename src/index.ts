import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { refreshConfig } from "./config.ts";
import { onBashResult } from "./debug.ts";
import { onBeforeAgentStart } from "./explain.ts";
import * as git from "./git.ts";
import { addText, getIndex, stripBlocks } from "./ladder.ts";
import { registerPlanTool } from "./plan-tool.ts";
import { gate, toolsFor } from "./policy.ts";
import { restoreRenderer } from "./render-setting.ts";
import { applyTools, currentStep, getTask, restore } from "./state.ts";
import { prepareMeStep, registerFinishTool } from "./steps.ts";
import type { Deps } from "./types.ts";

/** Hint-ladder level while the operator owns the step (step or debug phase), else null. */
function ladderLevel(): 0 | 1 | 2 | null {
	const task = getTask();
	if (!task?.current || (task.phase !== "step" && task.phase !== "debug")) return null;
	return currentStep()?.owner === "ME" ? task.current.hintLevel : null;
}

export default function whetstone(pi: ExtensionAPI): void {
	const agentDir = pi.pi?.getAgentDir?.() ?? join(homedir(), ".omp", "agent");
	const deps: Deps = { pi, agentDir, dataDir: join(agentDir, "whetstone"), now: () => Date.now() };

	registerPlanTool(deps);
	registerFinishTool(deps);
	registerCommands(deps);

	const resume = async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.agent.kind !== "main") return;
		const notify = (w: string) => ctx.ui.notify(w, "warning");
		const previous = getTask();
		restore(ctx.sessionManager.getBranch());
		await refreshConfig(await git.repoRoot(pi, ctx.cwd), agentDir, notify);
		const task = getTask();
		if (!task) {
			if (previous) {
				await applyTools(pi, previous.savedTools);
				await restoreRenderer(pi);
			}
			return;
		}
		const config = await refreshConfig(task.repoRoot, agentDir, notify);
		await applyTools(pi, toolsFor(task, config));
		const step = currentStep();
		if (step?.owner === "ME" && (task.phase === "step" || task.phase === "debug")) await prepareMeStep(deps, ctx, task, step);
		const where = task.current ? ` at step ${task.current.index + 1}` : "";
		ctx.ui.notify(`Whetstone: resumed task "${task.description}"${where} (${task.phase}).`, "info");
	};
	pi.on("session_start", resume);
	pi.on("session_switch", resume);

	pi.on("tool_call", (event, ctx) => gate({ toolName: event.toolName, input: event.input as Record<string, unknown> }, ctx, deps));

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "read" && ladderLevel() !== null) {
			for (const block of event.content) if (block.type === "text") addText(getIndex(), block.text);
		}
		return onBashResult(event, ctx, deps);
	});

	pi.on("assistant_message", event => {
		const level = ladderLevel();
		if (level === null) return undefined;
		return {
			content: event.message.content.map(b => (b.type === "text" ? { ...b, text: stripBlocks(b.text, level, getIndex()) } : b)),
		};
	});

	pi.on("before_agent_start", event => onBeforeAgentStart(event));

	pi.registerAssistantTextRenderer(({ text }) => {
		const level = ladderLevel();
		return level === null ? undefined : stripBlocks(text, level, getIndex());
	});
}
