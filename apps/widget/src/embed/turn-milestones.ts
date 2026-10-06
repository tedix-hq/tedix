import type {
	ClientTurnMilestone,
	ClientTurnMilestoneBatch,
	ClientTurnMilestoneName,
} from "@tedix/chat-transport/client-turn-milestones";

const CODE = /^[A-Za-z0-9_.-]{1,80}$/;

function boundedCode(value: unknown): string | undefined {
	return typeof value === "string" && CODE.test(value) ? value : undefined;
}

/** One consent-aware, content-free milestone recorder for an embedded turn. */
export function createEmbeddedTurnMilestones(input: {
	conversationId: string;
	clientRequestId: string;
	enabled: () => boolean;
	send: (batch: ClientTurnMilestoneBatch) => void | Promise<void>;
	now?: () => number;
	eventId?: () => string;
}) {
	const startedAt = (input.now ?? Date.now)();
	const emitted = new Set<ClientTurnMilestoneName>();
	const now = input.now ?? Date.now;
	const eventId = input.eventId ?? crypto.randomUUID.bind(crypto);

	return {
		record(
			milestone: ClientTurnMilestoneName,
			detail: {
				phase?: unknown;
				outcome?: ClientTurnMilestone["outcome"];
				errorCode?: unknown;
				reconnectAttempt?: unknown;
			} = {},
		): boolean {
			if (!input.enabled() || emitted.has(milestone)) return false;
			emitted.add(milestone);
			const reconnectAttempt = Number(detail.reconnectAttempt);
			const event: ClientTurnMilestone = {
				eventId: eventId(),
				milestone,
				durationMs: Math.min(
					300_000,
					Math.max(0, Math.round(now() - startedAt)),
				),
				...(boundedCode(detail.phase)
					? { phase: boundedCode(detail.phase) }
					: {}),
				...(detail.outcome ? { outcome: detail.outcome } : {}),
				...(boundedCode(detail.errorCode)
					? { errorCode: boundedCode(detail.errorCode) }
					: {}),
				...(Number.isInteger(reconnectAttempt) &&
				reconnectAttempt >= 1 &&
				reconnectAttempt <= 10
					? { reconnectAttempt }
					: {}),
			};
			// Invoke immediately, but isolate synchronous throws as well as rejections.
			void (async () => {
				await input.send({
					conversationId: input.conversationId,
					clientRequestId: input.clientRequestId,
					events: [event],
				});
			})().catch(() => {});
			return true;
		},
	};
}
