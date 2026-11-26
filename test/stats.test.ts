import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { renderStats } from "../src/stats.ts";
import type { LogRecord } from "../src/types.ts";

// Wednesday 2026-11-18 12:00 UTC is in ISO week 2026-W47.
const NOW = Date.UTC(2026, 10, 18, 12);
const DAY = 86_400_000;

function end(daysAgo: number, owner: "ME" | "AI", area: string, extra: Partial<LogRecord> = {}): LogRecord {
	return {
		ts: new Date(NOW - daysAgo * DAY).toISOString(),
		repo: "github.com/x/y",
		session: "s",
		task: "t",
		event: "step_end",
		owner,
		area,
		debugger: null,
		hintCount: 0,
		showCount: 0,
		...extra,
	};
}

const RECORDS: LogRecord[] = [
	end(50, "ME", "src/billing"),
	end(15, "AI", "src/billing"),
	end(14, "AI", "src/http", { debugger: "ai" }),
	end(8, "ME", "src/http", { debugger: "me", hintCount: 2, showCount: 1 }),
	end(1, "AI", "src/http"),
	end(0, "ME", "src/http", { debugger: "me" }),
	{ ts: new Date(NOW).toISOString(), repo: "github.com/x/y", session: "s", task: "t", event: "quiz_pass", score: "3/3", graded: "model" },
	{ ts: new Date(NOW).toISOString(), repo: "github.com/x/y", session: "s", task: "t", event: "quiz_skip", score: "skipped", graded: "none" },
	end(0, "ME", "elsewhere", { repo: "github.com/other/repo" }),
];

test("renders weeks, areas, debugging, quizzes, ladder and rust warnings", () => {
	const out = renderStats(RECORDS, { repoKey: "github.com/x/y", now: NOW, config: DEFAULTS });
	expect(out).toBe(
		[
			"Whetstone — github.com/x/y",
			"",
			"  Week        ME   AI   ME share",
			"  2026-W44     0    0          —",
			"  2026-W45     0    2         0%",
			"  2026-W46     1    0       100%",
			"  2026-W47     1    1        50%",
			"",
			"  Area                      ME   AI   ME share",
			"  src/http                   2    2        50%",
			"  src/billing                1    1        50%",
			"",
			"  You found the cause in 2 of 3 failures (67%)",
			"  Last 2 quizzes: 1 pass, 0 fail, 1 skip (avg 3.0/3)",
			"  Ladder: /whet hint 2, /whet show 1 across 3 ME steps",
			"  Target ME share 40%, actual 50%",
			"",
			"  ⚠ no ME steps in src/billing for 7 weeks",
		].join("\n"),
	);
});

test("an empty log says so", () => {
	expect(renderStats([], { repoKey: null, now: NOW, config: DEFAULTS })).toBe("Whetstone: no finished steps yet.");
});
