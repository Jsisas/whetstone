/** Hint ladder: withholds code blocks in ME steps unless they quote the repository. */

export interface CodeIndex {
	lines: Set<string>;
	idents: Set<string>;
}

const MIN_QUOTE_CHARS = 12;
const MAX_INDEX_LINES = 50_000;
const QUOTE_RATIO = 0.6;
const IDENT_RE =
	/^\s*(?:(?:export|default|async|pub(?:\([^)]*\))?|public|private|protected|static|abstract|final|declare|unsafe)\s+)*(?:def|class|function|fn|func|const|let|var|type|interface|struct|enum|impl|trait)\s+([A-Za-z_]\w*)/gm;

export const WITHHELD_L0 = "`[Whetstone: code withheld — /whet hint for a generic example, /whet show for your code]`";
export const WITHHELD_L1 = "`[Whetstone: that snippet is about your own code — /whet show to see it]`";

let index: CodeIndex = { lines: new Set(), idents: new Set() };

export function getIndex(): CodeIndex {
	return index;
}

export function resetIndex(): void {
	index = { lines: new Set(), idents: new Set() };
}

export function normalize(line: string): string {
	return line.trim().replace(/\s+/g, " ");
}

function significant(line: string): boolean {
	return line.replace(/\s/g, "").length >= MIN_QUOTE_CHARS;
}

export function addText(target: CodeIndex, text: string): void {
	// strip `read` line-number prefixes such as "12:" or "12|"
	const stripped = text.split("\n").map(raw => raw.replace(/^\s*\d+[:|]\s?/, ""));
	for (const raw of stripped) {
		if (target.lines.size >= MAX_INDEX_LINES) break;
		const line = normalize(raw);
		if (significant(line)) target.lines.add(line);
	}
	for (const m of stripped.join("\n").matchAll(IDENT_RE)) target.idents.add(m[1]!);
}

interface Fence {
	start: number;
	end: number;
	body: string;
}

/** Fenced blocks (``` or ~~~); an unterminated fence runs to the end of the text. */
function findFences(md: string): Fence[] {
	const fences: Fence[] = [];
	const re = /^( {0,3})(`{3,}|~{3,})[^\n]*$/gm;
	let m: RegExpExecArray | null;
	while ((m = re.exec(md))) {
		const marker = m[2]!;
		const start = m.index;
		const bodyStart = start + m[0].length + 1;
		const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`, "gm");
		close.lastIndex = Math.min(bodyStart, md.length);
		const c = bodyStart <= md.length ? close.exec(md) : null;
		if (c) {
			fences.push({ start, end: c.index + c[0].length, body: md.slice(bodyStart, c.index) });
			re.lastIndex = c.index + c[0].length;
		} else {
			fences.push({ start, end: md.length, body: md.slice(Math.min(bodyStart, md.length)) });
			break;
		}
	}
	return fences;
}

function isQuote(body: string, idx: CodeIndex): boolean {
	const lines = body.split("\n").map(normalize).filter(significant);
	if (lines.length === 0) return false;
	const hits = lines.filter(l => idx.lines.has(l)).length;
	return hits / lines.length >= QUOTE_RATIO;
}

function mentionsIdent(body: string, idx: CodeIndex): boolean {
	for (const word of body.match(/[A-Za-z_]\w*/g) ?? []) if (idx.idents.has(word)) return true;
	return false;
}

/**
 * Apply the ladder to one markdown text. Level 0: invented code withheld. Level 1: generic
 * examples allowed, code naming the repository's identifiers withheld. Level 2: everything kept.
 * Quotes of indexed repository code are always kept; text outside fences is untouched.
 */
export function stripBlocks(markdown: string, level: 0 | 1 | 2, idx: CodeIndex): string {
	if (level === 2) return markdown;
	const fences = findFences(markdown);
	if (fences.length === 0) return markdown;
	let out = "";
	let pos = 0;
	for (const f of fences) {
		out += markdown.slice(pos, f.start);
		const original = markdown.slice(f.start, f.end);
		if (isQuote(f.body, idx)) out += original;
		else if (level === 0) out += WITHHELD_L0;
		else if (mentionsIdent(f.body, idx)) out += WITHHELD_L1;
		else out += original;
		pos = f.end;
	}
	return out + markdown.slice(pos);
}
