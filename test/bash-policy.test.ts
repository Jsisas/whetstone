import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { REASONS } from "../src/policy.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import { makeRepo, makeStub } from "./stub.ts";

async function bash(command: string, ui: unknown[] = []) {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo, ui });
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	getTask()!.steps = [{ title: "t", owner: "AI", files: ["src/a.ts"], estimatedLines: 1, verify: "true" }];
	startStep(0, DEFAULTS, Date.now());
	const result = await s.fire("tool_call", { toolName: "bash", input: { command } });
	return { result, uiLeft: s.ui.length };
}

const gitBlocked = { block: true, reason: REASONS.gitWrite };

test("git commit is blocked", async () => {
	expect((await bash("git commit -m x")).result).toEqual(gitBlocked);
});

test("git status is allowed without asking", async () => {
	expect((await bash("git status")).result).toBeUndefined();
});

test("git push after cd is blocked", async () => {
	expect((await bash("cd x && git push")).result).toEqual(gitBlocked);
});

test("git -C sub add is blocked", async () => {
	expect((await bash("git -C sub add .")).result).toEqual(gitBlocked);
});

test("env-prefixed git add is blocked", async () => {
	expect((await bash("FOO=1 git add .")).result).toEqual(gitBlocked);
});

test("git inside command substitution is blocked", async () => {
	expect((await bash("echo $(git stash)")).result).toEqual(gitBlocked);
});

test("output redirection asks the operator", async () => {
	const r = await bash("echo hi > f", [true]);
	expect(r.result).toBeUndefined();
	expect(r.uiLeft).toBe(0);
});

test("a test command with 2>&1 runs silently", async () => {
	expect((await bash("pytest -q 2>&1")).result).toBeUndefined();
});

test("an unlisted command asks the operator", async () => {
	const r = await bash("rm -rf build", [true]);
	expect(r.result).toBeUndefined();
	expect(r.uiLeft).toBe(0);
});

test("a refused confirmation blocks the command", async () => {
	expect((await bash("rm -rf build", [false])).result).toEqual({ block: true, reason: "WHETSTONE: command not approved." });
});
