import { expect, test } from "bun:test";
import { DEFAULTS, refreshConfig } from "../src/config.ts";
import { getTask, startStep, startTask } from "../src/state.ts";
import { makeRepo, makeStub, writeFile } from "./stub.ts";

function meStep(repo: string) {
	startTask({ id: "t1", description: "d", repoRoot: repo, repoKey: "local:r", savedTools: [] });
	getTask()!.steps = [{ title: "t", owner: "ME", files: ["src/a.ts"], estimatedLines: 1, verify: "true" }];
	startStep(0, DEFAULTS, Date.now());
}

const event = (reason: "prompt" | "revive" = "prompt") => ({ type: "before_agent_start", reason, prompt: "hi", systemPrompt: ["base prompt"] });

test("no task: the system prompt is left alone", async () => {
	const s = makeStub({ cwd: makeRepo() });
	expect(await s.fire("before_agent_start", event())).toBeUndefined();
});

test("ME step: an explanatory block that teaches is appended", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo);
	const r = await s.fire("before_agent_start", event());
	expect(r.systemPrompt[0]).toBe("base prompt");
	const block = r.systemPrompt.at(-1);
	expect(block).toContain("★ Insight");
	expect(block).toContain("teach");
});

test("explanatory: false turns the block off", async () => {
	const repo = makeRepo();
	writeFile(repo, ".omp/whetstone.yml", "explanatory: false\n");
	const s = makeStub({ cwd: repo });
	await refreshConfig(repo, s.agentDir);
	meStep(repo);
	expect(await s.fire("before_agent_start", event())).toBeUndefined();
});

test("a revived turn is left alone", async () => {
	const repo = makeRepo();
	const s = makeStub({ cwd: repo });
	meStep(repo);
	expect(await s.fire("before_agent_start", event("revive"))).toBeUndefined();
});
