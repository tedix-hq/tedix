import * as z from "zod";

/** Finite adapters reuse each product's authorization and revision fences. */
export const DecisionEffectSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("create_owner_task"),
		workItemId: z.uuid(),
		title: z.string().trim().min(1).max(200),
		description: z.string().trim().min(1).max(10000),
	}),
	z.strictObject({
		kind: z.literal("accept_work"),
		workItemId: z.uuid(),
		doneLooksLike: z.string().trim().min(1).max(8000),
	}),
	z.strictObject({ kind: z.literal("complete_work"), workItemId: z.uuid() }),
	z.strictObject({
		kind: z.literal("record_adr"),
		workItemId: z.uuid(),
		commitSha: z.string().regex(/^[a-f0-9]{40}$/),
	}),
	z.strictObject({
		kind: z.literal("record_review"),
		workItemId: z.uuid(),
		outputId: z.uuid(),
		revisionId: z.uuid(),
	}),
	z.strictObject({
		kind: z.literal("file_request"),
		requestId: z.uuid(),
		projectId: z.uuid().nullable(),
		expectedProjectId: z.uuid().nullable(),
	}),
	z.strictObject({
		kind: z.literal("publish_docs"),
		siteId: z.uuid(),
		buildId: z.uuid(),
	}),
	z.strictObject({
		kind: z.literal("publish_support"),
		ticketId: z.uuid(),
		expectedVersion: z.number().int().positive(),
	}),
]);
