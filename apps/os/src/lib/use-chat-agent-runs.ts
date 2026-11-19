import { useQueries } from "@tanstack/react-query";
import { useRef } from "react";
import { type AgentRunRef, agentRunsFromEvents } from "@/lib/agent-run-result";
import {
	homeChildRunActivityQueryOptions,
	homeChildRunEvidenceQueryOptions,
} from "@/lib/os-query-options";

/** Matches the live delegation card, so both share one request. */
const ACTIVITY_POLL_MS = 5_000;
/** A finished turn's events no longer change. */
const FINISHED_STALE_MS = 5 * 60_000;
/** How many finished turns, counted from the last, are read for run cards. */
const MAX_FINISHED_TURNS = 20;

type Delegation = {
	childRunId: string | null;
	delegatedTediId: string | null;
};

/**
 * The agent runs a tedi started in this chat, placed where their cards go.
 *
 * A tedi's tool results are not part of a chat message. They are kept in the
 * stored events of the tedi's own turn, so that is where a run is found: for a
 * finished turn under the message it answered with, for a turn still going
 * under its live card. Tool results that arrive on the chat's own stream are
 * read too. Each task gets one card.
 */
export function useChatAgentRuns({
	finished,
	active,
	streamEvents,
}: {
	/** Finished turns by the message they fold under, in run order. */
	finished: ReadonlyMap<string, Delegation>;
	active: readonly Delegation[];
	streamEvents: readonly { kind: string; payload?: unknown }[];
}): {
	forMessage: (messageId: string) => AgentRunRef[];
	forActive: (childRunId: string | null) => AgentRunRef[];
	fromStream: AgentRunRef[];
} {
	const branches = [
		...[...finished.entries()]
			.slice(-MAX_FINISHED_TURNS)
			.map(([messageId, work]) => ({ messageId, work, live: false })),
		...active.map((work) => ({ messageId: null, work, live: true })),
	].flatMap(({ messageId, work, live }) =>
		work.delegatedTediId && work.childRunId
			? [
					{
						messageId,
						live,
						delegatedTediId: work.delegatedTediId,
						childRunId: work.childRunId,
					},
				]
			: [],
	);
	const found = useQueries({
		queries: branches.map((branch) =>
			branch.live
				? {
						...homeChildRunActivityQueryOptions(
							branch.delegatedTediId,
							branch.childRunId,
						),
						refetchInterval: ACTIVITY_POLL_MS,
						retry: false,
					}
				: {
						...homeChildRunEvidenceQueryOptions(
							branch.delegatedTediId,
							branch.childRunId,
						),
						staleTime: FINISHED_STALE_MS,
						retry: false,
					},
		),
		combine: (results) =>
			results.map((result) =>
				agentRunsFromEvents(result.data?.evidence.events ?? []),
			),
	});

	// A live turn is read as its newest events only; a run found once stays
	// after its tool result has scrolled out of that slice.
	const kept = useRef(new Map<string, Map<string, AgentRunRef>>());
	const shown = new Set<string>();
	const byMessage = new Map<string, AgentRunRef[]>();
	const byActive = new Map<string, AgentRunRef[]>();
	branches.forEach((branch, index) => {
		let runs = kept.current.get(branch.childRunId);
		if (!runs) {
			runs = new Map();
			kept.current.set(branch.childRunId, runs);
		}
		for (const run of found[index] ?? [])
			if (!runs.has(run.workItemId)) runs.set(run.workItemId, run);
		const fresh = [...runs.values()].filter(
			(run) => !shown.has(run.workItemId),
		);
		for (const run of fresh) shown.add(run.workItemId);
		if (branch.messageId) byMessage.set(branch.messageId, fresh);
		else byActive.set(branch.childRunId, fresh);
	});
	const fromStream = agentRunsFromEvents(streamEvents).filter(
		(run) => !shown.has(run.workItemId),
	);
	return {
		forMessage: (messageId) => byMessage.get(messageId) ?? [],
		forActive: (childRunId) =>
			(childRunId ? byActive.get(childRunId) : undefined) ?? [],
		fromStream,
	};
}
