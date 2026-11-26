import { expect, test } from "bun:test";
import { join } from "node:path";
import { readLog } from "../src/log.ts";
import { REASONS } from "../src/policy.ts";
import { __resetForTests, getTask, restore } from "../src/state.ts";
import { INITIAL_ACTIVE, makeRepo, makeStub, run, writeFile } from "./stub.ts";

const PLAN = {
	summary: "add a verbose flag",
	steps: [
		{ title: "Parse the flag", owner: "AI", files: ["src/a.ts"], estimatedLines: 10, verify: "bun test" },
		{ title: "Print verbose output", owner: "ME", files: ["src/b.ts"], estimatedLines: 10, verify: "bun test" },
	],
};

const QUESTIONS = JSON.stringify({ questions: [{ q: "Why?" }, { q: "What breaks?" }, { q: "Edge case?" }] });
const ALL_CORRECT = JSON.stringify({ scores: [1, 2, 3].map(() => ({ correct: true, feedback: "ok" })) });

test("full task: plan, AI step, staging gate, quiz, ME step, self-graded quiz, end", async () => {
	const repo = makeRepo({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n" });
	const s = makeStub({
		cwd: repo,
		ui: ["— Approve and start", "because", "nothing", "empty input"],
		ephemeral: [QUESTIONS, ALL_CORRECT],
	});

	await s.command("task add a verbose flag");
	expect(getTask()!.phase).toBe("planning");
	expect(s.active).not.toContain("edit");

	const approved = await s.tool("whet_submit_plan", PLAN);
	expect(approved.text).toContain("STEP 1/2 IS YOURS: Parse the flag");
	expect(getTask()!.phase).toBe("step");
	expect(s.active).toEqual(expect.arrayContaining(["edit", "write", "bash", "whet_finish_step"]));
	expect(s.active).not.toContain("whet_submit_plan");

	// persistence: a fresh process restores the same phase and step
	const saved = [...s.entries];
	__resetForTests();
	expect(restore(saved)).toBe(true);
	expect(getTask()!.phase).toBe("step");
	expect(getTask()!.current!.index).toBe(0);

	// the agent edits its declared file
	writeFile(repo, "src/a.ts", "export const a = 1;\nexport const verbose = process.argv.includes('--verbose');\n");
	const finished = await s.tool("whet_finish_step", { summary: "parse", filesChanged: ["src/a.ts"] });
	expect(finished.text).toBe("Step finished. Stop here; the operator reviews and stages now.");
	expect(getTask()!.phase).toBe("review");
	expect(s.active).not.toContain("edit");

	await s.command("next");
	expect(s.lastNote()).toBe("WHETSTONE: stage what you accept first — src/a.ts are not staged.");
	expect(getTask()!.phase).toBe("review");

	run(["git", "add", "src/a.ts"], repo);
	await s.command("next");
	expect(s.prompts[0]).toContain("verbose");
	const task = getTask()!;
	expect(task.current!.index).toBe(1);
	expect(task.phase).toBe("step");
	expect(s.messages.at(-1).content).toContain("STEP 2/2 IS THE OPERATOR'S");
	expect(s.active).toContain("bash");
	expect(s.active).not.toContain("edit");
	expect((await s.fire("tool_call", { toolName: "edit", input: { path: "src/b.ts" } }))?.reason).toBe(REASONS.meStep);

	// the operator writes step 2
	await s.command("done");
	expect(s.lastNote()).toBe("Whetstone: nothing changed in src/b.ts.");
	writeFile(repo, "src/b.ts", "export const b = 2;\nexport function log(msg: string) { console.error(msg); }\n");
	await s.command("done");
	expect(getTask()!.phase).toBe("review");
	expect(s.userMessages.at(-1)).toStartWith("WHETSTONE — the operator finished step 2 themselves.");
	expect(s.userMessages.at(-1)).toContain("+export function log");

	// no side turns: fixed questions, self-graded
	s.ctx.runEphemeralTurn = undefined;
	s.ui.push("a1", "a2", "a3", "Yes", "Yes", "Yes");
	run(["git", "add", "src/b.ts"], repo);
	await s.command("next");
	expect(getTask()).toBeNull();
	expect(s.active).toEqual(INITIAL_ACTIVE);
	expect(s.lastNote()).toBe("Whetstone: task complete — 2 steps, 1 of them yours. Commit when ready.");

	const log = await readLog(join(s.agentDir, "whetstone"));
	const events = log.map(r => r.event);
	expect(events[0]).toBe("task_start");
	expect(events.at(-1)).toBe("task_end");
	const ends = log.filter(r => r.event === "step_end");
	expect(ends.map(r => [r.owner, r.quizGraded, r.quizScore])).toEqual([
		["AI", "model", "3/3"],
		["ME", "self", "3/3"],
	]);
	expect(ends[0]!.lines).toBe(1);
});

test("session_start resumes an active task in the main session", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo, ui: ["— Approve and start"] });
	await s.command("task tweak a");
	await s.tool("whet_submit_plan", { summary: "s", steps: [{ title: "T", owner: "ME", files: ["src/a.ts"], estimatedLines: 1, verify: "true" }] });
	__resetForTests();
	await s.fire("session_start", { type: "session_start" });
	expect(getTask()!.phase).toBe("step");
	expect(s.lastNote()).toBe('Whetstone: resumed task "tweak a" at step 1 (step).');
});

test("a failing test command during a step enters debug mode until /whet found", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo, ui: ["— Approve and start"] });
	await s.command("task fix a");
	await s.tool("whet_submit_plan", { summary: "s", steps: [{ title: "T", owner: "AI", files: ["src/a.ts"], estimatedLines: 1, verify: "bun test" }] });
	const r = await s.fire("tool_result", { toolName: "bash", input: { command: "bun test" }, content: [], isError: true, details: { exitCode: 1 } });
	expect(r.additionalContext).toStartWith("WHETSTONE DEBUG.");
	expect(getTask()!.phase).toBe("debug");
	expect((await s.fire("tool_call", { toolName: "write", input: { path: "src/a.ts" } }))?.reason).toBe(REASONS.debug);
	await s.command("found the import path is wrong");
	expect(getTask()!.phase).toBe("step");
	expect(getTask()!.current!.debugger).toBe("me");
	expect(s.userMessages.at(-1)).toBe("The operator found the cause: the import path is wrong\nFix it within the step's files.");
});
