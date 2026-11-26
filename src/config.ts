import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { WhetConfig } from "./types.ts";

export const DEFAULTS: WhetConfig = {
	alwaysOn: false,
	explanatory: true,
	corePaths: [],
	testPatterns: [
		"**/test_*.py",
		"**/*_test.py",
		"**/tests/**",
		"**/test/**",
		"**/__tests__/**",
		"**/spec/**",
		"**/*.test.*",
		"**/*.spec.*",
		"**/*_test.go",
		"**/*_test.rs",
		"**/*Test.java",
		"**/*Test.kt",
		"**/*Tests.cs",
	],
	protectedPaths: [],
	budget: { lines: 150, files: 3 },
	quiz: { length: 3, passRatio: 0.67 },
	allowedCommands: [
		"cd", "ls", "cat", "head", "tail", "wc", "rg", "grep", "pwd", "which", "echo", "git", "diff",
		"pytest", "tox", "mypy", "pyright", "ruff check", "ruff format --check", "uv run pytest", "uv run mypy", "uv run ruff check",
		"npm test", "npm run", "pnpm test", "pnpm run", "yarn test", "yarn run", "bun test", "bun run", "bunx tsc", "npx tsc",
		"npx eslint", "npx vitest", "npx jest", "npx prettier --check", "tsc", "eslint", "prettier --check", "biome check",
		"biome lint", "vitest", "jest", "deno test", "deno check", "deno lint", "cargo test", "cargo check", "cargo build",
		"cargo clippy", "cargo fmt --check", "go test", "go build", "go vet", "gradle test", "gradle build", "./gradlew test",
		"./gradlew build", "mvn test", "mvn verify", "./mvnw test", "./mvnw verify", "make test", "make check", "ctest",
		"dotnet test", "dotnet build",
	],
	testCommands: [
		"pytest", "uv", "tox", "ruff", "mypy", "pyright", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "deno",
		"tsc", "eslint", "vitest", "jest", "cargo", "go", "gradle", "./gradlew", "mvn", "./mvnw", "make", "ctest", "dotnet",
	],
	extraReadOnlyTools: [],
	extraShellTools: [],
	targetMeRatio: 0.4,
	rustWeeks: 4,
};

const EXPLAIN: Record<string, string> = {
	alwaysOn: "Apply protected paths and the no-agent-git-writes rule in every session, not only inside /whet task.",
	explanatory: "While a task is active, the agent explains why and adds ★ Insight notes.",
	corePaths: "Globs for code you must own: plan steps touching them are always ME steps.",
	testPatterns: "Globs that identify test files; they stay locked in AI steps until you run /whet cases.",
	protectedPaths: "Extra globs the agent may never write (lockfiles, CI, migrations and agent config are always protected).",
	budget: "Per-step limits: changed lines and number of files.",
	"budget.lines": "Maximum changed lines per step.",
	"budget.files": "Maximum files per step.",
	quiz: "The quiz on each step's staged diff.",
	"quiz.length": "Questions per quiz; 0 disables quizzes.",
	"quiz.passRatio": "Share of questions you must get right to advance.",
	allowedCommands: "Command prefixes (one or more words, e.g. \"npm test\") the agent may run without asking you; anything else (or any > redirection) needs your confirmation.",
	testCommands: "Commands whose failure starts debug mode.",
	extraReadOnlyTools: "Additional omp tools allowed in every phase (they must not write files).",
	extraShellTools: "Additional tools whose `command` argument is checked like bash for git writes.",
	targetMeRatio: "Share of steps you want to own; /whet stats compares against it.",
	rustWeeks: "Warn in /whet stats when an area had no ME step for this many weeks.",
};

/** Paths the agent may never write, whatever the config says. */
export const ALWAYS_PROTECTED = [
	".github/**",
	".gitlab-ci.yml",
	".omp/**",
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	"uv.lock",
	"poetry.lock",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
	"Cargo.lock",
	"go.sum",
	"**/migrations/**",
	"**/alembic/versions/**",
];

function realOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** The plugin's own directory; writes below it are always protected. */
export const PLUGIN_DIR = realOr(join(import.meta.dir, ".."));

export function isInsidePluginDir(absPath: string): boolean {
	return absPath === PLUGIN_DIR || absPath.startsWith(PLUGIN_DIR + sep);
}

const globCache = new Map<string, RegExp>();

