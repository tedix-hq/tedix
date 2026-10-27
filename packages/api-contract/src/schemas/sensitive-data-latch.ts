/**
 * Sensitive-data latch for a run.
 *
 * When a skill run or Home (kernel) run reads from a source that is declared
 * sensitive — an `app_tools` row with `sensitive_data`, or a connection whose
 * stored classification is `restricted` — the run row records a latch. While
 * the latch is set, the run may not send data outside the organization
 * (tools declared `public_egress`, OS share links) and no grant or policy may
 * approve an action on its behalf. An owner or admin reviews and clears it;
 * the clear is an audit event. The latch lives on the run row, so it survives
 * workflow continuation and Home approval replay.
 */

import * as z from "zod";

export const SensitiveDataLatchReasonSchema = z.enum([
	"tool_declared_sensitive",
	"connection_restricted",
]);
export type SensitiveDataLatchReason = z.infer<
	typeof SensitiveDataLatchReasonSchema
>;

export const SensitiveDataLatchSchema = z.object({
	version: z.literal(1),
	latchedAt: z.string(),
	source: z.object({
		appSlug: z.string(),
		toolId: z.string(),
		connectionProviderId: z.string().nullable(),
		reason: SensitiveDataLatchReasonSchema,
	}),
});
export type SensitiveDataLatch = z.infer<typeof SensitiveDataLatchSchema>;

export const RunRefSchema = z.object({
	kind: z.enum(["skill_run", "kernel_run"]),
	id: z.string().min(1),
});
export type RunRef = z.infer<typeof RunRefSchema>;

export const LatchRunSensitiveDataInputSchema = z.object({
	organizationId: z.string().min(1),
	runRef: RunRefSchema,
	source: z.object({
		appSlug: z.string().min(1),
		toolId: z.string().min(1),
		connectionProviderId: z.string().min(1).nullable(),
		/** The `app_tools` row carries `sensitive_data`. */
		toolDeclaredSensitive: z.boolean(),
	}),
});
export type LatchRunSensitiveDataInput = z.infer<
	typeof LatchRunSensitiveDataInputSchema
>;

export const RunSensitiveDataLatchStateSchema = z.object({
	/** False when no run row matches; the gateway treats that as not latched. */
	known: z.boolean(),
	latch: SensitiveDataLatchSchema.nullable(),
});
export type RunSensitiveDataLatchState = z.infer<
	typeof RunSensitiveDataLatchStateSchema
>;

export const ResolveRunSensitiveDataLatchInputSchema = z.object({
	organizationId: z.string().min(1),
	runRef: RunRefSchema,
});

export const RunSensitiveDataLatchQuerySchema = z.object({
	runRef: RunRefSchema,
});

export const ClearRunSensitiveDataLatchResultSchema = z.object({
	cleared: z.boolean(),
	latch: SensitiveDataLatchSchema.nullable(),
});

function describeSource(latch: SensitiveDataLatch): string {
	const { source } = latch;
	const where = source.connectionProviderId
		? `the ${source.connectionProviderId} connection`
		: `the ${source.appSlug} app`;
	return `${source.toolId} on ${where}`;
}

/** Plain-English refusal for an action blocked by the latch. */
export function sensitiveDataLatchRefusal(
	latch: SensitiveDataLatch,
	blocked: string,
): string {
	return (
		`${blocked} was not done: this run read data marked sensitive ` +
		`(${describeSource(latch)} at ${latch.latchedAt}), so it cannot send ` +
		"data outside the organization or be approved automatically. " +
		"Next step: an owner or admin reviews what was read and clears the " +
		"sensitive-data lock on this run (clear_run_sensitive_data_latch); " +
		"then retry. No side effect was executed."
	);
}
