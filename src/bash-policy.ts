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

const GIT_WRITES = new Set([
	"add", "commit", "push", "reset", "rm", "mv", "restore", "checkout", "switch", "merge", "rebase", "cherry-pick",
	"revert", "stash", "tag", "clean", "apply", "am", "filter-branch", "update-ref", "gc", "prune", "notes",
	"worktree", "submodule", "config", "pull", "fetch", "init", "clone",
]);
const GIT_REF_WRITE_ARGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "add", "remove", "rm", "rename", "set-url"]);

/** The git subcommand when `segment` is a git write, else null. */
export function gitWriteSubcommand(segment: string): string | null {
	const words = tokenize(segment);
	let i = commandIndex(words);
	if (i === -1 || words[i] !== "git") return null;
	for (i++; i < words.length; i++) {
		const w = words[i]!;
		if (w === "-C" || w === "-c") {
			i++;
			continue;
		}
		if (w.startsWith("-")) continue;
		if (GIT_WRITES.has(w)) return w;
		if ((w === "branch" || w === "remote") && words.slice(i + 1).some(a => GIT_REF_WRITE_ARGS.has(a))) return w;
		return null;
	}
	return null;
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

/** Whether the operator must confirm this segment before the agent runs it. */
export function needsConfirm(segment: string, config: WhetConfig): boolean {
	const words = tokenize(segment);
	const i = commandIndex(words);
	if (i === -1) return false;
	if (words.slice(0, i).includes("sudo")) return true;
	if (!config.allowedCommands.includes(words[i]!)) return true;
	if (words.slice(i + 1).some(w => MUTATING_FLAGS.has(w.split("=")[0]!))) return true;
	return hasRedirection(segment);
}