function compileGlob(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i]!;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				if (pattern[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 2;
				} else {
					re += ".*";
					i += 1;
				}
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/** Match a root-relative POSIX path against a glob (`**`, `*`, `?`). */
export function matchGlob(pattern: string, relPath: string): boolean {
	let re = globCache.get(pattern);
	if (!re) {
		re = compileGlob(pattern);
		globCache.set(pattern, re);
	}
	return re.test(relPath);
}

export function matchesAny(patterns: readonly string[], relPath: string): boolean {
	return patterns.some(p => matchGlob(p, relPath));
}

function kind(v: unknown): string {
	if (Array.isArray(v)) return "array";
	if (v === null) return "null";
	return typeof v;
}

/**
 * Merge `over` into `base`: objects recurse, arrays and scalars replace.
 * Keys absent from `base` are dropped; values of the wrong type are ignored with a warning.
 */
export function deepMerge<T>(base: T, over: unknown, warn: (msg: string) => void = () => {}, prefix = ""): T {
	if (kind(over) !== "object") return base;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(over as Record<string, unknown>)) {
		if (!(key in out)) continue;
		const path = prefix + key;
		const current = out[key];
		const want = kind(current);
		if (kind(value) !== want) {
			warn(`"${path}" should be ${want === "object" ? "a mapping" : `a ${want}`}; ignoring it.`);
			continue;
		}
		if (want === "object") {
			out[key] = deepMerge(current, value, warn, `${path}.`);
		} else if (want === "array") {
			if (!(value as unknown[]).every(v => typeof v === "string")) {
				warn(`"${path}" should be a list of strings; ignoring it.`);
				continue;
			}
			out[key] = [...(value as string[])];
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

async function readLayer(file: string, warnings: string[]): Promise<unknown> {
	const f = Bun.file(file);
	if (!(await f.exists())) return undefined;
	try {
		return Bun.YAML.parse(await f.text());
	} catch (err) {
		warnings.push(`Whetstone: ${file} is not valid YAML (${(err as Error).message}); ignoring it.`);
		return undefined;
	}
}

export function userConfigPath(agentDir: string): string {
	return join(agentDir, "whetstone", "config.yml");
}

export function projectConfigPath(repoRoot: string): string {
	return join(repoRoot, ".omp", "whetstone.yml");
}

/** DEFAULTS ← user config ← project config. `repoRoot` null skips the project layer. */
export async function loadConfig(
	repoRoot: string | null,
	agentDir: string,
): Promise<{ config: WhetConfig; warnings: string[] }> {
	const warnings: string[] = [];
	let config = structuredClone(DEFAULTS);
	const files = [userConfigPath(agentDir)];
	if (repoRoot) files.push(projectConfigPath(repoRoot));
	for (const file of files) {
		const layer = await readLayer(file, warnings);
		if (layer === undefined || layer === null) continue;
		config = deepMerge(config, layer, msg => warnings.push(`Whetstone: ${file}: ${msg}`));
	}
	return { config, warnings };
}

function yamlValue(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(x => JSON.stringify(x)).join(", ")}]`;
	return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** DEFAULTS as commented YAML, for /whet init. */
export function configYaml(): string {
	const lines = [
		"# Whetstone configuration. Project file: .omp/whetstone.yml; user file: ~/.omp/agent/whetstone/config.yml.",
		"# Precedence: built-in defaults < user file < project file. Lists replace, mappings merge.",
		"",
	];
	for (const [key, value] of Object.entries(DEFAULTS)) {
		lines.push(`# ${EXPLAIN[key]}`);
		if (kind(value) === "object") {
			lines.push(`${key}:`);
			for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
				lines.push(`  # ${EXPLAIN[`${key}.${sub}`]}`);
				lines.push(`  ${sub}: ${yamlValue(subValue)}`);
			}
		} else {
			lines.push(`${key}: ${yamlValue(value)}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ── per-process cache ───────────────────────────────────────────────────────

const byRoot = new Map<string, WhetConfig>();
const warnedFiles = new Set<string>();

/** Load (or reload) and cache the config for a repo root; each file's warnings are shown once per process. */
export async function refreshConfig(
	repoRoot: string | null,
	agentDir: string,
	notify?: (msg: string) => void,
): Promise<WhetConfig> {
	const { config, warnings } = await loadConfig(repoRoot, agentDir);
	for (const w of warnings) {
		if (warnedFiles.has(w)) continue;
		warnedFiles.add(w);
		notify?.(w);
	}
	byRoot.set(repoRoot ?? "", config);
	return config;
}

export function cachedConfig(repoRoot: string | null): WhetConfig | undefined {
	return byRoot.get(repoRoot ?? "");
}

export function configForRoot(repoRoot: string): WhetConfig {
	return byRoot.get(repoRoot) ?? DEFAULTS;
}

export function __resetConfigCache(): void {
	byRoot.clear();
	warnedFiles.clear();
}
