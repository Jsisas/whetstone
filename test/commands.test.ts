import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import { makeRepo, makeStub, run, writeFile } from "./stub.ts";

function meStep(repo: string, level: 0 | 1 | 2 | 3 = 0, files = ["src/a.ts"]) {
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	getTask()!.steps = [{ title: "t", owner: "ME", files, estimatedLines: 1, verify: "true" }];
	startStep(0, DEFAULTS, Date.now());
	getTask()!.current!.hintLevel = level;
}

/** Baseline the step the way enterStep does: the index tree at step start. */
function baseline(repo: string) {
	getTask()!.current!.baseTree = run(["git", "write-tree"], repo).stdout.trim();
}

test("/whet solve below show is refused", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo, 0);
	await s.command("solve");
	expect(s.notes.at(-1)).toMatchObject({ type: "error" });
	expect(s.lastNote()).toContain("climb the ladder");
	expect(getTask()!.current!.hintLevel).toBe(0);
	expect(s.userMessages).toHaveLength(0);
});

test("/whet solve after show raises the level and asks the agent for the full solution", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo, 2);
	await s.command("solve");
	const cur = getTask()!.current!;
	expect(cur.hintLevel).toBe(3);
	expect(cur.solveCount).toBe(1);
	expect(s.userMessages).toHaveLength(1);
	expect(s.userMessages[0]).toContain("full solution to step 1");
	expect(getTask()!.steps[0]!.owner).toBe("ME");

	await s.command("solve");
	expect(cur.solveCount).toBe(1);
	expect(s.userMessages).toHaveLength(1);
});

test("/whet do-it before solve is refused", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo, 2);
	await s.command("do-it");
	expect(s.notes.at(-1)).toMatchObject({ type: "error" });
	expect(s.lastNote()).toContain("/whet solve first");
	expect(getTask()!.steps[0]!.owner).toBe("ME");
});

test("/whet do-it after solve hands the step to the agent as an AI step", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo, 3);
	await s.command("do-it");
	expect(getTask()!.steps[0]!.owner).toBe("AI");
	expect(s.active).toContain("edit");
	expect(s.messages.at(-1)).toMatchObject({ customType: "whetstone", options: { triggerTurn: true } });
	expect(s.messages.at(-1).content).toContain("IS YOURS");
});

test("/whet done sends a staged post-baseline edit for review", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo);
	baseline(repo);
	writeFile(repo, "src/a.ts", "export const a = 2;\n");
	run(["git", "add", "src/a.ts"], repo);
	await s.command("done");
	expect(getTask()!.phase).toBe("review");
	expect(s.userMessages).toHaveLength(1);
	expect(s.userMessages[0]).toContain("finished step 1 themselves");
	expect(s.userMessages[0]).toContain("+export const a = 2;");
});

test("/whet done with no change keeps the step and warns", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo);
	baseline(repo);
	await s.command("done");
	expect(s.notes.at(-1)).toMatchObject({ type: "warning" });
	expect(s.lastNote()).toBe("Whetstone: nothing changed in src/a.ts.");
	expect(getTask()!.phase).toBe("step");
	expect(s.userMessages).toHaveLength(0);
});

test('/whet done reports a git failure instead of "nothing changed"', async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo);
	getTask()!.current!.baseTree = "0".repeat(40);
	writeFile(repo, "src/a.ts", "export const a = 2;\n");
	await s.command("done");
	expect(s.notes.at(-1)).toMatchObject({ type: "error" });
	expect(s.lastNote()).toContain("could not diff src/a.ts");
	expect(s.lastNote()).toContain("bad object");
	expect(getTask()!.phase).toBe("step");
	expect(s.userMessages).toHaveLength(0);
});

test("/whet done reviews an edit to a git-ignored declared file", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	writeFile(repo, ".git/info/exclude", "/docs/\n");
	meStep(repo, 0, ["docs/notes.md"]);
	baseline(repo);
	writeFile(repo, "docs/notes.md", "## What a message rate proves\n");
	await s.command("done");
	expect(getTask()!.phase).toBe("review");
	expect(s.userMessages[0]).toContain("+## What a message rate proves");
});

test("/whet done leaves ignored files under a declared directory out of the review", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	writeFile(repo, ".git/info/exclude", "/build/\n");
	meStep(repo, 0, ["src/a.ts", "build"]);
	baseline(repo);
	writeFile(repo, "build/out.js", "generated\n");
	writeFile(repo, "src/a.ts", "export const a = 2;\n");
	await s.command("done");
	expect(getTask()!.phase).toBe("review");
	expect(s.userMessages[0]).toContain("+export const a = 2;");
	expect(s.userMessages[0]).not.toContain("build/out.js");
});

test("/whet done matches a git-ignored declared file literally, not as a glob", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	writeFile(repo, ".git/info/exclude", "/app/\n");
	meStep(repo, 0, ["app/[id].ts"]);
	baseline(repo);
	writeFile(repo, "app/[id].ts", "export const route = 1;\n");
	writeFile(repo, "app/i.ts", "export const unrelated = 1;\n");
	await s.command("done");
	expect(s.userMessages[0]).toContain("+export const route = 1;");
	expect(s.userMessages[0]).not.toContain("unrelated");
});
