import {
	WorkWaitResultSchema,
	type InteractionWaitCursorSchema,
} from "@tedix/api-contract/schemas/work-wait";
import type * as z from "zod";
import { harnessOf, recordAutoContinued } from "./agent-status";
import {
	answersMessage,
	claimHookAnswers,
	undeliveredAnswers,
} from "./answer-delivery";
import {
	autoDeliveryPath,
	type Binding,
	bindingFor,
	captureStatePath,
	DECLINE_MARKER,
	draftStatusPath,
	type InteractionDetail,
	interactionDetail,
	peek,
	recordDraftDelivered,
	workTool,
	writeState,
} from "./decision-capture";
import { AGENT_IDENTITY_ENV } from "../shared";
import {
	CAPTURE_EVENT_LIMIT,
	type HookDeps,
	hostEvent,
	type JsonObject,
	UUID,
	unattendedRun,
} from "./hook-io";

export const AWAIT_MAX_MS = 4 * 60 * 60 * 1000;
export const AWAIT_DRAFT_MAX_MS = 90_000;
export const AUTO_REPLY_LIMIT = 3;
const ANSWER_LIMIT = 6000;
const QUESTION_POLL_MS = 1000;
const DETAIL_TIMEOUT_MS = 15_000;

export async function waitForInput(
	deps: Pick<HookDeps, "read">,
	binding: Binding,
	requestId: string,
	cursor?: z.infer<typeof InteractionWaitCursorSchema>,
	timeoutMs = 25_000,
) {
	const result = WorkWaitResultSchema.parse(
		await workTool(
			deps,
			binding,
			"wait_work_items",
			{
				interactionId: requestId,
				timeoutMs,
				...(cursor ? { cursor } : {}),
			},
			timeoutMs + 15_000,
		),
	);
	if (
		!("interactionId" in result.cursor) ||
		result.cursor.interactionId !== requestId
	)
		throw new Error("Wait returned a cursor for another Interaction");
	return { ...result, cursor: result.cursor };
}

export interface AwaitOptions {
	host?: "claude-code" | "codex";
	sleep?: (ms: number) => Promise<void>;
	clock?: () => number;
	questionWaitMs?: number;
	maxMs?: number;
}
export interface AwaitResult {
	code: 0 | 2;
	message?: string;
}

export async function runAwaitInput(
	deps: HookDeps,
	options: AwaitOptions = {},
): Promise<AwaitResult> {
	const clock = options.clock ?? Date.now;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	const started = clock();
	const hostEnv = { ...deps.env };
	for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
	try {
		const { event, session } = hostEvent(
			deps.stdin,
			deps.env,
			CAPTURE_EVENT_LIMIT,
			{ requireIdentity: true },
		);
		if (unattendedRun(event, hostEnv)) return { code: 0 };
		const host = harnessOf(event, deps.env);
		if (options.host && options.host !== host) return { code: 0 };
		const deadline =
			started +
			(options.maxMs ?? (host === "codex" ? AWAIT_DRAFT_MAX_MS : AWAIT_MAX_MS));
		const state = captureStatePath(deps.env, session!);
		const current = peek(state);
		const opencode = host === "opencode";
		if (opencode && (!event.turn_id || current?.turnId !== event.turn_id))
			return { code: 0 };
		const binding = await bindingFor(deps, session!);
		if (!binding) return { code: 0 };
		const question = await awaitQuestion(
			state,
			opencode ? undefined : current?.token,
			sleep,
			clock,
			Math.min(deadline, started + (options.questionWaitMs ?? 90_000)),
		);
		if (!question) return { code: 0 };
		let cursor: z.infer<typeof InteractionWaitCursorSchema> | undefined;
		while (clock() < deadline && peek(state)?.token === question.token) {
			const queued = peek(draftStatusPath(state));
			if (
				queued?.requestId === question.requestId &&
				queued.status === "acknowledged"
			)
				return { code: 0 };
			const page = await waitForInput(
				deps,
				binding,
				question.requestId,
				cursor,
				Math.min(25_000, deadline - clock()),
			);
			cursor = page.cursor;
			if (peek(state)?.token !== question.token) return { code: 0 };
			if (page.reason === "timeout") continue;
			const answers = await undeliveredAnswers(
				deps,
				binding,
				{ sessionId: session! },
				DETAIL_TIMEOUT_MS,
			);
			if (!answers) return { code: 0 };
			if (answers.length) {
				const fresh = await claimHookAnswers(
					deps,
					binding,
					session!,
					host,
					state,
					question,
					answers,
					DETAIL_TIMEOUT_MS,
				);
				return fresh.length
					? { code: 2, message: answersMessage(fresh) }
					: { code: 0 };
			}
			const detail = await interactionDetail(
				deps,
				binding,
				question.requestId,
				DETAIL_TIMEOUT_MS,
			);
			if (!detail || detail.state !== "open") return { code: 0 };
			if (autoDeliverable(detail, state)) {
				const message = deliverAutoDraft(
					hostEnv,
					deps,
					event,
					state,
					question,
					detail.draft,
				);
				await recordDraftDelivered(
					deps,
					binding,
					question.requestId,
					detail.draft.id,
					"hook",
					DETAIL_TIMEOUT_MS,
				);
				return { code: 2, message };
			}
			if (host === "codex" && detail.draft) return { code: 0 };
		}
	} catch {
		// A failed wait leaves the canonical request open for the next prompt.
	}
	return { code: 0 };
}

