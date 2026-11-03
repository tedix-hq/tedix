/**
 * Delivery of the user's own Tedix OS answers to the session that asked.
 *
 * The server lists every answer to this user's session questions that no
 * client has recorded as delivered (`work interaction-undelivered`), and
 * records delivery once (`work interaction-ack`). The hooks hand a session all
 * of its pending answers at once, not only the newest question's, then record
 * them; the next turn end of that session records them acknowledged. The
 * supervisor delivers the rest (`supervise.ts`).
 */
import { ListUndeliveredWorkInteractionResponsesResultSchema } from "@tedix/api-contract/schemas/work-interactions";
import { markdownLineToPlainText } from "@tedix/api-contract/utils/markdown-plain-text";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { beginFileLock } from "../local-file-lock";
import {
	type Binding,
	ackAnswers,
	rememberDelivered,
	claim,
	peek,
	questionPath,
	workTool,
	writeState,
} from "./decision-capture";
import type { HookDeps } from "./hook-io";

export interface PendingAnswer {
	responseId: string;
	requestId: string;
	subject: string;
	body: string;
	respondedAt: string;
	sessionId: string;
	host: string | null;
	workItemId: string | null;
	projectId: string | null;
}

/** Bytes of answer text one delivery carries by default. */
export const ANSWERS_LIMIT = 6000;

/** The supervisor and hooks use the same receipts and session mutex. */
export function answerDeliveryPath(
	env: NodeJS.ProcessEnv,
	host: string,
	session: string,
	key: string,
): string {
	const hash = createHash("sha256")
		.update(`${host}:${session}:${key}`)
		.digest("hex");
	return join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"supervisor",
		"deliveries",
		`${hash}.json`,
	);
}

export function codexQueuePath(
	env: NodeJS.ProcessEnv,
	session: string,
): string {
	return join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"supervisor",
		"codex-queue",
		`${createHash("sha256").update(session).digest("hex")}.json`,
	);
}

export async function claimHookAnswers(
	deps: HookDeps,
	binding: Binding,
	session: string,
	host: string,
	state: string,
	question: { requestId: string; token: string } | undefined,
	answers: PendingAnswer[],
	timeoutMs: number,
	via: "hook" | "prompt_context" = "hook",
): Promise<PendingAnswer[]> {
	const lock = beginFileLock(
		answerDeliveryPath(deps.env, host, session, "session-lock"),
	);
	try {
		if (!lock.ready()) return [];
		// A retained queue can still reach this session after the supervisor unlocks.
		if (host === "codex" && existsSync(codexQueuePath(deps.env, session)))
			return [];
		const unique = [
			...new Map(answers.map((answer) => [answer.responseId, answer])).values(),
		];
		const pathOf = (answer: PendingAnswer) =>
			answerDeliveryPath(
				deps.env,
				host,
				session,
				`${binding.command.join(" ")}:${binding.user}:${answer.responseId}`,
			);
		const fresh = unique.filter(
			(answer) =>
				answer.sessionId.toLowerCase() === session.toLowerCase() &&
				(!answer.host || answer.host === host) &&
				!existsSync(pathOf(answer)),
		);
		if (!fresh.length || !claimAnsweredQuestion(state, question, fresh))
			return [];
		for (const answer of fresh) {
			const path = pathOf(answer);
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, JSON.stringify({ session, state: "pending" }), {
				mode: 0o600,
				flag: "wx",
			});
		}
		const ids = fresh.map((answer) => answer.responseId);
		await ackAnswers(deps, binding, ids, via, timeoutMs);
		rememberDelivered(state, ids, via);
		for (const answer of fresh)
			writeFileSync(pathOf(answer), JSON.stringify({ via }), { mode: 0o600 });
		return fresh;
	} finally {
		lock.release();
	}
}

/**
 * The user's undelivered answers (for one session when given), oldest first,
 * or undefined when they cannot be read (offline, signed out, older server).
 * `failed` receives why, when a caller logs failures.
 */
export async function undeliveredAnswers(
	deps: Pick<HookDeps, "read">,
	binding: Binding,
	filter: { sessionId?: string },
	timeoutMs: number,
	failed?: (reason: string) => void,
): Promise<PendingAnswer[] | undefined> {
	try {
		const value = await workTool(
			deps,
			binding,
			"list_undelivered_work_interaction_responses",
			{ ...filter, limit: 50 },
			timeoutMs,
		);
		const parsed =
			ListUndeliveredWorkInteractionResponsesResultSchema.safeParse(value);
		if (!parsed.success) {
			failed?.("the server answered with an unexpected shape");
			return undefined;
		}
		return parsed.data.data.filter(
			(answer) =>
				!filter.sessionId ||
				answer.sessionId.toLowerCase() === filter.sessionId.toLowerCase(),
		);
	} catch (error) {
		failed?.((error as Error).message || String(error));
		return undefined;
	}
}

/** The question without the "repo · host waiting: " prefix every capture subject has. */
export function questionOf(subject: string): string {
	const plain = markdownLineToPlainText(subject) || subject;
	return (plain.replace(/^[^:]{0,80}\bwaiting:\s*/i, "") || plain).slice(
		0,
		160,
	);
}

/**
 * The text a session receives for the user's own answers, in the delivered
 * reply framing ("The user replied in Tedix OS: …"). It says they are the
 * user's answers, never a tedi draft, and names each question when several
 * arrive together. Bodies are JSON strings so they read as data.
 */
export function answersMessage(
	answers: PendingAnswer[],
	limit: number = ANSWERS_LIMIT,
): string {
	const each = Math.max(400, Math.floor(limit / Math.max(answers.length, 1)));
	const quoted = (answer: PendingAnswer) =>
		answer.body.length > each
			? `${JSON.stringify(answer.body.slice(0, each))} (truncated; read the full answer with tedix work interaction-get ${answer.requestId})`
			: JSON.stringify(answer.body);
	if (answers.length === 1) {
		const [answer] = answers as [PendingAnswer];
		return `The user replied in Tedix OS: ${quoted(answer)}\nThis is the user's own answer (not a tedi draft) to your question ${JSON.stringify(questionOf(answer.subject))}. Act on it as their reply.`;
	}
	return [
		`The user replied in Tedix OS to ${answers.length} of your questions. These are the user's own answers, not tedi drafts; act on each, oldest first:`,
		...answers.map(
			(answer, index) =>
				`${index + 1}. To ${JSON.stringify(questionOf(answer.subject))}: ${quoted(answer)}`,
		),
	].join("\n");
}

/**
 * When the session's newest question is among the answers, claim its turn
 * state so the next prompt neither re-answers nor re-delivers it. False when a
 * typed reply already claimed it: nothing is delivered then.
 */
export function claimAnsweredQuestion(
	state: string,
	question: { requestId: string; token: string } | undefined,
	answers: PendingAnswer[],
): boolean {
	if (
		!question ||
		!answers.some((answer) => answer.requestId === question.requestId)
	)
		return true;
	const claimed = claim(state);
	if (claimed?.token !== question.token) {
		if (claimed) writeState(state, claimed);
		return false;
	}
	if (peek(questionPath(state))?.requestId === question.requestId)
		claim(questionPath(state));
	return true;
}
