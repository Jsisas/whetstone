import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import { makeRepo, makeStub } from "./stub.ts";

function meStep(repo: string, level: 0 | 1 | 2 | 3 = 0) {
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	getTask()!.steps = [{ title: "t", owner: "ME", files: ["src/a.ts"], estimatedLines: 1, verify: "true" }];
	startStep(0, DEFAULTS, Date.now());
	getTask()!.current!.hintLevel = level;
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
