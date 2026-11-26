import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as git from "./git.ts";
import { logEvent } from "./log.ts";
import type { Deps, QuizResult, TaskState, WhetConfig } from "./types.ts";

const MAX_RETRIES = 2;

export const FALLBACK_QUESTIONS = [
	"Which files did this step change, and what does each change do?",
	"Name one thing that would break if this change were reverted.",
	"What input would make this change behave incorrectly?",
];

interface Grade {
	correct: boolean;
	feedback: string;
}

/** Parse the JSON object between the first `{` and the last `}` of a model reply. */
export function parseJsonReply(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

function fallbackQuestions(n: number): string[] {
	return Array.from({ length: n }, (_, i) => FALLBACK_QUESTIONS[i % FALLBACK_QUESTIONS.length]!);
}

async function ephemeral(ctx: ExtensionContext, promptText: string): Promise<string | null> {
	if (typeof ctx.runEphemeralTurn !== "function") return null;
	const r = await ctx.runEphemeralTurn({ promptText, tools: false, maxTokens: 1500 });
	return r.replyText;
}

/** Ask the model for JSON, retrying once with a stricter instruction. Null on any failure. */
async function askJson<T>(ctx: ExtensionContext, prompt: string, pick: (v: unknown) => T | null): Promise<{ value: T | null; error?: string }> {
	let error: string | undefined;
	for (const suffix of ["", "\n\nReturn only JSON."]) {
		try {
			const reply = await ephemeral(ctx, prompt + suffix);
			if (reply === null) return { value: null, error: "no side-turn support" };
			const value = pick(parseJsonReply(reply));
			if (value !== null) return { value };
			error = "unparsable reply";
		} catch (err) {
			return { value: null, error: (err as Error).message || String(err) };
		}
	}
	return { value: null, error };
}

function pickQuestions(n: number) {
	return (v: unknown): string[] | null => {
		if (!v || typeof v !== "object" || !("questions" in v) || !Array.isArray(v.questions)) return null;
		const qs = v.questions
			.map((q: unknown) => (q && typeof q === "object" && "q" in q && typeof q.q === "string" ? q.q.trim() : ""))
			.filter(Boolean);
		return qs.length >= n ? qs.slice(0, n) : null;
	};
}

function pickScores(n: number) {
	return (v: unknown): Grade[] | null => {
		if (!v || typeof v !== "object" || !("scores" in v) || !Array.isArray(v.scores) || v.scores.length < n) return null;
		return v.scores.slice(0, n).map((s: unknown) => ({
			correct: !!s && typeof s === "object" && "correct" in s && s.correct === true,
			feedback: s && typeof s === "object" && "feedback" in s && typeof s.feedback === "string" ? s.feedback : "",
		}));
	};
}

function questionPrompt(diff: string, n: number): string {
	return [
		`Write exactly ${n} quiz questions that test whether the developer understands the staged diff below.`,
		"Ask about why the change is shaped this way, its consequences and its edge cases — never trivia such as names or line numbers.",
		"Each question must be answerable in two or three sentences.",
		'Reply with JSON only: {"questions":[{"q":"..."}]}',
		"",
		diff,
	].join("\n");
}

function gradePrompt(diff: string, questions: string[], answers: string[]): string {
	const qa = questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${answers[i] || "(no answer)"}`).join("\n\n");
	return [
		"Grade the developer's answers about the staged diff below. An answer is correct when it shows real understanding;",
		"wording does not matter. Empty answers are wrong. Feedback is one sentence that teaches the missing point.",
		'Reply with JSON only: {"scores":[{"correct":true,"feedback":"..."}]} with one entry per question, in order.',
		"",
		qa,
		"",
		diff,
	].join("\n");
}

async function askAnswers(ctx: ExtensionContext, questions: string[], total: number, numbers: number[]): Promise<string[]> {
	const answers: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const a = await ctx.ui.editor(`Question ${numbers[i]}/${total}: ${questions[i]}`, "");
		answers.push(a?.trim() ?? "");
	}
	return answers;
}

async function selfGrade(ctx: ExtensionContext, questions: string[]): Promise<Grade[]> {
	const grades: Grade[] = [];
	for (const q of questions) {
		const pick = await ctx.ui.select(`Did you get it right? ${q}`, ["Yes", "No"]);
		grades.push({ correct: pick === "Yes", feedback: "" });
	}
	return grades;
}

/** Quiz the operator on the step's staged diff. */
export async function runQuiz(deps: Deps, ctx: ExtensionContext, task: TaskState, config: WhetConfig, files: string[]): Promise<QuizResult> {
	const n = config.quiz.length;
	const diff = await git.stagedDiff(deps.pi, task.repoRoot, files, git.DIFF_LIMIT, task.current?.baseTree ?? null);

	const generated = await askJson(ctx, questionPrompt(diff, n), pickQuestions(n));
	const questions = generated.value ?? fallbackQuestions(n);

	let graded: QuizResult["graded"] = "model";
	let selfNotified = false;
	const grade = async (qs: string[], answers: string[]): Promise<Grade[]> => {
		if (graded === "model") {
			const r = await askJson(ctx, gradePrompt(diff, qs, answers), pickScores(qs.length));
			if (r.value) return r.value;
			graded = "self";
			if (!selfNotified) {
				selfNotified = true;
				ctx.ui.notify(`Whetstone: grading unavailable (${r.error ?? "unknown error"}); grade yourself.`, "warning");
			}
		}
		return selfGrade(ctx, qs);
	};

	const numbers = questions.map((_, i) => i + 1);
	const answers = await askAnswers(ctx, questions, n, numbers);
	const grades = await grade(questions, answers);
	const need = Math.ceil(n * config.quiz.passRatio);
	const correctCount = () => grades.filter(g => g.correct).length;

	for (let retry = 0; retry < MAX_RETRIES && correctCount() < need; retry++) {
		const wrong = grades.map((g, i) => ({ g, i })).filter(x => !x.g.correct);
		const rows = wrong.map(w => (w.g.feedback ? `${questions[w.i]} — ${w.g.feedback}` : questions[w.i]!));
		const pick = await ctx.ui.select("Whetstone: not quite", [...rows, "— Try those again"]);
		if (pick === undefined) break;
		const qs = wrong.map(w => questions[w.i]!);
		const again = await askAnswers(ctx, qs, n, wrong.map(w => w.i + 1));
		const regraded = await grade(qs, again);
		wrong.forEach((w, k) => {
			grades[w.i] = regraded[k]!;
		});
	}

	const score = `${correctCount()}/${n}`;
	const passed = correctCount() >= need;
	await logEvent(deps, ctx, passed ? "quiz_pass" : "quiz_fail", { step: (task.current?.index ?? 0) + 1, score, graded });
	if (!passed) ctx.ui.notify(`Whetstone: quiz ${score}, ${need} needed. /whet next to try again, /whet skip to move on (logged).`, "warning");
	return { score, passed, skipped: false, graded };
}
