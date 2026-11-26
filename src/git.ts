import { basename, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type Exec = Pick<ExtensionAPI, "exec">;

/** Maximum characters of diff sent to the model or shown in prompts. */
export const DIFF_LIMIT = 20_000;

async function git(pi: Exec, cwd: string, args: string[], okCodes: number[] = [0]): Promise<string | null> {
	try {
		const r = await pi.exec("git", args, { cwd, timeout: 20_000 });
		return okCodes.includes(r.code) ? r.stdout : null;
	} catch {
		return null;
	}
}

function lines(out: string | null): string[] {
	return (out ?? "").split("\n").map(l => l.trim()).filter(Boolean);
}

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [diff truncated at ${maxChars} chars]` : text;
}

export async function repoRoot(pi: Exec, cwd: string): Promise<string | null> {
	const out = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	return out?.trim() || null;
}

/** Stable repo identity for the log: normalized origin URL, else `local:<dirname>`. */
export async function repoKey(pi: Exec, root: string): Promise<string> {
	const url = (await git(pi, root, ["remote", "get-url", "origin"]))?.trim();
	if (!url) return `local:${basename(root)}`;
	let s = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "").replace(/\.git$/, "").replace(/\/+$/, "");
	// scp-like `host:owner/repo` → `host/owner/repo`
	s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/");
	const slash = s.indexOf("/");
	return slash === -1 ? s.toLowerCase() : s.slice(0, slash).toLowerCase() + s.slice(slash);
}

export async function hasHead(pi: Exec, root: string): Promise<boolean> {
	return (await git(pi, root, ["rev-parse", "--verify", "--quiet", "HEAD"])) !== null;
}

/** Tree object of the current index; the baseline a step's changes are measured against. */
export async function writeTree(pi: Exec, root: string): Promise<string | null> {
	return (await git(pi, root, ["write-tree"]))?.trim() || null;
}

export async function stagedFiles(pi: Exec, root: string): Promise<string[]> {
	return lines(await git(pi, root, ["diff", "--cached", "--name-only"]));
}

async function untrackedFiles(pi: Exec, root: string, files?: string[]): Promise<string[]> {
	const args = ["ls-files", "--others", "--exclude-standard"];
	if (files) args.push("--", ...files);
	return lines(await git(pi, root, args));
}

export async function unstagedFiles(pi: Exec, root: string): Promise<string[]> {
	const modified = lines(await git(pi, root, ["diff", "--name-only"]));
	return [...new Set([...modified, ...(await untrackedFiles(pi, root))])];
}

/** Which of `files` differ from `base` (a tree from writeTree) in the worktree, untracked included. */
export async function changedFiles(pi: Exec, root: string, files: string[], base: string): Promise<string[]> {
	if (files.length === 0) return [];
	const modified = lines(await git(pi, root, ["diff", "--name-only", base, "--", ...files]));
	return [...new Set([...modified, ...(await untrackedFiles(pi, root, files))])];
}

/** Tracked files that differ from `base` (a tree from writeTree) in the worktree; untracked files are left out on purpose. */
export async function trackedChangesSince(pi: Exec, root: string, base: string): Promise<string[]> {
	return lines(await git(pi, root, ["diff", "--name-only", base]));
}

function sumNumstat(out: string | null): number {
	let total = 0;
	for (const line of lines(out)) {
		const [add, del] = line.split("\t");
		total += (Number(add) || 0) + (Number(del) || 0);
	}
	return total;
}

async function countFileLines(root: string, rel: string): Promise<number> {
	try {
		const text = await Bun.file(join(root, rel)).text();
		if (!text) return 0;
		return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	} catch {
		return 0;
	}
}

/**
 * Changed lines (added + deleted) in `files`: worktree against `base` (a tree from writeTree),
 * else against HEAD, else index + worktree when there is no HEAD; untracked files count in full.
 */
export async function changedLines(pi: Exec, root: string, files: string[], base: string | null = null): Promise<number> {
	if (files.length === 0) return 0;
	let total: number;
	if (base) {
		total = sumNumstat(await git(pi, root, ["diff", "--numstat", base, "--", ...files]));
	} else if (await hasHead(pi, root)) {
		total = sumNumstat(await git(pi, root, ["diff", "--numstat", "HEAD", "--", ...files]));
	} else {
		total =
			sumNumstat(await git(pi, root, ["diff", "--cached", "--numstat", "--", ...files])) +
			sumNumstat(await git(pi, root, ["diff", "--numstat", "--", ...files]));
	}
	for (const rel of await untrackedFiles(pi, root, files)) total += await countFileLines(root, rel);
	return total;
}

/** Staged diff of `files` against `base` (or HEAD). */
export async function stagedDiff(pi: Exec, root: string, files: string[], maxChars: number, base: string | null = null): Promise<string> {
	if (files.length === 0) return "";
	const args = ["diff", "--cached"];
	if (base) args.push(base);
	const out = await git(pi, root, [...args, "--", ...files]);
	return truncate(out ?? "", maxChars);
}

/** Worktree diff of `files` against `base` (or HEAD), plus untracked files in full. */
export async function worktreeDiff(pi: Exec, root: string, files: string[], maxChars: number, base: string | null = null): Promise<string> {
	if (files.length === 0) return "";
	let out: string;
	if (base) {
		out = (await git(pi, root, ["diff", base, "--", ...files])) ?? "";
	} else if (await hasHead(pi, root)) {
		out = (await git(pi, root, ["diff", "HEAD", "--", ...files])) ?? "";
	} else {
		out =
			((await git(pi, root, ["diff", "--cached", "--", ...files])) ?? "") +
			((await git(pi, root, ["diff", "--", ...files])) ?? "");
	}
	for (const rel of await untrackedFiles(pi, root, files)) {
		out += (await git(pi, root, ["diff", "--no-index", "--", "/dev/null", rel], [0, 1])) ?? "";
	}
	return truncate(out, maxChars);
}
