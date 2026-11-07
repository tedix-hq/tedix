/**
 * Workspace change feed contract.
 *
 * A workspace object emits one `WorkspaceChangeEvent` after each write. The
 * event names the record that changed and carries a bounded `summary` with
 * what the core projections need (titles, excerpts, Work links), never the
 * body. Events travel over the automation-events queue as a
 * `WorkspaceChangeQueueMessage`; the consumer applies them in `seq` order per
 * workspace and treats `(workspaceId, seq)` as the idempotency key.
 */

import * as z from "zod";

export const WORKSPACE_CHANGE_MESSAGE_KIND = "workspace_change" as const;

export const WorkspaceChangeKindSchema = z.enum([
	"output",
	"run",
	"artifact",
	"memory",
	"chat",
]);
export type WorkspaceChangeKind = z.infer<typeof WorkspaceChangeKindSchema>;

export const WorkspaceChangeActorSchema = z.strictObject({
	kind: z.enum(["user", "tedi", "external_agent", "service"]),
	id: z.string().min(1).max(200),
});
export type WorkspaceChangeActor = z.infer<typeof WorkspaceChangeActorSchema>;

/** Longest excerpt an event may carry; search indexes this, never the body. */
export const WORKSPACE_CHANGE_EXCERPT_MAX = 2_000;

/**
 * What the projections need beyond ids. Every field is optional so a writer
 * can emit a minimal event; the consumer keeps the previous value of any
 * output-level field a revision event leaves out.
 */
export const WorkspaceChangeSummarySchema = z
	.object({
		/** Record title (output title, run label, memory subject, chat title). */
		title: z.string().max(300).optional(),
		/** One line describing the change, for the activity list. */
		description: z.string().max(500).optional(),
		/** Searchable excerpt of the record's content. */
		excerpt: z.string().max(WORKSPACE_CHANGE_EXCERPT_MAX).optional(),
		/** Output fields (kind `output`). */
		outputKind: z
			.enum(["document", "sheet", "presentation", "video"])
			.optional(),
		status: z.enum(["active", "archived"]).optional(),
		note: z.string().max(2_000).nullable().optional(),
		createdBy: WorkspaceChangeActorSchema.optional(),
		createdAt: z.string().optional(),
		skillRunId: z.string().nullable().optional(),
		skillId: z.string().nullable().optional(),
		/** JSON OsDerivedAccessEnvelope string; null when unverifiable. */
		accessEnvelope: z.string().nullable().optional(),
		contentSha256: z.string().nullable().optional(),
		contentBytes: z.number().int().nonnegative().nullable().optional(),
		bodyR2Key: z.string().nullable().optional(),
		/** Work Items this record is linked to after the write; absent keeps the current links. */
		workItemIds: z.array(z.string().uuid()).max(100).optional(),
		/** Chat fields (kind `chat`): the conversation the message belongs to. */
		conversationId: z.string().max(200).optional(),
		channel: z.string().max(60).nullable().optional(),
		/** Run fields (kind `run`). */
		runStatus: z.string().max(40).optional(),
	})
	.strict();
export type WorkspaceChangeSummary = z.infer<
	typeof WorkspaceChangeSummarySchema
>;

export const WorkspaceChangeEventSchema = z.strictObject({
	/** The workspace object id, or `org:<organizationId>` for an organization-level record. */
	workspaceId: z.string().min(1).max(200),
	organizationId: z.string().min(1).max(200),
	kind: WorkspaceChangeKindSchema,
	/** The changed record's id (output id, run id, artifact id, memory id, message id). */
	id: z.string().min(1).max(200),
	/** Monotonic per record; 1 for a new record. */
	revision: z.number().int().nonnegative(),
	actor: WorkspaceChangeActorSchema,
	/** The workspace-side row that holds this change (revision row, run event, fact). */
	changeRecordId: z.string().min(1).max(200),
	/** Writer wall clock, ISO-8601. */
	at: z.string().datetime({ offset: true }),
	/** Contiguous per-workspace sequence, allocated by the workspace's ledger. */
	seq: z.number().int().positive(),
	summary: WorkspaceChangeSummarySchema.default({}),
});
export type WorkspaceChangeEvent = z.infer<typeof WorkspaceChangeEventSchema>;

/** What a writer hands to `feed.emit`: the event without its ledger-assigned `seq`. */
export type WorkspaceChangeInput = Omit<
	WorkspaceChangeEvent,
	"seq" | "summary"
> & { summary?: WorkspaceChangeSummary };

export const WorkspaceChangeQueueMessageSchema = z.strictObject({
	kind: z.literal(WORKSPACE_CHANGE_MESSAGE_KIND),
	event: WorkspaceChangeEventSchema,
});
export type WorkspaceChangeQueueMessage = z.infer<
	typeof WorkspaceChangeQueueMessageSchema
>;

/** Feed scope for records that belong to no workspace (organization-level outputs). */
export function organizationFeedScope(organizationId: string): string {
	return `org:${organizationId}`;
}

/** The workspace id a feed scope stands for; null for an organization scope. */
export function workspaceIdOfFeedScope(scope: string): string | null {
	return scope.startsWith("org:") ? null : scope;
}

/** One row of the org-level recent activity list. */
export const WorkspaceActivityItemSchema = z.object({
	id: z.string(),
	workspaceId: z.string().nullable(),
	seq: z.number().int(),
	kind: WorkspaceChangeKindSchema,
	entityId: z.string(),
	revision: z.number().int(),
	actor: WorkspaceChangeActorSchema,
	changeRecordId: z.string(),
	title: z.string().nullable(),
	summary: z.string().nullable(),
	occurredAt: z.string(),
});
export type WorkspaceActivityItem = z.infer<typeof WorkspaceActivityItemSchema>;

/** The queue idempotency key for one event. */
export function workspaceChangeIdempotencyKey(event: {
	workspaceId: string;
	seq: number;
}): string {
	return `${event.workspaceId}:${event.seq}`;
}

/** Per-kind counts and latest revisions, computed on either side of the feed. */
export const WorkspaceFeedSnapshotSchema = z.strictObject({
	workspaceId: z.string().min(1).max(200),
	lastSeq: z.number().int().nonnegative(),
	kinds: z.partialRecord(
		WorkspaceChangeKindSchema,
		z.strictObject({
			/** Distinct records of this kind. */
			records: z.number().int().nonnegative(),
			/** Events of this kind. */
			events: z.number().int().nonnegative(),
			/** Highest revision per record, keyed by record id. */
			latest: z.record(z.string(), z.number().int().nonnegative()),
		}),
	),
});
export type WorkspaceFeedSnapshot = z.infer<typeof WorkspaceFeedSnapshotSchema>;
