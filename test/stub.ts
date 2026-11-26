import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as z from "zod";
import whetstone from "../src/index.ts";
import { __resetConfigCache } from "../src/config.ts";
import { __resetPolicyCache } from "../src/policy.ts";
import { __resetForTests } from "../src/state.ts";

export const BUILTIN_TOOLS = [
	"read", "glob", "grep", "find", "ast_grep", "todo", "wait", "ask", "web_search",
	"write", "edit", "ast_edit", "apply_patch", "bash", "eval", "task", "lsp",
];
export const INITIAL_ACTIVE = ["read", "bash", "edit", "write", "eval", "task", "lsp"];

export function run(cmd: string[], cwd: string): { stdout: string; stderr: string; code: number } {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
	return { stdout: p.stdout.toString(), stderr: p.stderr.toString(), code: p.exitCode ?? -1 };
}

/** A temp git repo with an initial commit of `files`. */
export function makeRepo(files: Record<string, string> = { "src/a.ts": "export const a = 1;\n" }): string {
	const dir = mkdtempSync(join(tmpdir(), "whet-repo-"));
	run(["git", "init", "-q", "-b", "main"], dir);
	run(["git", "config", "user.email", "t@example.com"], dir);
	run(["git", "config", "user.name", "Test"], dir);
	for (const [rel, text] of Object.entries(files)) writeFile(dir, rel, text);
	run(["git", "add", "-A"], dir);
	run(["git", "commit", "-q", "-m", "init"], dir);
	return dir;
}

export function writeFile(root: string, rel: string, text: string): void {
	mkdirSync(dirname(join(root, rel)), { recursive: true });
	writeFileSync(join(root, rel), text);
}

export interface StubOptions {
	cwd: string;
	agentDir?: string;
	/** Answers for ui.select / confirm / editor / input, consumed in order. */
	ui?: unknown[];
	/** Replies for ctx.runEphemeralTurn; null leaves it undefined. */
	ephemeral?: string[] | null;
	agentKind?: "main" | "sub";
	hasUI?: boolean;
	/** Exec overrides keyed by `args.join(" ")`; everything else runs for real. */
	execQueue?: Record<string, { stdout: string; stderr?: string; code: number }[]>;
}

type Fn = (...args: any[]) => any;

export function makeStub(opts: StubOptions) {
	__resetForTests();
	__resetConfigCache();
	__resetPolicyCache();
	const agentDir = opts.agentDir ?? mkdtempSync(join(tmpdir(), "whet-agent-"));
	const handlers = new Map<string, Fn[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const entries: any[] = [];
	const activeCalls: string[][] = [];
	const messages: any[] = [];
	const userMessages: string[] = [];
	const notes: { msg: string; type?: string }[] = [];
	const ui = [...(opts.ui ?? [])];
	const ephemeral = opts.ephemeral === null ? null : [...(opts.ephemeral ?? [])];
	const prompts: string[] = [];
	let renderer: Fn | undefined;
	let active = [...INITIAL_ACTIVE];

	const nextUi = (kind: string, title: string) => {
		if (ui.length === 0) throw new Error(`unexpected ${kind}: ${title}`);
		return ui.shift();
	};

	const pi: any = {
		zod: z,
		logger: { warn() {}, info() {}, error() {}, debug() {} },
		pi: { getAgentDir: () => agentDir, settings: {} },
		on(event: string, fn: Fn) {
			handlers.set(event, [...(handlers.get(event) ?? []), fn]);
		},
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		registerAssistantTextRenderer(fn: Fn) {
			renderer = fn;
		},
		async setActiveTools(names: string[]) {
			activeCalls.push(names);
			active = names;
		},
		getActiveTools: () => [...active],
		getAllTools: () => [...BUILTIN_TOOLS, ...tools.keys()].map(name => ({ name })),
		sendMessage(msg: any, options?: any) {
			messages.push({ ...msg, options });
		},
		async sendUserMessage(content: string) {
			userMessages.push(content);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data: structuredClone(data) });
		},
		async exec(cmd: string, args: string[], o?: { cwd?: string }) {
			const queue = opts.execQueue?.[args.join(" ")];
			if (queue && queue.length > 0) {
				const r = queue.shift()!;
				return { stdout: r.stdout, stderr: r.stderr ?? "", code: r.code, killed: false };
			}
			return { ...run([cmd, ...args], o?.cwd ?? opts.cwd), killed: false };
		},
	};

	const ctx: any = {
		mode: "tui",
		hasUI: opts.hasUI ?? true,
		cwd: opts.cwd,
		agent: { kind: opts.agentKind ?? "main", id: "Main", name: "main", depth: 0 },
		sessionManager: { getBranch: () => entries, getSessionId: () => "s1" },
		ui: {
			select: async (title: string) => nextUi("select", title),
			confirm: async (title: string, msg: string) => nextUi("confirm", `${title} ${msg}`),
			editor: async (title: string) => nextUi("editor", title),
			input: async (title: string) => nextUi("input", title),
			notify: (msg: string, type?: string) => notes.push({ msg, type }),
		},
		runEphemeralTurn:
			ephemeral === null
				? undefined
				: async ({ promptText }: { promptText: string }) => {
						prompts.push(promptText);
						if (ephemeral.length === 0) throw new Error("no ephemeral reply queued");
						return { replyText: ephemeral.shift()! };
					},
	};

	whetstone(pi);

	return {
		pi,
		ctx,
		agentDir,
		entries,
		activeCalls,
		messages,
		userMessages,
		notes,
		ui,
		prompts,
		get active() {
			return active;
		},
		get renderer() {
			return renderer;
		},
		/** Run every handler for `event`; returns the last non-undefined result. */
		async fire(event: string, payload: any, c: any = ctx) {
			let result: any;
			for (const fn of handlers.get(event) ?? []) {
				const r = await fn(payload, c);
				if (r !== undefined) result = r;
			}
			return result;
		},
		async command(args: string) {
			await commands.get("whet").handler(args, ctx);
		},
		async tool(name: string, params: unknown): Promise<{ text: string; isError: boolean }> {
			const r = await tools.get(name).execute("call-1", params, undefined, undefined, ctx);
			return { text: r.content.map((b: any) => b.text).join(""), isError: r.isError === true };
		},
		lastNote(): string {
			return notes.at(-1)?.msg ?? "";
		},
	};
}
