import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { commandWord, gitWriteSubcommand, needsConfirm, splitSegments } from "./bash-policy.ts";
import { ALWAYS_PROTECTED, cachedConfig, configForRoot, isInsidePluginDir, matchesAny, refreshConfig } from "./config.ts";
import * as git from "./git.ts";
import { logEvent } from "./log.ts";
import { currentStep, getTask, isEnabled } from "./state.ts";
import type { Deps, TaskState, WhetConfig } from "./types.ts";

export const READ_ONLY = [
	"read", "glob", "grep", "find", "ast_grep", "todo", "wait", "ask", "web_search",
	"recall", "reflect", "retain", "learn", "memory_edit",
];
export const WRITE_TOOLS = ["write", "edit", "ast_edit", "apply_patch"];
export const SUBMIT_PLAN = "whet_submit_plan";
export const FINISH_STEP = "whet_finish_step";

export function readOnlyTools(config: WhetConfig): string[] {
	return [...READ_ONLY, ...config.extraReadOnlyTools];
}

/** Active tool set for the task's current phase. */
export function toolsFor(task: TaskState, config: WhetConfig): string[] {
	const ro = readOnlyTools(config);
	switch (task.phase) {
		case "planning":
		case "approval":
			return [...ro, "bash", SUBMIT_PLAN];
		case "step":
			if (currentStep()?.owner === "AI") return [...ro, ...WRITE_TOOLS, "bash", FINISH_STEP];
			return [...ro, "bash"];
		default:
			return [...ro, "bash"];
	}
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

function patchPaths(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1]!.trim());
	return out;
}

