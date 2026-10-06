/**
 * `tedix hooks await-reply`: a Claude Code Stop hook registered with
 * `asyncRewake`, so it runs in the background and exit 2 wakes the session with
 * stderr shown to Claude.
 *
 * It waits for the question `capture-stop` opens for this turn, then polls
 * that Interaction with backoff until the signed-in user answers it in Tedix
 * OS (exit 2 with the answer), it closes otherwise, it expires, a reply typed
 * in the chat claims it, or four hours pass (exit 0). Only the user's own
 * answer wakes the session; a tedi-drafted reply that was never accepted
 * cannot, because a draft is not a response.
 *
 * Codex has no rewake; it receives an OS answer with the next prompt through
 * `prompt-context`. Every failure is silent and exits 0.
 */
import { harnessOf } from "./agent-status";
import {
	AGENT_IDENTITY_ENV,
	answeredElsewhere,
	type Binding,
	bindingFor,
	captureStatePath,
	claim,
	interactionDetail,
	peek,
	questionPath,
	writeState,
} from "./decision-capture";
import { CAPTURE_EVENT_LIMIT, type HookDeps, hostEvent, UUID } from "./hook-io";

export const AWAIT_FIRST_DELAY_MS = 5000;
export const AWAIT_MAX_DELAY_MS = 60_000;
export const AWAIT_MAX_MS = 4 * 60 * 60 * 1000;
/** How long to wait for the turn's question to be created. */
const QUESTION_WAIT_MS = 90_000;
const QUESTION_POLL_MS = 1000;
const DETAIL_TIMEOUT_MS = 15_000;
/** Consecutive failed reads after which polling stops (tool missing, signed out). */
const FAILURE_LIMIT = 6;
const ANSWER_LIMIT = 6000;

export interface AwaitOptions {
	sleep?: (ms: number) => Promise<void>;
	/** Monotonic-enough clock in milliseconds. */
	clock?: () => number;
	questionWaitMs?: number;
	maxMs?: number;
}

export interface AwaitResult {
	code: 0 | 2;
	message?: string;
}

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Next poll delay: 5s, doubling, capped at 60s. */
export function nextDelay(previous: number | undefined): number {
	return previous === undefined
		? AWAIT_FIRST_DELAY_MS
		: Math.min(previous * 2, AWAIT_MAX_DELAY_MS);
}

export async function runAwaitReply(
	deps: HookDeps,
	options: AwaitOptions = {},
): Promise<AwaitResult> {
	const sleep = options.sleep ?? pause;
	const clock = options.clock ?? Date.now;
	const started = clock();
	const deadline = started + (options.maxMs ?? AWAIT_MAX_MS);
	for (const key of AGENT_IDENTITY_ENV) delete deps.env[key];
	try {
		const { event, session } = hostEvent(
			deps.stdin,
			deps.env,
			CAPTURE_EVENT_LIMIT,
			{ requireIdentity: true },
		);
		// Codex cannot be woken; it reads OS answers on the next prompt.
		if (harnessOf(event, deps.env) === "codex") return { code: 0 };
		const id = session!;
		const state = captureStatePath(deps.env, id);
		// The question this Stop's capture-stop is about to open, not an older one.
		const before = peek(state)?.token;
		const binding = await bindingFor(deps, id);
		if (!binding) return { code: 0 };
		const question = await awaitQuestion(
			state,
			before,
			sleep,
			clock,
			started + (options.questionWaitMs ?? QUESTION_WAIT_MS),
		);
		if (!question) return { code: 0 };
		return await poll(deps, binding, id, state, question, {
			sleep,
			clock,
			deadline,
		});
	} catch {
		return { code: 0 };
	}
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

/** True while the chat's own reply has not claimed this question. */
function stillWaiting(state: string, token: string): boolean {
	return peek(state)?.token === token;
}

async function poll(
	deps: HookDeps,
	binding: Binding,
	session: string,
	state: string,
	question: { requestId: string; token: string },
	timing: {
		sleep: (ms: number) => Promise<void>;
		clock: () => number;
		deadline: number;
	},
): Promise<AwaitResult> {
	let delay: number | undefined;
	let failures = 0;
	for (;;) {
		delay = nextDelay(delay);
		if (timing.clock() + delay > timing.deadline) return { code: 0 };
		await timing.sleep(delay);
		if (!stillWaiting(state, question.token)) return { code: 0 };
		const detail = await interactionDetail(
			deps,
			binding,
			question.requestId,
			DETAIL_TIMEOUT_MS,
		);
		if (!detail) {
			if (++failures >= FAILURE_LIMIT) return { code: 0 };
			continue;
		}
		failures = 0;
		if (detail.state === "open") {
			if (detail.expiresAt && Date.parse(detail.expiresAt) <= Date.now())
				return { code: 0 };
			continue;
		}
		if (!answeredElsewhere(detail, binding.user, session)) return { code: 0 };
		// Claim the question so the next prompt neither re-answers nor re-delivers it.
		const claimed = claim(state);
		if (claimed?.token !== question.token) {
			if (claimed) writeState(state, claimed);
			return { code: 0 };
		}
		const local = peek(questionPath(state));
		if (local?.requestId === question.requestId) claim(questionPath(state));
		const answer = detail.resolution!;
		return {
			code: 2,
			message: `The user replied in Tedix OS: ${JSON.stringify(answer.body.slice(0, ANSWER_LIMIT))}${answer.complete ? "" : " (truncated; read the full answer with tedix work interaction-get before relying on omitted detail)"}`,
		};
	}
}
