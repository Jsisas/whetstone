import { expect, test } from "bun:test";
import { addText, type CodeIndex, stripBlocks, WITHHELD_L0, WITHHELD_L1 } from "../src/ladder.ts";

function indexOf(text: string): CodeIndex {
	const idx: CodeIndex = { lines: new Set(), idents: new Set() };
	addText(idx, text);
	return idx;
}

const repoCode = "export function parseTimestamp(raw: string): Date {\n  return new Date(Date.parse(raw));\n}\n";
const idx = indexOf(repoCode);

test("level 0 replaces an invented code block", () => {
	const md = "Try this:\n```ts\nconst retries = computeBackoff(attempt, base);\n```\nDone.";
	expect(stripBlocks(md, 0, idx)).toBe(`Try this:\n${WITHHELD_L0}\nDone.`);
});

test("a block quoting indexed repository code is kept", () => {
	const md = `See:\n\`\`\`ts\n${repoCode}\`\`\`\n`;
	expect(stripBlocks(md, 0, idx)).toBe(md);
});

test("inline backticks and text outside fences are untouched", () => {
	const md = "Call `computeBackoff(attempt)` before `parseTimestamp`.";
	expect(stripBlocks(md, 0, idx)).toBe(md);
});

test("level 1 withholds a block naming repository identifiers and keeps generic ones", () => {
	const own = "```ts\nconst d = parseTimestamp(input) ?? fallbackValue;\n```";
	const generic = "```ts\nconst total = items.reduce((a, b) => a + b, 0);\n```";
	expect(stripBlocks(own, 1, idx)).toBe(WITHHELD_L1);
	expect(stripBlocks(generic, 1, idx)).toBe(generic);
});

test("level 2 leaves everything", () => {
	const md = "```ts\nconst d = parseTimestamp(input) ?? fallbackValue;\n```";
	expect(stripBlocks(md, 2, idx)).toBe(md);
});

test("several blocks keep their order and the surrounding text", () => {
	const md = "A\n```\nconst invented = somethingNew(1, 2, 3);\n```\nB\n~~~py\nresult = generic_helper(values)\n~~~\nC";
	expect(stripBlocks(md, 0, idx)).toBe(`A\n${WITHHELD_L0}\nB\n${WITHHELD_L0}\nC`);
});

test("an unterminated fence while streaming is withheld to the end", () => {
	const md = "Here:\n```ts\nconst invented = somethingNew(1, 2, 3);\nconst more =";
	expect(stripBlocks(md, 0, idx)).toBe(`Here:\n${WITHHELD_L0}`);
});
