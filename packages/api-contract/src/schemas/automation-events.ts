/**
 * Automation events — the generic, tenant-agnostic message contract for the
 * `tedix-automation-events` Cloudflare Queue (push-based workflow triggers).
 *
 * A message IS the config: it names the org, the tedi, and what to dispatch —
 * either a pinned executable skill workflow (`skill_workflow`) or a real
 * delegated tedi turn (`tedi_turn`). The consumer (apps/api `queue()` handler)
 * holds zero tenant-specific logic; adding a new automated workflow for any
 * tenant means producing a new message shape-compatible event, not writing
 * platform code.
 */

import * as z from "zod";

export const AutomationEventSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("skill_workflow"),
		organizationId: z.string().uuid(),
		tediId: z.string().uuid(),
		/** Skill UUID — provide either skillId or slug. */
		skillId: z.string().optional(),
		slug: z.string().optional(),
		params: z.record(z.string(), z.unknown()).optional(),
		/** Producer-minted dedupe key; consumers must treat redelivery as a no-op. */
		idempotencyKey: z.string().min(1),
		/** Free-form producer tag for audit/tracing (e.g. "r2-event", "webhook:tableau"). */
		source: z.string().optional(),
	}),
	z.object({
		kind: z.literal("tedi_turn"),
		organizationId: z.string().uuid(),
		tediId: z.string().uuid(),
		content: z.string().min(1),
		conversationId: z.string().optional(),
		idempotencyKey: z.string().min(1),
		source: z.string().optional(),
	}),
]);

export type AutomationEvent = z.infer<typeof AutomationEventSchema>;

export const AutomationEmitInputSchema = z.object({
	event: AutomationEventSchema,
	/** Optional delivery delay in seconds (Queues native delaySeconds). */
	delaySeconds: z.number().int().min(0).max(43200).optional(),
});
export type AutomationEmitInput = z.infer<typeof AutomationEmitInputSchema>;

export const AutomationEmitOutputSchema = z.object({
	queued: z.boolean(),
	idempotencyKey: z.string(),
});
export type AutomationEmitOutput = z.infer<typeof AutomationEmitOutputSchema>;
