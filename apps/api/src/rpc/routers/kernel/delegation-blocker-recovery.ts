import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { BaseContext } from "../../orpc";
import type { DelegationBlocker } from "./delegated-stop";
import type {
	DelegationAttemptResult,
	DelegationRecoveryHint,
} from "./delegation-work-item";
import {
	errorMessage,
	nonNullRecord,
	numberFromPayload,
} from "./runtime-shared";

/**
 * What Home does when a delegated tedi reports that it could not start.
 *
 * The child's blocker arrives as data (`DelegationBlocker`) together with the
 * recovery hint the attempt settlement wrote (`reroute_to_home` for a missing
 * repository, access or capability; `redispatch_same_work_order` for a
 * transient fault). Home consumes that hint exactly once per delegation:
 *
 * - `reroute`: another tedi has what is missing — the same work order goes to
 *   it, and the person reads one line saying who has it now.
 * - `retry`:   a transient fault gets one more try, on the same tedi.
 * - `ask`:     nothing can cover the gap, or a recovery already ran — the
 *   person gets exactly one question naming the thing to connect or allow.
 *
 * Every branch ends in a visible sentence; none relays tool output.
 */

/** The slice of a tedi capability card the decision needs. */
export type RerouteCandidate = {
	tediId: string;
	name: string;
	availability: string;
	hasRepository: boolean;
	apps: string[];
	webSearch?: boolean;
};

export type BlockerRecoveryDecision =
	| { action: "retry" }
	| { action: "reroute"; tediId: string; tediName: string }
	| { action: "ask"; question: string };

export type BlockerRecoveryResult = {
	decision: BlockerRecoveryDecision;
	/** The one sentence (or question) the person reads. */
	message: string;
	/** Set when a retry/re-route was decided but the dispatch did not land. */
	dispatchError?: string;
};

const WEB_CAPABILITY_RE = /\b(?:web|internet|search|browser|browse)\b/i;

