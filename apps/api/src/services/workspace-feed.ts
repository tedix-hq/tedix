/**
 * Workspace change feed, core side.
 *
 * Producer: the core API still writes outputs today, so after each output
 * write it appends to the core-side ledger and sends the event through the
 * automation-events queue, exactly as a workspace object will through
 * `@tedix/workspace-feed/feed`. When the workspace object owns the write
 * path this producer goes away; the consumer and projections stay.
 *
 * Consumer: `handleWorkspaceChangeMessage` applies one queue message to the
 * projections and answers "ack" or "retry" for the automation-events loop.
 */

import {
	type WorkspaceChangeEvent,
	type WorkspaceChangeInput,
	type WorkspaceChangeSummary,
	organizationFeedScope,
} from "@tedix/api-contract/schemas/workspace-feed";
import { env } from "cloudflare:workers";
import type { WorkspaceOutputRuntime } from "@tedix/db/queries/durable-sqlite/output-rpc";
import { removeSharedWorkspaceOutputIndex } from "@tedix/db/queries/workspace-feed/read";
import { appendWorkspaceFeedLedger } from "@tedix/db/queries/workspace-feed/ledger";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";
import type {
	OsOutputRevisionRow,
	OsOutputRow,
} from "@tedix/db/schema/os-workspaces";
import { createWorkspaceFeedConsumer } from "@tedix/workspace-feed/consumer";
import {
	WORKSPACE_CHANGE_EXCERPT_MAX,
	parseWorkspaceChangeMessage,
	toWorkspaceChangeMessage,
} from "@tedix/workspace-feed/event";

/** The feed scope an output belongs to. */
export function outputFeedScope(
	output: Pick<OsOutputRow, "organizationId" | "workspaceId">,
): string {
	return output.workspaceId ?? organizationFeedScope(output.organizationId);
}

/**
 * Collect the human-readable strings of a body, bounded, for the search
 * index. Works on every output kind without knowing its block grammar.
 */
export function excerptFromContent(content: string | null | undefined): string {
	if (!content) return "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return "";
	}
	const parts: string[] = [];
	let length = 0;
	const visit = (value: unknown): void => {
		if (length >= WORKSPACE_CHANGE_EXCERPT_MAX) return;
		if (typeof value === "string") {
			const text = value.replace(/\s+/g, " ").trim();
			if (!text || /^[0-9a-f-]{36}$/i.test(text)) return;
			parts.push(text);
			length += text.length + 1;
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value && typeof value === "object") {
			for (const [key, item] of Object.entries(value)) {
				if (key === "kind" || key === "type" || key === "id") continue;
				visit(item);
			}
		}
	};
	visit(parsed);
	return parts.join(" ").slice(0, WORKSPACE_CHANGE_EXCERPT_MAX);
}

/** The change an output revision write produces. */
export function outputRevisionChange(
	output: OsOutputRow,
	revision: Omit<OsOutputRevisionRow, "content"> & { content?: string },
	options: { workItemIds?: string[] } = {},
): WorkspaceChangeInput {
	const summary: WorkspaceChangeSummary = {
		title: output.title,
		outputKind: output.kind,
		status: output.status,
		note: revision.note ?? null,
		createdBy: { kind: output.createdByKind, id: output.createdById },
		createdAt: output.createdAt,
		skillRunId: revision.skillRunId ?? null,
		skillId: revision.skillId ?? null,
		accessEnvelope: revision.accessEnvelope ?? null,
		contentSha256: revision.contentSha256 ?? null,
		contentBytes: revision.contentBytes ?? null,
		bodyR2Key: revision.bodyR2Key ?? null,
		...(options.workItemIds ? { workItemIds: options.workItemIds } : {}),
	};
	const excerpt = excerptFromContent(revision.content);
	if (excerpt) summary.excerpt = excerpt;
	return {
		workspaceId: outputFeedScope(output),
		organizationId: output.organizationId,
		kind: "output",
		id: output.id,
		revision: revision.revision,
		actor: { kind: revision.createdByKind, id: revision.createdById },
		changeRecordId: revision.id,
		at: revision.createdAt,
		summary,
	};
}

