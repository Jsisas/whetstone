import type { WhetConfig } from "./types.ts";

/**
 * Split a shell command into simple-command segments on `;`, `&&`, `||`, `|`, `&`, newlines and
 * subshell parentheses outside quotes. Bodies of `$(…)` and backticks are added as extra segments.
 */
export function splitSegments(cmd: string): string[] {
	const segments: string[] = [];
	const extra: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	const flush = () => {
		if (cur.trim()) segments.push(cur.trim());
		cur = "";
	};
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i]!;
		if (quote === "'") {
			cur += c;
			if (c === "'") quote = null;
			continue;
		}
		if (c === "\\" && i + 1 < cmd.length) {
			cur += c + cmd[i + 1];
			i++;
			continue;
		}
		if (c === "$" && cmd[i + 1] === "(" && cmd[i + 2] !== "(") {
			const end = matchParen(cmd, i + 1);
			extra.push(cmd.slice(i + 2, end));
			cur += cmd.slice(i, end + 1);
			i = end;
			continue;
		}
		if (c === "`") {
			let end = cmd.indexOf("`", i + 1);
			if (end === -1) end = cmd.length;
			extra.push(cmd.slice(i + 1, end));
			cur += cmd.slice(i, end + 1);
			i = end;
			continue;
		}
		if (quote === '"') {
			cur += c;
			if (c === '"') quote = null;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			cur += c;
			continue;
		}
		if (c === "&" && (cmd[i - 1] === ">" || cmd[i + 1] === ">" || cmd[i - 1] === "<")) {
			cur += c; // redirection (2>&1, &>file, <&3), not a separator
			continue;
		}
		if (c === ";" || c === "\n" || c === "|" || c === "&" || c === "(" || c === ")") {
			flush();
			if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
			else if (c === "|" && cmd[i + 1] === "&") i++;
			continue;
		}
		cur += c;
	}
	flush();
	for (const body of extra) segments.push(...splitSegments(body));
	return segments;
}

function matchParen(s: string, open: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = open; i < s.length; i++) {
		const c = s[i]!;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"') i++;
			continue;
		}
		if (c === "'" || c === '"') quote = c;
		else if (c === "\\") i++;
		else if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return s.length;
}

/** Split a segment into words, honoring quotes and backslash escapes (quotes removed). */
export function tokenize(segment: string): string[] {
	const words: string[] = [];
	let cur = "";
	let has = false;
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i]!;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
			else cur += c;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			has = true;
		} else if (c === "\\" && i + 1 < segment.length) {
			cur += segment[++i];
			has = true;
		} else if (/\s/.test(c)) {
			if (has) words.push(cur);
			cur = "";
			has = false;
		} else {
			cur += c;
			has = true;
		}
	}
	if (has) words.push(cur);
	return words;
}

