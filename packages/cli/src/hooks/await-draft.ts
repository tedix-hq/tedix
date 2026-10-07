/**
 * `tedix hooks await-draft`: a Codex-only synchronous Stop hook.
 *
 * Codex has no background rewake, but a Stop hook that prints
 * `{"decision":"block","reason":"..."}` makes Codex continue the turn with the
 * reason as a new prompt. This hook waits up to 5 minutes for the question
 * `capture-stop` opens for this turn and, when the server auto-delivers a tedi
 * draft for it (`latestDraft.delivery: "auto"`), prints that continuation with
 * the framed draft. It returns at once when no draft was queued, when the
 * draft is for review in Tedix OS, or when delivery is absent (older servers).
 *
 * Like `await-reply`, the question stays open for the user and the delivery
 * is recorded by ID only. Claude Code never runs it (it uses `await-reply`).
 * Every failure is silent: no output, exit 0.
 */
import { harnessOf } from "./agent-status";
import {
	autoDeliverable,
	awaitQuestion,
	deliverAutoDraft,
} from "./await-reply";
import {
	AGENT_IDENTITY_ENV,
	bindingFor,
	captureStatePath,
	draftStatusPath,
	interactionDetail,
	peek,
} from "./decision-capture";
import { CAPTURE_EVENT_LIMIT, type HookDeps, hostEvent } from "./hook-io";

export const AWAIT_DRAFT_MAX_MS = 300_000;
export const AWAIT_DRAFT_POLL_MS = 5000;
const DETAIL_TIMEOUT_MS = 10_000;
const FAILURE_LIMIT = 3;

export interface AwaitDraftOptions {
	sleep?: (ms: number) => Promise<void>;
	clock?: () => number;
	maxMs?: number;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** The Codex Stop continuation, or undefined to let the turn end. */
export async function runAwaitDraft(
	deps: HookDeps,
	options: AwaitDraftOptions = {},
): Promise<string | undefined> {
	const sleep = options.sleep ?? pause;
	const clock = options.clock ?? Date.now;
	const deadline = clock() + (options.maxMs ?? AWAIT_DRAFT_MAX_MS);
	const hostEnv = { ...deps.env };
	for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
	try {
		const { event, session } = hostEvent(
			deps.stdin,
			deps.env,
			CAPTURE_EVENT_LIMIT,
			{ requireIdentity: true },
		);
		// Claude Code is woken in the background by await-reply instead.
		if (harnessOf(event, deps.env) !== "codex") return undefined;
		const id = session!;
		const state = captureStatePath(deps.env, id);
		const before = peek(state)?.token;
		const binding = await bindingFor(deps, id);
		if (!binding) return undefined;
		const question = await awaitQuestion(state, before, sleep, clock, deadline);
		if (!question) return undefined;
		let failures = 0;
		for (;;) {
			// A reply or a newer turn took the question.
			if (peek(state)?.token !== question.token) return undefined;
			const queued = peek(draftStatusPath(state));
			if (queued?.requestId === question.requestId) {
				if (queued.status !== "queued") return undefined;
				const detail = await interactionDetail(
					deps,
					binding,
					question.requestId,
					DETAIL_TIMEOUT_MS,
				);
				if (!detail) {
					if (++failures >= FAILURE_LIMIT) return undefined;
				} else {
					failures = 0;
					if (detail.state !== "open") return undefined;
					if (autoDeliverable(detail, state))
						return JSON.stringify({
							decision: "block",
							reason: deliverAutoDraft(
								hostEnv,
								deps,
								event,
								state,
								question,
								detail.draft,
							),
						});
					// A review draft waits for the user in Tedix OS.
					if (detail.draft) return undefined;
				}
			}
			if (clock() + AWAIT_DRAFT_POLL_MS > deadline) return undefined;
			await sleep(AWAIT_DRAFT_POLL_MS);
		}
	} catch {
		return undefined;
	}
}