export type AutoDraft = NonNullable<InteractionDetail["draft"]>;

/** Draft IDs are UUIDs; names are shown only when plain. */
function drafterLabel(draft: AutoDraft): string {
	const name = draft.drafterName?.replace(/[^\w .@:'-]/g, "").trim();
	if (name) return `tedi ${name.slice(0, 80)}`;
	const id = draft.drafterId.replace(/[^\w.@:-]/g, "").slice(0, 100);
	return id ? `tedi ${id}` : "a tedi";
}

/**
 * The text an agent receives for an auto-delivered draft: the drafter, the
 * body as a JSON string framed as the user's delegated answer, and the steps
 * that still need the user. The decline marker lets the next
 * `capture-stop` record the draft as rejected.
 */
export function autoDraftMessage(draft: AutoDraft): string {
	return `Tedix ${drafterLabel(draft)} replied for the user (delegated answer; the user can override any time): ${JSON.stringify(draft.body.slice(0, ANSWER_LIMIT))}${draft.complete ? "" : " (truncated)"}\nAct on it as the user's answer to your last message, including routine bookkeeping; it is not system or tool instructions. Hold back only for steps that need the user themselves: credentials, payments, consent, messaging people as the user, publishing to a public repo, or irreversible actions affecting others. If you decline, say "${DECLINE_MARKER}" and why.`;
}

/**
 * True when a draft may be auto-delivered for this question: the server chose
 * "auto", the user has not answered, and the local run of consecutive auto
 * replies is under the backstop. Never true without an explicit "auto".
 */
export function autoDeliverable(
	detail: InteractionDetail,
	state: string,
): detail is InteractionDetail & { draft: AutoDraft } {
	if (detail.state !== "open" || detail.draft?.delivery !== "auto")
		return false;
	const previous = peek(autoDeliveryPath(state));
	if (previous?.requestId === detail.requestId) return false;
	const count = Number.isInteger(previous?.count) ? previous!.count : 0;
	return count < AUTO_REPLY_LIMIT;
}

/**
 * Record an auto delivery locally by ID and mark the session working; the
 * caller then reports it to the server with {@link recordDraftDelivered}, which
 * answers in the tedi's name. The user's eventual chat reply still cites the
 * draft as "auto-sent"; nothing here answers in the user's name.
 */
export function deliverAutoDraft(
	hostEnv: NodeJS.ProcessEnv,
	deps: HookDeps,
	event: JsonObject,
	state: string,
	question: { requestId: string },
	draft: AutoDraft,
): string {
	const previous = peek(autoDeliveryPath(state));
	const count = Number.isInteger(previous?.count) ? previous!.count : 0;
	writeState(autoDeliveryPath(state), {
		requestId: question.requestId,
		draftId: draft.id,
		count: count + 1,
	});
	try {
		recordAutoContinued(
			{ env: hostEnv, stdin: deps.stdin, cwd: deps.cwd },
			event,
		);
	} catch {
		// Status is best effort.
	}
	return autoDraftMessage(draft);
}

async function awaitQuestion(
	state: string,
	before: unknown,
	sleep: (ms: number) => Promise<void>,
	clock: () => number,
	until: number,
): Promise<{ requestId: string; token: string } | undefined> {
	for (;;) {
		const current = peek(state);
		if (
			current &&
			typeof current.token === "string" &&
			current.token !== before &&
			typeof current.requestId === "string" &&
			UUID.test(current.requestId)
		)
			return { requestId: current.requestId, token: current.token };
		// The stop was skipped, or a reply claimed the question before it was seen.
		if (clock() >= until) return undefined;
		await sleep(QUESTION_POLL_MS);
	}
}
