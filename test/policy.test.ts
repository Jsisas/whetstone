import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { extractWritePaths, REASONS } from "../src/policy.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import type { Phase, PlanStep } from "../src/types.ts";
import { makeRepo, makeStub, writeFile } from "./stub.ts";

function inStep(repo: string, steps: PlanStep[], phase: Phase = "step") {
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	const task = getTask()!;
	task.steps = steps;
	startStep(0, DEFAULTS, Date.now());
	task.phase = phase;
}

const aiStep = (files: string[]): PlanStep => ({ title: "t", owner: "AI", files, estimatedLines: 10, verify: "bun test" });

test("protected path is blocked inside a task with the exact reason", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	inStep(repo, [aiStep(["bun.lock"])]);
	expect(await s.fire("tool_call", { toolName: "write", input: { path: "bun.lock" } })).toEqual({
		block: true,
		reason: "WHETSTONE: bun.lock is protected. Edit it yourself.",
	});
});

test("protected path is blocked outside a task when alwaysOn is set", async () => {
	const repo = makeRepo();
	writeFile(repo, ".omp/whetstone.yml", "alwaysOn: true\n");
	const s = makeStub({ cwd: repo });
	expect(await s.fire("tool_call", { toolName: "edit", input: { input: "[.github/workflows/ci.yml#1A2B]\nPUT 1.=1:\n+x" } })).toEqual({
		block: true,
		reason: "WHETSTONE: .github/workflows/ci.yml is protected. Edit it yourself.",
	});
	expect(await s.fire("tool_call", { toolName: "bash", input: { command: "git push" } })).toEqual({ block: true, reason: REASONS.gitWrite });
});

test("outside a task without alwaysOn a protected write is allowed", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	expect(await s.fire("tool_call", { toolName: "write", input: { path: "bun.lock" } })).toBeUndefined();
});

test("a write outside the step's declared files is blocked", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	inStep(repo, [aiStep(["src/a.ts"])]);
	expect(await s.fire("tool_call", { toolName: "write", input: { path: "src/other.ts" } })).toEqual({
		block: true,
		reason: 'WHETSTONE: step 1 may only touch src/a.ts. "src/other.ts" is not in it.',
	});
});

test("eval and task are not available inside an AI step", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	inStep(repo, [aiStep(["src/a.ts"])]);
	for (const tool of ["eval", "task"]) {
		expect(await s.fire("tool_call", { toolName: tool, input: {} })).toEqual({
			block: true,
			reason: `WHETSTONE: ${tool} is not available inside a step.`,
		});
	}
});

test("read is allowed in every phase; edits are blocked outside AI steps", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	const expected: Record<string, string> = {
		planning: REASONS.planning,
		approval: REASONS.planning,
		debug: REASONS.debug,
		review: REASONS.review,
		quiz: REASONS.review,
	};
	for (const phase of Object.keys(expected) as Phase[]) {
		inStep(repo, [aiStep(["src/a.ts"])], phase);
		expect(await s.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } })).toBeUndefined();
		expect((await s.fire("tool_call", { toolName: "write", input: { path: "src/a.ts" } }))?.reason).toBe(expected[phase]);
	}
	inStep(repo, [{ ...aiStep(["src/a.ts"]), owner: "ME" }]);
	expect(await s.fire("tool_call", { toolName: "read", input: { path: "src/a.ts" } })).toBeUndefined();
	expect((await s.fire("tool_call", { toolName: "write", input: { path: "src/a.ts" } }))?.reason).toBe(REASONS.meStep);
});

test("a declared write is allowed in an AI step", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	inStep(repo, [aiStep(["src/a.ts"])]);
	expect(await s.fire("tool_call", { toolName: "write", input: { path: "src/a.ts" } })).toBeUndefined();
	expect(await s.fire("tool_call", { toolName: "write", input: { path: `${repo}/src/a.ts` } })).toBeUndefined();
	expect(await s.fire("tool_call", { toolName: "write", input: { path: "local://notes.md" } })).toBeUndefined();
});

test("hashline edit payload headers are the write paths", () => {
	expect(extractWritePaths("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[src/b.ts#FF00]\nCUT 2.=2" })).toEqual(["src/a.ts", "src/b.ts"]);
	expect(extractWritePaths("edit", { input: "[src/a.ts#1A2B]\nMV src/moved.ts" })).toEqual(["src/a.ts", "src/moved.ts"]);
	expect(extractWritePaths("edit", { input: "no headers" })).toBeNull();
});

test("locked test files are blocked until /whet cases", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo, ui: ["# one case per line\n1 -> 2\n"] });
	inStep(repo, [aiStep(["src/a.ts", "test/a.test.ts"])]);
	const write = { toolName: "write", input: { path: "test/a.test.ts" } };
	expect(await s.fire("tool_call", write)).toEqual({ block: true, reason: REASONS.testsLocked });
	await s.command("cases");
	expect(getTask()!.current!.testsLocked).toBe(false);
	expect(s.userMessages.at(-1)).toBe("Test cases from the operator — implement tests for exactly these:\n1 -> 2");
	expect(await s.fire("tool_call", write)).toBeUndefined();
});