/** The change a rename, move, archive or restore produces: same revision, new metadata. */
export function outputMetadataChange(
	output: OsOutputRow,
	current: Pick<OsOutputRevisionRow, "id" | "revision">,
	actor: WorkspaceChangeInput["actor"],
	at = new Date().toISOString(),
): WorkspaceChangeInput {
	return {
		workspaceId: outputFeedScope(output),
		organizationId: output.organizationId,
		kind: "output",
		id: output.id,
		revision: current.revision,
		actor,
		changeRecordId: current.id,
		at,
		summary: {
			title: output.title,
			outputKind: output.kind,
			status: output.status,
			description: `${output.status === "archived" ? "Archived" : "Updated"} ${output.title}`,
		},
	};
}

/**
 * Whether this workspace's files live in the shared database rather than in
 * the workspace's own store. The same test `publishWorkspaceChange` applies.
 */
export async function workspaceOutputsInSharedStore(
	input: Pick<WorkspaceChangeInput, "organizationId" | "workspaceId">,
): Promise<boolean> {
	const store = (
		env as unknown as { WORKSPACE_RUNTIME?: WorkspaceOutputRuntime }
	).WORKSPACE_RUNTIME;
	return (
		!store ||
		(await store.outputQuery(
			{ organizationId: input.organizationId, workspaceId: input.workspaceId },
			{ op: "authority" },
		)) === "shared"
	);
}

export interface WorkspaceFeedPublisher {
	/** The client the write used, so ledger and projection land in the same database. */
	db: DbQueryClient;
	/** The automation-events queue; absent in tests and minimal installs. */
	queue?: Pick<Queue, "send"> | null;
}

/**
 * Append to the core ledger, project, and send.
 *
 * The core writer sits next to the projection tables, so it applies the
 * event in-process right after the ledger append: org-level views see the
 * change before this call returns, with or without a queue consumer (local
 * runs have none). The event still travels the queue so the same consumer
 * path a workspace object uses is exercised; the consumer acknowledges the
 * already-applied seq without effect.
 */
export async function publishWorkspaceChange(
	publisher: WorkspaceFeedPublisher,
	input: WorkspaceChangeInput,
): Promise<WorkspaceChangeEvent> {
	const event = await appendWorkspaceFeedLedger(publisher.db, input);
	await createWorkspaceFeedConsumer({ db: publisher.db }).applyEvents([event]);
	if (input.kind === "output") {
		const store = (
			env as unknown as { WORKSPACE_RUNTIME?: WorkspaceOutputRuntime }
		).WORKSPACE_RUNTIME;
		const scope = {
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
		};
		if (
			!store ||
			(await store.outputQuery(scope, { op: "authority" })) === "shared"
		)
			await removeSharedWorkspaceOutputIndex(publisher.db, scope);
	}
	if (publisher.queue) {
		await publisher.queue.send(toWorkspaceChangeMessage(event), {
			contentType: "json",
		});
	}
	return event;
}

/**
 * Publish and project before the write returns, so a read that follows the
 * write already sees it. A feed failure is logged, never raised: the
 * projection is rebuildable from the ledger, the write it describes is not.
 */
export async function publishWorkspaceChangeSafely(
	publisher: WorkspaceFeedPublisher,
	input: WorkspaceChangeInput,
): Promise<void> {
	try {
		await publishWorkspaceChange(publisher, input);
	} catch (error) {
		console.warn("[workspace-feed] publish failed", {
			workspaceId: input.workspaceId,
			kind: input.kind,
			id: input.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Apply one `workspace_change` queue message. Poison acks; a gap or failure retries. */
export async function handleWorkspaceChangeMessage(
	env: Pick<CloudflareEnv, "DB">,
	body: unknown,
): Promise<"ack" | "retry"> {
	const message = parseWorkspaceChangeMessage(body);
	if (!message) return "ack";
	const consumer = createWorkspaceFeedConsumer({
		db: createDbQueryClient(env.DB),
		log: (text, detail) => console.warn(text, detail),
	});
	let outcome: "ack" | "retry" = "retry";
	await consumer.consume([
		{
			body,
			ack: () => {
				outcome = "ack";
			},
			retry: () => {
				outcome = "retry";
			},
		},
	]);
	return outcome;
}
