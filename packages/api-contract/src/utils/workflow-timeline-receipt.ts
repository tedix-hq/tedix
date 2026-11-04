import * as z from "zod";
import {
	SkillWorkflowTimelineEventSchema,
	type SkillWorkflowTimelineEvent,
} from "../schemas/cognitive";

/**
 * Stored form of a workflow timeline receipt (`timeline/epochs/...` rows).
 *
 * Receipts stay inline in D1 so they survive isolate replay, so every byte
 * counts. Fields the row already carries are dropped: `id`, `path` and
 * `executionEpoch` come from the row path, `lane` from namespace/host/kind,
 * and `endedAt` from `startedAt + durationMs` whenever that is exact.
 * Decoding restores the full event, identical to the schema-1 receipt.
 */
export const SkillWorkflowTimelineReceiptSchema = z.object({
	v: z.literal(2),
	k: SkillWorkflowTimelineEventSchema.shape.kind,
	n: z.string(),
	/** count, omitted when 1 */
	c: z.number().int().nonnegative().optional(),
	a: z.number().int().positive().optional(),
	p: SkillWorkflowTimelineEventSchema.shape.phase,
	/** startedAt as epoch ms, or the original string when not canonical ISO */
	s: z.union([z.number(), z.string()]).optional(),
	/** endedAt, only when it differs from s + d (null when s + d exists) */
	e: z.string().nullable().optional(),
	d: z.number().nonnegative().optional(),
	st: z.string(),
	o: SkillWorkflowTimelineEventSchema.shape.outcome,
	ns: z.string().optional(),
	m: z.string().optional(),
	h: z.string().optional(),
	/** httpStatus; null is kept as null */
	hs: z.number().int().nullable().optional(),
	/** lane, only when it differs from namespace ?? host ?? kind */
	l: z.string().optional(),
});
export type SkillWorkflowTimelineReceipt = z.infer<
	typeof SkillWorkflowTimelineReceiptSchema
>;

function isoMs(value: string): number | null {
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value
		? ms
		: null;
}

export function encodeTimelineReceipt(
	event: SkillWorkflowTimelineEvent,
): SkillWorkflowTimelineReceipt {
	const startMs = event.startedAt === null ? null : isoMs(event.startedAt);
	const derivedEnd =
		startMs !== null &&
		event.durationMs !== null &&
		Number.isInteger(event.durationMs)
			? new Date(startMs + event.durationMs).toISOString()
			: null;
	const receipt: SkillWorkflowTimelineReceipt = {
		v: 2,
		k: event.kind,
		n: event.name,
		...(event.count === 1 ? {} : { c: event.count }),
		...(event.attempt === undefined ? {} : { a: event.attempt }),
		...(event.phase === undefined ? {} : { p: event.phase }),
		...(event.startedAt === null ? {} : { s: startMs ?? event.startedAt }),
		...(event.endedAt === derivedEnd ? {} : { e: event.endedAt }),
		...(event.durationMs === null ? {} : { d: event.durationMs }),
		st: event.status,
		o: event.outcome,
		...(event.namespace === undefined ? {} : { ns: event.namespace }),
		...(event.method === undefined ? {} : { m: event.method }),
		...(event.host === undefined ? {} : { h: event.host }),
		...(event.httpStatus === undefined ? {} : { hs: event.httpStatus }),
		...(event.lane === (event.namespace ?? event.host ?? event.kind)
			? {}
			: { l: event.lane }),
	};
	return receipt;
}

/**
 * Restore the full event. `path` is the original evidence path (the row path
 * without its `timeline/` prefix) and `executionEpoch` comes from that path.
 */
export function decodeTimelineReceipt(
	receipt: SkillWorkflowTimelineReceipt,
	path: string,
	executionEpoch: number,
): SkillWorkflowTimelineEvent {
	const startedAt =
		receipt.s === undefined
			? null
			: typeof receipt.s === "number"
				? new Date(receipt.s).toISOString()
				: receipt.s;
	const durationMs = receipt.d ?? null;
	const endedAt =
		receipt.e !== undefined
			? receipt.e
			: typeof receipt.s === "number" && durationMs !== null
				? new Date(receipt.s + durationMs).toISOString()
				: null;
	return SkillWorkflowTimelineEventSchema.parse({
		schemaVersion: 1,
		id: path,
		path,
		executionEpoch,
		kind: receipt.k,
		name: receipt.n,
		count: receipt.c ?? 1,
		attempt: receipt.a,
		phase: receipt.p,
		lane: receipt.l ?? receipt.ns ?? receipt.h ?? receipt.k,
		startedAt,
		endedAt,
		durationMs,
		status: receipt.st,
		outcome: receipt.o,
		namespace: receipt.ns,
		method: receipt.m,
		host: receipt.h,
		httpStatus: receipt.hs,
	});
}
