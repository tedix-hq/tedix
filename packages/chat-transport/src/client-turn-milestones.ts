export const CLIENT_TURN_MILESTONES = [
	"ready",
	"session",
	"submitted",
	"acknowledged",
	"workspace_opened",
	"first_phase",
	"first_text",
	"terminal_received",
	"rendered",
	"reconnect_started",
	"reconnect_recovered",
	"failed",
] as const;

export type ClientTurnMilestoneName = (typeof CLIENT_TURN_MILESTONES)[number];

/** Content-free, client-observed milestone. Authority dimensions are server-owned. */
export interface ClientTurnMilestone {
	eventId: string;
	milestone: ClientTurnMilestoneName;
	durationMs: number;
	phase?: string;
	outcome?: "succeeded" | "failed" | "cancelled";
	errorCode?: string;
	reconnectAttempt?: number;
}

export interface ClientTurnMilestoneBatch {
	conversationId: string;
	clientRequestId: string;
	events: ClientTurnMilestone[];
}

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const EVENT_ID = /^[0-9a-f-]{36}$/i;
const BOUNDED_CODE = /^[A-Za-z0-9_.-]{1,80}$/;

export function validateClientTurnMilestoneBatch(
	value: unknown,
): ClientTurnMilestoneBatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Invalid client milestone batch");
	}
	const input = value as Partial<ClientTurnMilestoneBatch>;
	if (
		typeof input.conversationId !== "string" ||
		!ID.test(input.conversationId) ||
		typeof input.clientRequestId !== "string" ||
		!ID.test(input.clientRequestId) ||
		!Array.isArray(input.events) ||
		input.events.length < 1 ||
		input.events.length > 20
	) {
		throw new Error("Invalid client milestone batch");
	}
	const seen = new Set<string>();
	for (const event of input.events) {
		if (
			!event ||
			typeof event !== "object" ||
			Array.isArray(event) ||
			!EVENT_ID.test(event.eventId) ||
			seen.has(event.eventId) ||
			!CLIENT_TURN_MILESTONES.includes(event.milestone) ||
			!Number.isInteger(event.durationMs) ||
			event.durationMs < 0 ||
			event.durationMs > 300_000 ||
			(event.phase !== undefined && !BOUNDED_CODE.test(event.phase)) ||
			(event.errorCode !== undefined && !BOUNDED_CODE.test(event.errorCode)) ||
			(event.outcome !== undefined &&
				!(["succeeded", "failed", "cancelled"] as const).includes(
					event.outcome,
				)) ||
			(event.reconnectAttempt !== undefined &&
				(!Number.isInteger(event.reconnectAttempt) ||
					event.reconnectAttempt < 1 ||
					event.reconnectAttempt > 10)) ||
			Object.keys(event).some(
				(key) =>
					![
						"eventId",
						"milestone",
						"durationMs",
						"phase",
						"outcome",
						"errorCode",
						"reconnectAttempt",
					].includes(key),
			)
		) {
			throw new Error("Invalid client milestone event");
		}
		seen.add(event.eventId);
	}
	return input as ClientTurnMilestoneBatch;
}