function plainDetail(detail: string): string {
	const trimmed = detail.trim().replace(/[.\s]+$/, "");
	if (!trimmed) return "something it needs is missing";
	return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** The one question Home asks when no tedi can cover the gap. */
export function blockerQuestion(input: {
	blocker: DelegationBlocker;
	tediName: string;
}): string {
	const who = input.tediName.trim() || "the worker";
	const detail = plainDetail(input.blocker.detail);
	switch (input.blocker.kind) {
		case "missing_repository":
			return `I can't do this yet: ${detail}. Can you connect the repository ${who} should work in?`;
		case "missing_access":
			return `I can't do this yet: ${detail}. Can you allow ${who} access to it?`;
		case "missing_capability":
			return `I can't do this yet: ${detail}. Which app or tool should I connect for this?`;
		case "transient":
			return `This hit a temporary problem and a second try did not help: ${detail}. Want me to try again later?`;
	}
}

/**
 * Pick the tedi that has what the blocked one lacks. A repository gap goes to
 * a running tedi with a configured repository; a capability gap to a running
 * tedi whose connected apps (or web search) match the missing piece. Access
 * gaps are per-person grants, so nothing is picked and Home asks.
 */
export function pickRerouteTarget(input: {
	blocker: DelegationBlocker;
	currentTediId: string;
	candidates: readonly RerouteCandidate[];
}): RerouteCandidate | null {
	const running = input.candidates.filter(
		(candidate) =>
			candidate.tediId !== input.currentTediId &&
			candidate.availability === "running",
	);
	switch (input.blocker.kind) {
		case "missing_repository":
			return running.find((candidate) => candidate.hasRepository) ?? null;
		case "missing_capability": {
			const detail = input.blocker.detail.toLowerCase();
			const byApp = running.find((candidate) =>
				candidate.apps.some(
					(slug) => slug.length >= 3 && detail.includes(slug.toLowerCase()),
				),
			);
			if (byApp) return byApp;
			if (WEB_CAPABILITY_RE.test(detail))
				return (
					running.find((candidate) => candidate.webSearch === true) ?? null
				);
			return null;
		}
		case "missing_access":
		case "transient":
			return null;
	}
}

/** Pure decision over the blocker, the settlement's hint and the retry history. */
export function decideBlockerRecovery(input: {
	blocker: DelegationBlocker;
	recoveryHints: readonly DelegationRecoveryHint[];
	/** Recovery dispatches already spent on this delegation. */
	retryCount: number;
	currentTediId: string;
	tediName: string;
	candidates: readonly RerouteCandidate[];
}): BlockerRecoveryDecision {
	const ask = (): BlockerRecoveryDecision => ({
		action: "ask",
		question: blockerQuestion({
			blocker: input.blocker,
			tediName: input.tediName,
		}),
	});
	// One recovery per delegation: a re-routed or retried child that is blocked
	// again ends with the person, never in a loop.
	if (input.retryCount > 0) return ask();
	if (
		input.blocker.kind === "transient" &&
		input.recoveryHints.includes("redispatch_same_work_order")
	)
		return { action: "retry" };
	if (input.recoveryHints.includes("reroute_to_home")) {
		const target = pickRerouteTarget({
			blocker: input.blocker,
			currentTediId: input.currentTediId,
			candidates: input.candidates,
		});
		if (target)
			return {
				action: "reroute",
				tediId: target.tediId,
				tediName: target.name,
			};
	}
	return ask();
}

/** The sentence the person reads for a decision. */
export function blockerRecoveryMessage(input: {
	decision: BlockerRecoveryDecision;
	blocker: DelegationBlocker;
	tediName: string;
}): string {
	const who = input.tediName.trim() || "The worker";
	const detail = plainDetail(input.blocker.detail);
	switch (input.decision.action) {
		case "reroute":
			return `${who} couldn't do this: ${detail}. I've handed it to ${input.decision.tediName}, who has what's needed.`;
		case "retry":
			return `${who} hit a temporary problem: ${detail}. Trying once more.`;
		case "ask":
			return input.decision.question;
	}
}

/** Recovery dispatches already spent on this delegation, from the Home run row. */
export function delegationRetryCountFromRun(
	run: Pick<HomeRun, "metadata">,
): number {
	return numberFromPayload(nonNullRecord(run.metadata)?.retryCount) ?? 0;
}

/**
 * Decide and, for retry/re-route, dispatch. Fail-soft on every read and on the
 * dispatch itself: whatever goes wrong, the person still gets one question.
 */
export async function recoverBlockedDelegation(
	context: BaseContext,
	input: {
		blocker: DelegationBlocker;
		disposition: Pick<DelegationAttemptResult, "recoveryHints"> | null;
		row: KernelRuntimeRun;
		run: HomeRun;
		tediName: string;
		workItemId: string | null;
	},
): Promise<BlockerRecoveryResult> {
	const currentTediId = input.row.delegatedTediId ?? "";
	let candidates: RerouteCandidate[] = [];
	try {
		const { getTediCapabilityCards } = await import("./tedi-capabilities");
		const cards = await getTediCapabilityCards(
			context.db,
			input.row.organizationId,
		);
		candidates = cards.map((card) => ({
			tediId: card.tediId,
			name: card.name,
			availability: card.availability,
			hasRepository: card.hasRepository,
			apps: card.apps,
			webSearch: card.webSearch,
		}));
	} catch (error) {
		console.warn("[kernelRuntime] blocker recovery capability read failed", {
			error: errorMessage(error),
			runId: input.row.id,
		});
	}
	const decision = decideBlockerRecovery({
		blocker: input.blocker,
		recoveryHints: input.disposition?.recoveryHints ?? [],
		retryCount: delegationRetryCountFromRun(input.run),
		currentTediId,
		tediName: input.tediName,
		candidates,
	});
	const ask = (dispatchError?: string): BlockerRecoveryResult => {
		const fallback: BlockerRecoveryDecision = {
			action: "ask",
			question: blockerQuestion({
				blocker: input.blocker,
				tediName: input.tediName,
			}),
		};
		return {
			decision: fallback,
			message: blockerRecoveryMessage({
				decision: fallback,
				blocker: input.blocker,
				tediName: input.tediName,
			}),
			...(dispatchError ? { dispatchError } : {}),
		};
	};
	if (decision.action === "ask") return ask();
	if (!input.workItemId) return ask("no linked Work Item to re-dispatch");
	try {
		const { retryDelegationWorkItem } =
			await import("../kernel-runtime/control-proposals");
		await retryDelegationWorkItem(context, {
			organizationId: input.row.organizationId,
			workItemId: input.workItemId,
			trigger: "home-blocker-recovery",
			...(decision.action === "reroute"
				? { targetTediId: decision.tediId }
				: {}),
		});
	} catch (error) {
		const reason = errorMessage(error);
		console.warn("[kernelRuntime] blocker recovery dispatch failed", {
			error: reason,
			runId: input.row.id,
			action: decision.action,
		});
		return ask(reason);
	}
	return {
		decision,
		message: blockerRecoveryMessage({
			decision,
			blocker: input.blocker,
			tediName: input.tediName,
		}),
	};
}
