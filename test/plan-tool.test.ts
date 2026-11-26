import { expect, test } from "bun:test";
import { getTask } from "../src/state.ts";
import { INITIAL_ACTIVE, makeRepo, makeStub, writeFile } from "./stub.ts";

const step = (over: Record<string, unknown> = {}) => ({
	title: "Add the flag",
	owner: "AI",
	files: ["src/a.ts"],
	estimatedLines: 20,
	verify: "bun test",
	...over,
});

async function planning(ui: unknown[] = [], setup?: (repo: string) => void) {
	const repo = makeRepo();
	setup?.(repo);
	const s = makeStub({ cwd: repo, ui });
	await s.command("task add a --verbose flag");
	return s;
}

test("/whet task starts planning with a read-only tool set and the brief", async () => {
	const s = await planning();
	expect(getTask()!.phase).toBe("planning");
	expect(s.active).toContain("whet_submit_plan");
	expect(s.active).not.toContain("edit");
	const brief = s.messages.at(-1);
	expect(brief.content).toStartWith("WHETSTONE PLANNING MODE.");
	expect(brief.content).toEndWith("Task: add a --verbose flag");
	expect(brief.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
});

test("a step over the line budget is rejected", async () => {
	const s = await planning();
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step({ estimatedLines: 400 })] });
	expect(r.isError).toBe(true);
	expect(r.text).toBe("WHETSTONE_PLAN_REJECTED: step 1 estimates 400 lines, budget is 150. Fix it and call whet_submit_plan again.");
	expect(getTask()!.phase).toBe("planning");
});

test("an absolute path is rejected as outside the repository", async () => {
	const s = await planning();
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step({ files: ["/etc/passwd"] })] });
	expect(r.text).toStartWith('WHETSTONE_PLAN_REJECTED: step 1: "/etc/passwd" is outside the repository.');
});

test("an AI step touching core paths is flipped to ME", async () => {
	const s = await planning(["— Approve and start"], repo => writeFile(repo, ".omp/whetstone.yml", 'corePaths: ["src/core/**"]\n'));
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step({ files: ["src/core/engine.ts"] })] });
	expect(r.isError).toBe(false);
	expect(r.text).toContain("Step 1 is now ME: it touches core paths.");
	expect(getTask()!.steps[0]!.owner).toBe("ME");
});

test("approving starts step 1 and returns its brief", async () => {
	const s = await planning(["— Approve and start"]);
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step()] });
	expect(r.text).toStartWith("Plan approved.");
	expect(r.text).toContain("WHETSTONE — STEP 1/1 IS YOURS: Add the flag");
	expect(getTask()!.phase).toBe("step");
	expect(s.active).toContain("edit");
	expect(s.active).toContain("whet_finish_step");
});

test("flipping an owner in the picker changes the step", async () => {
	const s = await planning(["1. AI  Add the flag  (src/a.ts)", "— Approve and start"]);
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step()] });
	expect(r.text).toContain("Operator set step 1 to ME.");
	expect(r.text).toContain("IS THE OPERATOR'S");
});

test("cancelling ends the task and restores the operator's tools", async () => {
	const s = await planning(["— Cancel task"]);
	const r = await s.tool("whet_submit_plan", { summary: "s", steps: [step()] });
	expect(r.text).toBe("WHETSTONE: task cancelled by the operator. Stop working on it.");
	expect(getTask()).toBeNull();
	expect(s.active).toEqual(INITIAL_ACTIVE);
});
