import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { statusEnded } from "./hooks/agent-status";
import {
	autoDeliveryPath,
	captureStatePath,
	draftStatusPath,
	peek,
	sessionPath,
} from "./hooks/decision-capture";
import { type JsonObject, UUID } from "./hooks/hook-io";
import { configDir } from "./supervise-drivers";

/** Questions expire after a day; nothing older is worth a read. */
const QUESTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long an open Claude Code session's own hooks get before it is logged. */
export const OPEN_SESSION_GRACE_MS = 15 * 60 * 1000;

export interface Candidate {
	session: string;
	host: string;
	requestId: string;
	token: string;
	state: string;
	ageMs: number;
	cwd: string;
}

/** Chats whose newest question still waits and had a tedi draft queued. */
export function waitingQuestions(
	env: NodeJS.ProcessEnv,
	now: number,
): Candidate[] {
	const directory = join(configDir(env), "decision-capture");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const found: Candidate[] = [];
	for (const name of names) {
		const session = name.endsWith(".question.json")
			? name.slice(0, -".question.json".length)
			: "";
		if (!UUID.test(session)) continue;
		const state = captureStatePath(env, session);
		const questionFile = join(directory, name);
		const question = peek(questionFile);
		const current = peek(state);
		const drafted = peek(draftStatusPath(state));
		if (
			!question ||
			typeof question.requestId !== "string" ||
			!UUID.test(question.requestId) ||
			typeof question.token !== "string" ||
			// A typed reply or a newer turn claimed the question.
			current?.token !== question.token ||
			current?.requestId !== question.requestId ||
			drafted?.requestId !== question.requestId ||
			drafted?.status !== "queued" ||
			// Already delivered once.
			peek(autoDeliveryPath(state))?.requestId === question.requestId
		)
			continue;
		let ageMs: number;
		try {
			ageMs = now - statSync(questionFile).mtimeMs;
		} catch {
			continue;
		}
		if (ageMs > QUESTION_MAX_AGE_MS) continue;
		if (question.host === "devin") continue;
		const host = question.host === "codex" ? "codex" : "claude-code";
		const status = peek(
			join(configDir(env), "agent-status", `${host}-${session}.json`),
		);
		// The session is running again (typed reply not captured, or a tool call);
		// a status silent for 12 hours belongs to a session that ended.
		if (status?.state === "working" && !statusEnded(status, now)) continue;
		found.push({
			session,
			host,
			requestId: question.requestId,
			token: question.token,
			state,
			ageMs,
			cwd:
				typeof status?.cwd === "string" && status.cwd ? status.cwd : homedir(),
		});
	}
	return found;
}

export interface LocalSession {
	session: string;
	host: "claude-code" | "codex";
	cwd: string;
	/** Its agent-status record, when status reporting is on. */
	status: JsonObject | undefined;
}

/** Sessions that ended a captured turn on this machine in the last day. */
export function localSessions(
	env: NodeJS.ProcessEnv,
	now: number,
): LocalSession[] {
	const directory = join(configDir(env), "decision-capture");
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return [];
	}
	const found: LocalSession[] = [];
	for (const name of names) {
		if (!name.endsWith(".session.json")) continue;
		const session = name.slice(0, -".session.json".length);
		if (!UUID.test(session)) continue;
		const path = sessionPath(captureStatePath(env, session));
		try {
			if (now - statSync(path).mtimeMs > QUESTION_MAX_AGE_MS) continue;
		} catch {
			continue;
		}
		const record = peek(path);
		if (record?.host === "devin") continue;
		const host = record?.host === "codex" ? "codex" : "claude-code";
		found.push({
			session,
			host,
			cwd:
				typeof record?.cwd === "string" && record.cwd ? record.cwd : homedir(),
			status: peek(
				join(configDir(env), "agent-status", `${host}-${session}.json`),
			),
		});
	}
	return found;
}

export type AnswerAction =
	| { kind: "claude-resume" }
	| { kind: "codex" }
	| { kind: "wait"; reason: string };

/**
 * Deliver only to the originating chat: resume a closed Claude Code session,
 * queue or resume Codex, or wait for the session's own hooks.
 */
export function answerAction(input: {
	host: "claude-code" | "codex";
	ageMs: number;
	/** Claude Code only: whether a process has the session open. */
	open: boolean | undefined;
	/** Its status says it is running a turn right now. */
	working: boolean;
}): AnswerAction {
	if (input.host === "codex")
		return input.working
			? {
					kind: "wait",
					reason:
						"the Codex session is running a turn; its Stop hook delivers it",
				}
			: { kind: "codex" };
	if (input.open === undefined)
		return {
			kind: "wait",
			reason:
				"cannot tell whether the Claude Code session is open, so it is never resumed; left undelivered",
		};
	if (!input.open) return { kind: "claude-resume" };
	return {
		kind: "wait",
		reason:
			input.ageMs >= OPEN_SESSION_GRACE_MS
				? "the Claude Code session is open in a terminal but its hooks have not delivered it after 15 minutes; left undelivered"
				: "the Claude Code session is open in a terminal; its hooks deliver it",
	};
}
