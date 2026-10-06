/**
 * Native-surface correlation for the CROSS-SURFACE milestone vocabulary in
 * `@tedix/chat-transport/client-turn-milestones`. The names are typed against
 * that contract rather than `string`, so a milestone this surface emits can no
 * longer drift away from the one the embedded lane and the server-side
 * `metrics()` capability validate against — divergence is a compile error.
 */
import type { ClientTurnMilestoneName } from "@tedix/chat-transport/client-turn-milestones";

type NativeTurnCorrelation = {
	conversationId: string | null;
	emitted: Set<ClientTurnMilestoneName>;
	startedAt: number;
};

const CAPACITY = 200;
const turns = new Map<string, NativeTurnCorrelation>();

export function armNativeTurn(
	runId: string,
	conversationId: string | null = null,
	startedAt = Date.now(),
): void {
	turns.delete(runId);
	turns.set(runId, { conversationId, emitted: new Set(), startedAt });
	while (turns.size > CAPACITY) turns.delete(turns.keys().next().value!);
}

export function bindNativeTurn(runId: string, conversationId: string): void {
	const current = turns.get(runId);
	if (current) current.conversationId = conversationId;
}

export function readNativeTurn(runId: string): NativeTurnCorrelation | null {
	return turns.get(runId) ?? null;
}

export function markNativeTurnMilestone(
	runId: string,
	milestone: ClientTurnMilestoneName,
): NativeTurnCorrelation | null {
	const current = turns.get(runId);
	if (!current || current.emitted.has(milestone)) return null;
	current.emitted.add(milestone);
	return current;
}

export function finishNativeTurn(runId: string): NativeTurnCorrelation | null {
	const current = turns.get(runId) ?? null;
	turns.delete(runId);
	return current;
}