const PREFIX_WORDS = new Set(["env", "sudo", "command", "exec", "time", "nice", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the command word in `words`, skipping assignments and wrappers like `env`/`sudo`. */
function commandIndex(words: string[]): number {
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		if (ASSIGNMENT.test(w) || PREFIX_WORDS.has(w)) continue;
		if (words[i - 1] === "env" && w.startsWith("-")) continue;
		if (words[i - 1] === "nice" && /^-n$/.test(w)) {
			i++;
			continue;
		}
		return i;
	}
	return -1;
}

export function commandWord(segment: string): string | null {
	const words = tokenize(segment);
	const i = commandIndex(words);
	return i === -1 ? null : words[i]!;
}

const base = (w: string): string => w.split("/").pop()!;

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set([
	"sudo", "doas", "timeout", "nohup", "nice", "ionice", "stdbuf", "xargs", "watch", "chronic", "unbuffer", "flock",
	"env", "command", "exec", "time",
]);
const PREFIX_WRAPPERS = ["sudo", "env", "command", "exec", "time", "nice"];
const GIT_VALUE_OPTS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
const GIT_READ = new Set([
	"status", "diff", "log", "show", "blame", "annotate", "grep", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list",
	"cat-file", "describe", "shortlog", "show-ref", "show-branch", "merge-base", "name-rev", "for-each-ref", "count-objects",
	"check-ignore", "check-attr", "check-ref-format", "cherry", "range-diff", "whatchanged", "help", "version", "var",
	"diff-tree", "diff-files", "diff-index", "verify-commit", "verify-tag",
]);

const set = (...v: string[]): Set<string> => new Set(v);
const BRANCH_WRITE = set("-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream", "--edit-description", "-t", "--track", "--no-track");
const BRANCH_LIST = set("--list", "-l", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at");
const TAG_WRITE = set("-d", "--delete", "-f", "--force", "-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-m", "--message", "-F", "--file");
const TAG_LIST = set("-l", "--list", "-v", "--verify", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged");
const CONFIG_WRITE = set("--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section");
const CONFIG_READ = set("--get", "--get-all", "--get-regexp", "--list", "-l");

/** Subcommands that are read-only only for some arguments; `pos` = non-option words, `flag` tests option names. */
const GIT_READ_WHEN: Record<string, (pos: string[], flag: (s: Set<string>) => boolean) => boolean> = {
	branch: (pos, flag) => !flag(BRANCH_WRITE) && (pos.length === 0 || flag(BRANCH_LIST)),
	tag: (pos, flag) => !flag(TAG_WRITE) && (pos.length === 0 || flag(TAG_LIST)),
	remote: pos => pos.length === 0 || ["show", "get-url"].includes(pos[0]!),
	stash: pos => ["list", "show"].includes(pos[0] ?? ""),
	config: (pos, flag) => !flag(CONFIG_WRITE) && (flag(CONFIG_READ) || ["get", "list"].includes(pos[0] ?? "")),
	worktree: pos => pos[0] === "list",
	notes: pos => pos.length === 0 || ["list", "show"].includes(pos[0]!),
	submodule: pos => ["status", "summary"].includes(pos[0] ?? ""),
	reflog: pos => pos.length === 0 || pos[0] === "show",
	bisect: pos => ["log", "visualize", "view"].includes(pos[0] ?? ""),
	lfs: pos => ["ls-files", "status", "env", "version"].includes(pos[0] ?? ""),
	"sparse-checkout": pos => pos[0] === "list",
};

/** Judge the words after `git`: the subcommand when it is (or may be) a write, else null. Only known reads pass. */
function gitSub(args: string[]): string | null {
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i]!;
		if (a === "-c" || a.split("=")[0] === "--config-env") return "-c";
		if (GIT_VALUE_OPTS.has(a)) {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		break;
	}
	const sub = args[i];
	if (sub === undefined) return null;
	const rest = args.slice(i + 1);
	if (rest.some(a => a.split("=")[0] === "--output")) return sub;
	if (GIT_READ.has(sub)) return null;
	const when = GIT_READ_WHEN[sub];
	if (when) {
		const pos = rest.filter(a => !a.startsWith("-"));
		const flag = (s: Set<string>) => rest.some(a => s.has(a.split("=")[0]!));
		if (when(pos, flag)) return null;
	}
	return sub;
}

/** The first git write found in a list of shell command segments, else null. */
function firstGitWrite(code: string): string | null {
	for (const seg of splitSegments(code)) {
		const w = gitWriteSubcommand(seg);
		if (w) return w;
	}
	return null;
}

// Best-effort against a cooperative agent: variable indirection (`$g commit`), `env -S` and ANSI-C `$'…'` quoting are not detected.
function gitWriteInWords(words: string[]): string | null {
	const i = commandIndex(words);
	if (i === -1) return null;
	const w = base(words[i]!);
	if (w === "git") return gitSub(words.slice(i + 1));
	if (SHELLS.has(w)) {
		const c = words.findIndex((x, k) => k > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
		const code = c === -1 ? undefined : words[c + 1];
		return code === undefined ? null : firstGitWrite(code);
	}
	if (w === "eval") return firstGitWrite(words.slice(i + 1).join(" "));
	if (w === "find") {
		const k = words.findIndex((x, j) => j > i && ["-exec", "-execdir", "-ok", "-okdir"].includes(x));
		if (k !== -1) return gitWriteInWords(words.slice(k + 1));
	}
	if (WRAPPERS.has(w) || words.slice(0, i).some(x => PREFIX_WRAPPERS.includes(x))) {
		const k = words.findIndex((x, j) => j > i && (base(x) === "git" || base(x) === "eval" || SHELLS.has(base(x))));
		return k === -1 ? null : gitWriteInWords(words.slice(k));
	}
	return null;
}

/** The git subcommand when `segment` is a git write (or may be one), else null. */
export function gitWriteSubcommand(segment: string): string | null {
	return gitWriteInWords(tokenize(segment));
}

const SAFE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** Unquoted output redirection to a file, or `tee`. */
export function hasRedirection(segment: string): boolean {
	if (tokenize(segment).includes("tee")) return true;
	let quote: string | null = null;
	for (let i = 0; i < segment.length; i++) {
		const c = segment[i]!;
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"') i++;
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			continue;
		}
		if (c === "\\") {
			i++;
			continue;
		}
		if (c !== ">") continue;
		let j = i + 1;
		if (segment[j] === ">" || segment[j] === "|") j++;
		if (segment[j] === "(") return true; // process substitution
		if (segment[j] === "&") {
			if (/[0-9-]/.test(segment[j + 1] ?? "")) {
				i = j + 1;
				continue; // fd duplication: >&2, 2>&1, >&-
			}
			j++;
		}
		while (segment[j] === " " || segment[j] === "\t") j++;
		const target = tokenize(segment.slice(j))[0] ?? "";
		if (!SAFE_TARGETS.has(target)) return true;
		i = j + target.length - 1;
	}
	return false;
}

const MUTATING_FLAGS = new Set(["--fix", "--write", "--unsafe-fixes"]);

const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3", "uv", "npx", "bunx"]);
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/** Whether the allowlist entry (one or more words) is a word prefix of the command starting at `i`. */
function allowedPrefix(entry: string, words: string[], i: number): boolean {
	return entry.trim().split(/\s+/).every((t, k) => words[i + k] === t);
}

/** Whether the operator must confirm this segment before the agent runs it. */
export function needsConfirm(segment: string, config: WhetConfig): boolean {
	const words = tokenize(segment);
	const i = commandIndex(words);
	if (i === -1) return false;
	if (words.slice(0, i).includes("sudo")) return true;
	if (!config.allowedCommands.some(entry => allowedPrefix(entry, words, i))) return true;
	if (RUNTIMES.has(words[i]!) && words.slice(i + 1).some(w => EVAL_FLAGS.has(w))) return true;
	if (words.slice(i + 1).some(w => MUTATING_FLAGS.has(w.split("=")[0]!))) return true;
	return hasRedirection(segment);
}
