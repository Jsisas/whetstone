import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { REASONS } from "../src/policy.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import { makeRepo, makeStub, writeFile } from "./stub.ts";

async function bash(command: string, ui: unknown[] = [], verify = "true") {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo, ui });
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	getTask()!.steps = [{ title: "t", owner: "AI", files: ["src/a.ts"], estimatedLines: 1, verify }];
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

test.each([
	"git --git-dir .git commit -m x",
	"git --work-tree . commit -m x",
	"git branch -f main HEAD~1",
	"git branch feature",
	"git ci -m x",
	"git -c alias.x=commit x",
	"git update-index --add f",
	"git diff --output=src/a.ts",
	"git bisect start",
	"/usr/bin/git commit",
	"sh -c 'git commit -m x'",
	'bash -lc "git push"',
	"eval git commit",
	"sudo -u me git commit",
	"env -u FOO git commit",
	"timeout 5 git commit",
	"nohup git push",
	"xargs git commit",
	"find . -exec git add {} \\;",
])("git write variant is blocked: %s", async cmd => {
	expect((await bash(cmd)).result).toEqual(gitBlocked);
});

test.each([
	"git branch",
	"git branch --list 'f*'",
	"git log --oneline -5",
	"git -C sub status",
	"git stash list",
	"git remote -v",
	"git config --get user.name",
	"rg git src",
	"npm test",
	"bun test test/x.test.ts",
	"pytest -q 2>&1",
])("read or test command runs silently: %s", async cmd => {
	const r = await bash(cmd);
	expect(r.result).toBeUndefined();
	expect(r.uiLeft).toBe(0);
});

test.each([
	`node -e "1"`,
	`bun -e 'Bun.write("src/a.ts","x")'`,
	"npm install left-pad",
	"cargo add serde",
	"make clean",
])("interpreter or package-manager write asks the operator: %s", async cmd => {
	expect((await bash(cmd, [false])).result).toEqual({ block: true, reason: "WHETSTONE: command not approved." });
});

test("the step's verify command runs without asking, other commands do not", async () => {
	const ok = await bash("node scripts/check.js", [], "node scripts/check.js");
	expect(ok.result).toBeUndefined();
	expect(ok.uiLeft).toBe(0);
	expect((await bash("node scripts/other.js", [false], "node scripts/check.js")).result).toEqual({
		block: true,
		reason: "WHETSTONE: command not approved.",
	});
});

test("outside a task with alwaysOn a git write wrapped in sh -c is blocked", async () => {
	const repo = makeRepo();
	writeFile(repo, ".omp/whetstone.yml", "alwaysOn: true\n");
	const s = makeStub({ cwd: repo });
	expect(await s.fire("tool_call", { toolName: "bash", input: { command: "sh -c 'git commit -m x'" } })).toEqual(gitBlocked);
});
