import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getTask } from "./state.ts";
import type { Deps, LogEvent, LogRecord } from "./types.ts";

export async function appendLog(dir: string, rec: Omit<LogRecord, "ts">, now = Date.now(), onError?: (err: unknown) => void): Promise<void> {
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await appendFile(join(dir, "log.jsonl"), `${JSON.stringify({ ts: new Date(now).toISOString(), ...rec })}\n`, { mode: 0o600 });
	} catch (err) {
		onError?.(err);
	}
}

export async function readLog(dir: string): Promise<LogRecord[]> {
	const file = Bun.file(join(dir, "log.jsonl"));
	if (!(await file.exists())) return [];
	const out: LogRecord[] = [];
	for (const line of (await file.text()).split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as LogRecord);
		} catch {
			// skip unparsable lines
		}
	}
	return out;
}

/** Log an event for the current task (repo, session and task id filled in). */
export function logEvent(
	deps: Deps,
	ctx: Pick<ExtensionContext, "sessionManager">,
	event: LogEvent,
	extra: Record<string, unknown> = {},
	repo?: string,
): Promise<void> {
	const task = getTask();
	let session = "";
	try {
		session = ctx.sessionManager.getSessionId() ?? "";
	} catch {
		// session id unavailable
	}
	return appendLog(
		deps.dataDir,
		{ repo: repo ?? task?.repoKey ?? "", session, task: task?.id ?? null, event, ...extra },
		deps.now(),
		err => deps.pi.logger.warn(`Whetstone: could not write the log: ${String(err)}`),
	);
}