function unquote(s: string): string {
	const t = s.trim();
	return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** Paths a write tool call would touch, or null when they cannot be determined. */
export function extractWritePaths(toolName: string, input: Record<string, unknown>): string[] | null {
	const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
	const strs = (v: unknown) => (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string") ? (v as string[]) : null);
	let paths: string[] | null = null;
	switch (toolName) {
		case "write": {
			const p = str(input.path);
			paths = p ? [p] : null;
			break;
		}
		case "edit": {
			const payload = str(input.input) ?? "";
			const moves = [...payload.matchAll(/^MV\s+(.+)$/gm)].map(m => unquote(m[1]!));
			const declared = strs(input.paths) ?? (str(input.path) ? [input.path as string] : null);
			if (declared) {
				paths = [...declared, ...moves];
				break;
			}
			const headers = [...payload.matchAll(/^\[([^\]#\n]+)#[0-9A-Za-z]{4}\]/gm)].map(m => m[1]!.trim());
			if (headers.length > 0) {
				paths = [...headers, ...moves];
				break;
			}
			const patch = patchPaths(payload);
			paths = patch.length > 0 ? patch : null;
			break;
		}
		case "ast_edit":
			paths = strs(input.paths);
			break;
		case "apply_patch": {
			const patch = patchPaths(str(input.input) ?? str(input.patch) ?? "");
			paths = patch.length > 0 ? patch : null;
			break;
		}
	}
	return paths;
}

/** Repo-relative POSIX path, or null for URLs and paths outside the repository. */
export function toRepoRel(root: string, cwd: string, p: string): string | null {
	if (URL_RE.test(p)) return null;
	const rel = relative(root, resolve(cwd, p));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
	return rel.split("\\").join("/");
}

/** Resolve symlinks of the path or, for a file not yet written, of its directory. */
function realish(abs: string): string {
	try {
		return realpathSync(abs);
	} catch {
		try {
			return join(realpathSync(dirname(abs)), basename(abs));
		} catch {
			return abs;
		}
	}
}

export function isProtected(rel: string | null, absPath: string, config: WhetConfig): boolean {
	if (rel !== null && matchesAny([...ALWAYS_PROTECTED, ...config.protectedPaths], rel)) return true;
	return isInsidePluginDir(realish(absPath));
}

export type GateResult = { block: true; reason: string } | undefined;

export const REASONS = {
	planning: "WHETSTONE: planning mode is read-only. Submit the plan with whet_submit_plan.",
	meStep: "WHETSTONE: this step is yours. I can read and answer questions, not edit.",
	debug: "WHETSTONE: a check failed. The operator names the cause with /whet found <cause> before anything is changed.",
	review: "WHETSTONE: this step is under review. The operator stages it, then runs /whet next.",
	gitWrite: "WHETSTONE: git writes are yours. Stage and commit yourself.",
	notApproved: "WHETSTONE: command not approved.",
	testsLocked: "WHETSTONE: test files are locked. The operator writes the cases first (/whet cases).",
} as const;

interface GateEvent {
	toolName: string;
	input: Record<string, unknown>;
}

/** Repository root per cwd, for sessions outside a task (git is asked once per cwd). */
const rootByCwd = new Map<string, string | null>();

export function __resetPolicyCache(): void {
	rootByCwd.clear();
}

/**
 * The single ordered tool gate. Order is the security model:
 * enabled → (task or alwaysOn) → protected paths → git writes → (task) → phase rules.
 */
export async function gate(event: GateEvent, ctx: ExtensionContext, deps: Deps): Promise<GateResult> {
	if (!isEnabled()) return undefined;
	const task = getTask();
	let config: WhetConfig;
	let root: string | null;
	if (task) {
		config = configForRoot(task.repoRoot);
		root = task.repoRoot;
	} else {
		root = rootByCwd.get(ctx.cwd) ?? null;
		if (!rootByCwd.has(ctx.cwd)) {
			root = await git.repoRoot(deps.pi, ctx.cwd);
			rootByCwd.set(ctx.cwd, root);
		}
		config = cachedConfig(root) ?? (await refreshConfig(root, deps.agentDir, w => ctx.ui.notify(w, "warning")));
		if (!config.alwaysOn) return undefined;
	}

	const block = async (reason: string): Promise<GateResult> => {
		await logEvent(deps, ctx, "tool_blocked", { tool: event.toolName, reason });
		return { block: true, reason };
	};

	const { toolName, input } = event;
	const writePaths = WRITE_TOOLS.includes(toolName) ? extractWritePaths(toolName, input) : null;

	// 3. protected paths
	for (const p of writePaths ?? []) {
		if (URL_RE.test(p)) continue;
		const abs = resolve(ctx.cwd, p);
		const rel = root ? toRepoRel(root, ctx.cwd, p) : relative(ctx.cwd, abs).split("\\").join("/");
		if (isProtected(rel, abs, config)) return block(`WHETSTONE: ${p} is protected. Edit it yourself.`);
	}

	// 4. git writes
	const isShell = toolName === "bash" || config.extraShellTools.includes(toolName);
	const command = isShell ? String(input.command ?? "") : "";
	if (isShell && splitSegments(command).some(s => gitWriteSubcommand(s) !== null)) return block(REASONS.gitWrite);

	// 5. outside a task nothing else applies
	if (!task) return undefined;

	// 6. task gate
	if (toolName === "bash") return bashGate(command, ctx, deps, config);

	const ro = readOnlyTools(config);
	if (ro.includes(toolName)) return undefined;

	const step = currentStep();
	switch (task.phase) {
		case "planning":
		case "approval":
			return toolName === SUBMIT_PLAN ? undefined : block(REASONS.planning);
		case "debug":
			return block(REASONS.debug);
		case "review":
		case "quiz":
			return block(REASONS.review);
		case "step":
			break;
	}
	if (!step || step.owner === "ME") return block(REASONS.meStep);

	if (toolName === FINISH_STEP) return undefined;
	if (!WRITE_TOOLS.includes(toolName)) return block(`WHETSTONE: ${toolName} is not available inside a step.`);
	if (!writePaths) return block(`WHETSTONE: cannot tell which files ${toolName} writes.`);
	const n = (task.current?.index ?? 0) + 1;
	const declared = step.files.map(f => f.replace(/^\.\//, ""));
	for (const p of writePaths) {
		if (p.startsWith("local://")) continue;
		const rel = toRepoRel(task.repoRoot, ctx.cwd, p);
		if (rel === null || !declared.includes(rel)) {
			return block(`WHETSTONE: step ${n} may only touch ${step.files.join(", ")}. "${p}" is not in it.`);
		}
		if (task.current?.testsLocked && matchesAny(config.testPatterns, rel)) return block(REASONS.testsLocked);
	}
	return undefined;
}

/** Bash inside a task: every segment that is not plainly read/test-only needs the operator's yes. */
async function bashGate(command: string, ctx: ExtensionContext, deps: Deps, config: WhetConfig): Promise<GateResult> {
	const pending = [...new Set(splitSegments(command).filter(s => needsConfirm(s, config)))];
	for (const segment of pending) {
		if (!ctx.hasUI) {
			await logEvent(deps, ctx, "tool_blocked", { tool: "bash", reason: REASONS.notApproved, command: segment });
			return { block: true, reason: REASONS.notApproved };
		}
		const ok = await ctx.ui.confirm("Whetstone: run this command?", segment);
		if (!ok) {
			await logEvent(deps, ctx, "bash_blocked", { command: segment, word: commandWord(segment) });
			return { block: true, reason: REASONS.notApproved };
		}
		await logEvent(deps, ctx, "bash_approved", { command: segment, word: commandWord(segment) });
	}
	return undefined;
}
