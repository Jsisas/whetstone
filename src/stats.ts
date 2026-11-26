import type { LogRecord, WhetConfig } from "./types.ts";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export function isoWeek(ms: number): string {
	const d = new Date(ms);
	const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
	const day = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - day);
	const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
	const week = Math.ceil(((t.getTime() - yearStart) / DAY + 1) / 7);
	return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function pct(part: number, total: number): string {
	return total === 0 ? "—" : `${Math.round((part / total) * 100)}%`;
}

function counts(records: LogRecord[]): { me: number; ai: number } {
	let me = 0;
	let ai = 0;
	for (const r of records) {
		if (r.owner === "ME") me++;
		else if (r.owner === "AI") ai++;
	}
	return { me, ai };
}

function row(label: string, width: number, me: number | string, ai: number | string, share: string): string {
	const l = label.length > width - 1 ? `${label.slice(0, width - 2)}…` : label;
	return `  ${l.padEnd(width)}${String(me).padStart(4)}${String(ai).padStart(5)}${share.padStart(11)}`;
}

export interface StatsOptions {
	/** Filter to this repository; null shows all repositories. */
	repoKey: string | null;
	now: number;
	config: WhetConfig;
}

export function renderStats(records: LogRecord[], opts: StatsOptions): string {
	const { repoKey, now, config } = opts;
	const mine = repoKey === null ? records : records.filter(r => r.repo === repoKey);
	const steps = mine.filter(r => r.event === "step_end");
	if (steps.length === 0) return "Whetstone: no finished steps yet.";
	const out: string[] = [`Whetstone — ${repoKey ?? "all repositories"}`, ""];

	out.push(row("Week", 10, "ME", "AI", "ME share"));
	const weeks = [3, 2, 1, 0].map(k => isoWeek(now - k * WEEK));
	for (const w of weeks) {
		const { me, ai } = counts(steps.filter(r => isoWeek(Date.parse(r.ts)) === w));
		out.push(row(w, 10, me, ai, pct(me, me + ai)));
	}
	out.push("");

	const byArea = new Map<string, LogRecord[]>();
	for (const r of steps) {
		const a = typeof r.area === "string" ? r.area : ".";
		byArea.set(a, [...(byArea.get(a) ?? []), r]);
	}
	out.push(row("Area", 24, "ME", "AI", "ME share"));
	const areas = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
	for (const [a, rs] of areas.slice(0, 10)) {
		const { me, ai } = counts(rs);
		out.push(row(a, 24, me, ai, pct(me, me + ai)));
	}
	out.push("");

	const debugged = steps.filter(r => r.debugger === "me" || r.debugger === "ai");
	if (debugged.length > 0) {
		const found = debugged.filter(r => r.debugger === "me").length;
		out.push(`  You found the cause in ${found} of ${debugged.length} failures (${pct(found, debugged.length)})`);
	}

	const quizzes = mine.filter(r => r.event === "quiz_pass" || r.event === "quiz_fail" || r.event === "quiz_skip").slice(-10);
	if (quizzes.length > 0) {
		const n = (e: string) => quizzes.filter(r => r.event === e).length;
		const scored = quizzes
			.filter(r => r.event !== "quiz_skip" && r.graded !== "none" && typeof r.score === "string")
			.map(r => Number((r.score as string).split("/")[0]))
			.filter(Number.isFinite);
		const avg = scored.length > 0 ? ` (avg ${(scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(1)}/${config.quiz.length})` : "";
		out.push(`  Last ${quizzes.length} quizzes: ${n("quiz_pass")} pass, ${n("quiz_fail")} fail, ${n("quiz_skip")} skip${avg}`);
	}

	const meSteps = steps.filter(r => r.owner === "ME");
	if (meSteps.length > 0) {
		const sum = (k: string) => meSteps.reduce((acc, r) => acc + (typeof r[k] === "number" ? (r[k] as number) : 0), 0);
		out.push(`  Ladder: /whet hint ${sum("hintCount")}, /whet show ${sum("showCount")}, /whet solve ${sum("solveCount")} across ${meSteps.length} ME steps`);
	}
	const total = counts(steps);
	out.push(`  Target ME share ${pct(config.targetMeRatio, 1)}, actual ${pct(total.me, total.me + total.ai)}`);

	const warnings: string[] = [];
	for (const [a, rs] of areas) {
		const meTimes = rs.filter(r => r.owner === "ME").map(r => Date.parse(r.ts));
		if (meTimes.length === 0) {
			warnings.push(`  ⚠ never a ME step in ${a}`);
			continue;
		}
		const age = now - Math.max(...meTimes);
		if (age > config.rustWeeks * WEEK) warnings.push(`  ⚠ no ME steps in ${a} for ${Math.floor(age / WEEK)} weeks`);
	}
	if (warnings.length > 0) out.push("", ...warnings);
	return out.join("\n");
}
