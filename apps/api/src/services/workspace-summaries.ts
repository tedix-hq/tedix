/**
 * Workspace summary publisher and consumer.
 *
 * The workspace store (the tenant-scoped write path in apps/api) publishes a
 * complete summary snapshot per workspace to the core through the
 * automation-events queue. Messages carry the full snapshot — usage, run
 * status and Work links — so the consumer only applies it, idempotently in
 * revision order (newest wins). Cross-workspace readers (the org-wide Work
 * board's project links, admin and search workspace listings, workspace
 * usage views) read `os_workspace_summaries` instead of fanning out to the
 * workspace-scoped source tables.
 *
 * Kept outside `AutomationEventSchema`: like `request_filing`, this message
 * is internal-only — public automation producers cannot mint a workspace's
 * own summary.
 */

import type { DbClient } from "@tedix/db/client";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import {
	applyOsWorkspaceSummary,
	computeOsWorkspaceSummary,
	type OsWorkspaceSummaryPayload,
} from "@tedix/db/queries/os-workspaces/summaries";
import { createDbQueryClient } from "@tedix/db/query-client";
import * as z from "zod";

export const WORKSPACE_SUMMARY_MESSAGE_KIND = "workspace_summary" as const;

/**
 * The queue message: a complete, self-contained snapshot of one workspace's
 * summary row. `revision` (epoch milliseconds) is the newest-wins ordering
 * key; `publishedAt`/`appliedAt` bound observable lag.
 */
export const WorkspaceSummaryQueueMessageSchema = z.strictObject({
	kind: z.literal(WORKSPACE_SUMMARY_MESSAGE_KIND),
	organizationId: z.string().uuid(),
	workspaceId: z.string().uuid(),
	revision: z.number().int().positive(),
	usage: z.string(),
	runStatus: z.string(),
	workLinks: z.string(),
	publishedAt: z.string().min(1),
});
export type WorkspaceSummaryQueueMessage = z.infer<
	typeof WorkspaceSummaryQueueMessageSchema
>;

/** The event kinds that can move a workspace's usage or run-status rollup. */
const WORKSPACE_SUMMARY_EVENT_KINDS = new Set([
	"message.received",
	"message.completed",
	"run.started",
	"run.completed",
	"run.failed",
	"run.canceled",
	"conversation.updated",
]);

/**
 * Publish one fresh snapshot of a workspace's summary row. A missing queue
 * binding (tests, minimal installs) degrades to a no-op — the summary is a
 * rebuildable projection, never authoritative state.
 */
export async function publishOsWorkspaceSummary(
	env: Pick<CloudflareEnv, "AUTOMATION_EVENTS" | "DB">,
	params: { organizationId: string; workspaceId: string },
	now = Date.now(),
): Promise<{ queued: boolean }> {
	const queue = env.AUTOMATION_EVENTS;
	if (!queue) return { queued: false };
	const payload: OsWorkspaceSummaryPayload = await computeOsWorkspaceSummary(
		createDbQueryClient(env.DB),
		params,
	);
	const message: WorkspaceSummaryQueueMessage = {
		kind: WORKSPACE_SUMMARY_MESSAGE_KIND,
		organizationId: params.organizationId,
		workspaceId: params.workspaceId,
		revision: now,
		usage: JSON.stringify(payload.usage),
		runStatus: JSON.stringify(payload.runStatus),
		workLinks: JSON.stringify(payload.workLinks),
		publishedAt: new Date(now).toISOString(),
	};
	await queue.send(message);
	return { queued: true };
}

/**
 * Best-effort publish behind `waitUntil`, for write paths that must not pay
 * the compute+send cost on the request path. Never throws.
 */
export function scheduleOsWorkspaceSummaryPublish(
	context: {
		env: Pick<CloudflareEnv, "AUTOMATION_EVENTS" | "DB">;
		waitUntil?: (promise: Promise<unknown>) => void;
	},
	params: { organizationId: string; workspaceId: string },
): void {
	const work = publishOsWorkspaceSummary(context.env, params).catch(
		(error: unknown) =>
			console.warn("[workspace-summaries] publish failed", {
				organizationId: params.organizationId,
				workspaceId: params.workspaceId,
				error: error instanceof Error ? error.message : String(error),
			}),
	);
	if (context.waitUntil) context.waitUntil(work);
	else void work;
}

/**
 * Publish after a kernel runtime event when the event's conversation belongs
 * to a workspace and the kind can move the summary. The conversation lookup
 * is one indexed read — the alternative, trusting payload-carried workspace
 * context, misses run.* events that never carry it.
 */
export async function publishOsWorkspaceSummaryForKernelEvent(
	context: {
		env: Pick<CloudflareEnv, "AUTOMATION_EVENTS" | "DB">;
		waitUntil?: (promise: Promise<unknown>) => void;
	},
	db: DbClient,
	event: KernelRuntimeEvent,
): Promise<void> {
	// Summary rows are a side projection: callers persisting kernel events
	// (some without an env, such as swept-child failure propagation) must
	// never fail because of them.
	if (!context.env?.AUTOMATION_EVENTS) return;
	if (!WORKSPACE_SUMMARY_EVENT_KINDS.has(event.kind)) return;
	// The workspace binding lives on the conversation row.
	let workspaceId: string | null = null;
	try {
		const conversation = await getKernelConversation(db, {
			organizationId: event.organizationId,
			conversationId: event.conversationId,
		});
		workspaceId = conversation?.workspaceId ?? null;
	} catch (error) {
		console.warn("[workspace-summaries] conversation lookup failed", {
			organizationId: event.organizationId,
			conversationId: event.conversationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (!workspaceId) return;
	scheduleOsWorkspaceSummaryPublish(context, {
		organizationId: event.organizationId,
		workspaceId,
	});
}

/**
 * Consume one `workspace_summary` queue message: apply it idempotently,
 * newest revision wins. Poison shapes ack (never retry); an apply failure
 * asks for redelivery.
 */
export async function handleWorkspaceSummaryMessage(
	env: Pick<CloudflareEnv, "AUTOMATION_EVENTS"> & { DB: D1Database },
	body: unknown,
): Promise<"ack" | "retry"> {
	const parsed = WorkspaceSummaryQueueMessageSchema.safeParse(body);
	if (!parsed.success) return "ack";
	const message = parsed.data;
	try {
		await applyOsWorkspaceSummary(createDbQueryClient(env.DB), {
			organizationId: message.organizationId,
			workspaceId: message.workspaceId,
			revision: message.revision,
			usage: message.usage,
			runStatus: message.runStatus,
			workLinks: message.workLinks,
			publishedAt: message.publishedAt,
			appliedAt: new Date().toISOString(),
		});
		return "ack";
	} catch {
		return "retry";
	}
}
