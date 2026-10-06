import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import type { ConversationStreamFrame } from "@/lib/conversation-stream";

/** Local delivery metadata consumed by the shared realtime pump. */
export type ProjectionEnvelope = {
	generation: number;
	replay: boolean;
	kind: string;
	createdAt: string;
};

function payloadRecord(
	event: RuntimeStreamEvent,
): Record<string, unknown> | null {
	const payload = event.payload;
	if (payload === null || payload === undefined) return null;
	if (typeof payload !== "object" || Array.isArray(payload)) return null;
	return payload as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The approval id a durable event carries. It lives in `payload`, NOT at the
 * top level; the top-level read is tolerated only for forward compatibility if
 * the projection ever hoists it.
 */
export function approvalRequestIdOf(event: RuntimeStreamEvent): string | null {
	const payload = payloadRecord(event);
	const inPayload =
		payload === null ? null : nonEmptyString(payload.approvalRequestId);
	if (inPayload !== null) return inPayload;
	return nonEmptyString(event.approvalRequestId);
}

export function createProjectionEnvelope(options: {
	generation: number;
	replay: boolean;
	frame: ConversationStreamFrame;
}): ProjectionEnvelope {
	const { generation, replay, frame } = options;
	const event = frame.event;
	return {
		generation,
		replay,
		kind: event.kind,
		createdAt: event.createdAt,
	};
}
