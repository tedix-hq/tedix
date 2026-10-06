import { z } from "zod";

/** Version carried by every record in the derivative runtime-event stream. */
export const DERIVED_RUNTIME_EVENT_VERSION = 1 as const;

/**
 * Payload-free projection of a canonical cognitive runtime event.
 *
 * The canonical event payload can contain tool arguments, results, or errors.
 * It is deliberately absent here: K2 is an analytics/replay lane, not another
 * copy of the cognitive ledger.
 */
export const DerivedRuntimeEventEnvelopeSchema = z
	.object({
		version: z.literal(DERIVED_RUNTIME_EVENT_VERSION),
		type: z.literal("tedix.runtime-event.derived"),
		eventId: z.string().min(1).max(512),
		tediId: z.string().min(1).max(256),
		runId: z.string().min(1).max(512).nullable(),
		kind: z.string().min(1).max(128),
		sequence: z.number().int().nonnegative().nullable(),
		occurredAt: z.iso.datetime({ offset: true }),
		runtimeBackend: z.string().min(1).max(128).nullable(),
	})
	.strict();

export type DerivedRuntimeEventEnvelope = z.infer<
	typeof DerivedRuntimeEventEnvelopeSchema
>;

/** Stable idempotency key shared by every independent replay consumer. */
export function derivedRuntimeEventKey(
	event: Pick<DerivedRuntimeEventEnvelope, "version" | "eventId">,
): string {
	return `runtime-event:v${event.version}:${event.eventId}`;
}
