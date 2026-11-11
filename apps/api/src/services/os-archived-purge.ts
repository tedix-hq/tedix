/**
 * Bulk permanent deletion of archived Tedix OS items, behind one approval.
 *
 * Each kind applies the rules its one-at-a-time delete applies and never
 * forces an item: anything that fails a rule is skipped and counted by reason.
 * Work is read in id-ordered pages and every database or storage call spends
 * from a fixed budget, so one call stays well inside a Worker invocation's
 * limits; when the budget or the time runs out the call stops cleanly and
 * reports how many archived items it did not reach.
 */
import type {
	OsArchivedPurgeInput,
	OsArchivedPurgeKind,
	OsArchivedPurgeKindResult,
	OsArchivedPurgeResult,
	OsArchivedPurgeSkipReason,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	insertAuditEventsBatch,
	type InsertAuditEventParams,
} from "@tedix/db/queries/audit";
import { listKernelConversationGrantsByConversation } from "@tedix/db/queries/kernel-conversation-access";
import {
	countArchivedKernelConversationPurgeCandidates,
	KERNEL_CONVERSATION_PURGE_CHUNK,
	listArchivedKernelConversationPurgeCandidates,
	listKernelConversationIdsWithActiveRuns,
	purgeKernelConversations,
} from "@tedix/db/queries/kernel-conversations";
import { listOsShareResourceIdsWithActiveLinks } from "@tedix/db/queries/os-shares";
import {
	countArchivedOsOutputPurgeCandidates,
	countArchivedOsWorkspacePurgeCandidates,
	listArchivedOsOutputPurgeCandidateIds,
	listArchivedOsWorkspacePurgeCandidates,
} from "@tedix/db/queries/os-workspaces/archived-purge";
import { listOsIdsWithCollaborationProposals } from "@tedix/db/queries/os-workspaces/collaboration";
import { deleteOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { hasProviderInstallationForWorkspace } from "@tedix/db/queries/provider-installations";
import { createDbQueryClient } from "@tedix/db/query-client";
import { toJsonRecord } from "@tedix/db/utils/json";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { auditActor } from "../rpc/audit-helpers";
import { requireOrgId } from "../rpc/org-scope";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	hasTedisWriteAuthorization,
} from "../rpc/orpc";
import { HOME_MAIN_CONVERSATION_ID } from "../rpc/routers/kernel/conversation-index";
import { cleanupExactKernelToolResults } from "./kernel-tool-result-retention";
import { requireWorkspaceCollaboratorAccess } from "./os-workspace-collaborators";
import {
	assertOsWorkspaceChildVisible,
	assertOsWorkspaceVisible,
} from "./os-workspace-visibility";
import { deleteOsOutput, getOsOutput } from "./workspace-output-storage";

/**
 * Estimated database and storage calls one purge call may make. D1 allows
 * 1,000 queries per Worker invocation on the paid plan; this leaves room for
 * authentication, auditing and the closing counts.
 */
export const OS_ARCHIVED_PURGE_WORK_BUDGET = 600;
// The MCP gateway gives up on an RPC call after 15 s; stop well before that.
export const OS_ARCHIVED_PURGE_TIME_BUDGET_MS = 9_000;
const PAGE_SIZE = KERNEL_CONVERSATION_PURGE_CHUNK;
const SAMPLE_LIMIT = 20;
const OUTPUT_CONCURRENCY = 8;
const SOURCE = "osWorkspaces.workspaces.purgeArchived";

const ACCESS_RANK = { read: 1, edit: 2, owner: 3 } as const;

type StopReason = OsArchivedPurgeResult["stoppedBy"];

class PurgeBudget {
	stoppedBy: StopReason = "finished";
	constructor(
		private units: number,
		private readonly deadline: number,
		private readonly now: () => number,
	) {}

	take(cost: number): boolean {
		if (this.stoppedBy !== "finished") return false;
		if (this.now() >= this.deadline) {
			this.stoppedBy = "time_budget";
			return false;
		}
		if (this.units < cost) {
			this.stoppedBy = "work_budget";
			return false;
		}
		this.units -= cost;
		return true;
	}
}

class KindTally {
	examined = 0;
	eligible = 0;
	deleted = 0;
	skipped = 0;
	skippedByReason: Partial<Record<OsArchivedPurgeSkipReason, number>> = {};
	sampleIds: string[] = [];
	sampleSkipped: { id: string; reason: OsArchivedPurgeSkipReason }[] = [];
	/** Last id examined; the next page and `remaining` start after it. */
	cursor: string | undefined;
	finished = false;

	skip(id: string, reason: OsArchivedPurgeSkipReason) {
		this.examined++;
		this.cursor = id;
		this.skipped++;
		this.skippedByReason[reason] = (this.skippedByReason[reason] ?? 0) + 1;
		if (this.sampleSkipped.length < SAMPLE_LIMIT)
			this.sampleSkipped.push({ id, reason });
	}

	pass(id: string) {
		this.examined++;
		this.cursor = id;
		this.eligible++;
		if (this.sampleIds.length < SAMPLE_LIMIT) this.sampleIds.push(id);
	}

	/** An eligible item whose delete did not go through. */
	unpass(id: string, reason: OsArchivedPurgeSkipReason) {
		this.eligible--;
		this.sampleIds = this.sampleIds.filter((sample) => sample !== id);
		this.examined--;
		this.skip(id, reason);
	}

	result(remaining: number): OsArchivedPurgeKindResult {
		return {
			examined: this.examined,
			eligible: this.eligible,
			deleted: this.deleted,
			skipped: this.skipped,
			skippedByReason: this.skippedByReason,
			sampleIds: this.sampleIds,
			sampleSkipped: this.sampleSkipped,
			remaining,
		};
	}
}

interface PurgeRun {
	context: BaseContext;
	organizationId: string;
	purgeId: string;
	dryRun: boolean;
	archivedBefore: string | undefined;
	budget: PurgeBudget;
	workspacePreferenceNamespace: string;
}

function db(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

function deletionAudit(
	run: PurgeRun,
	action: string,
	resourceType: string,
	resourceIds: string[],
): InsertAuditEventParams[] {
	const actor = auditActor(run.context);
	return resourceIds.map((resourceId) => ({
		organizationId: run.organizationId,
		actorId: actor.actorId,
		actorType: actor.actorType,
		action,
		resourceType,
		resourceId,
		metadata: toJsonRecord({
			...actor.actorMetadata,
			source: SOURCE,
			purgeId: run.purgeId,
			hardDeleted: true,
		}),
		ipAddress: run.context.headers.get("CF-Connecting-IP"),
		userAgent: run.context.headers.get("User-Agent"),
	}));
}

async function recordDeletions(
	run: PurgeRun,
	action: string,
	resourceType: string,
	resourceIds: string[],
) {
	if (resourceIds.length === 0) return;
	try {
		await insertAuditEventsBatch(
			run.context.db,
			deletionAudit(run, action, resourceType, resourceIds),
		);
	} catch (error) {
		// The deletes already committed; a lost receipt must not report failure.
		console.error(`[OsArchivedPurge] Lost ${action} audit rows`, {
			purgeId: run.purgeId,
			count: resourceIds.length,
			exception: safeExceptionTopology(error),
		});
	}
}

async function canSee(check: () => Promise<void>): Promise<boolean> {
	try {
		await check();
		return true;
	} catch {
		return false;
	}
}

/** Same rules as `osWorkspaces.workspaces.delete`. */
async function purgeWorkspaces(run: PurgeRun, tally: KindTally) {
	const { context, organizationId } = run;
	while (run.budget.take(3)) {
		const page = await listArchivedOsWorkspacePurgeCandidates(db(context), {
			organizationId,
			afterId: tally.cursor,
			archivedBefore: run.archivedBefore,
			limit: PAGE_SIZE,
		});
		if (page.length === 0) {
			tally.finished = true;
			return;
		}
		const ids = page.map((workspace) => workspace.id);
		const [withProposals, withShares] = await Promise.all([
			listOsIdsWithCollaborationProposals(db(context), {
				organizationId,
				by: "workspace",
				ids,
			}),
			listOsShareResourceIdsWithActiveLinks(db(context), {
				organizationId,
				resourceType: "workspace",
				resourceIds: ids,
			}),
		]);
		const deleted: string[] = [];
		let stopped = false;
		for (const workspace of page) {
			const isPrivate = workspace.visibility === "private";
			if (!run.budget.take((isPrivate ? 2 : 0) + (run.dryRun ? 1 : 3))) {
				stopped = true;
				break;
			}
			const scope = { organizationId, workspaceId: workspace.id };
			if (
				isPrivate &&
				!(await canSee(() =>
					assertOsWorkspaceVisible(
						context,
						workspace,
						"OS workspace not found",
						{ ownerOnly: true },
					),
				))
			) {
				tally.skip(workspace.id, "not_visible");
			} else if (withProposals.has(workspace.id)) {
				tally.skip(workspace.id, "collaboration_history");
			} else if (withShares.has(workspace.id)) {
				tally.skip(workspace.id, "active_share_links");
			} else if (
				await hasProviderInstallationForWorkspace(db(context), scope)
			) {
				tally.skip(workspace.id, "partner_installation");
			} else {
				tally.pass(workspace.id);
				if (run.dryRun) continue;
				try {
					if (
						await deleteOsWorkspace(db(context), {
							...scope,
							preferenceNamespace: run.workspacePreferenceNamespace,
						})
					) {
						tally.deleted++;
						deleted.push(workspace.id);
					} else tally.unpass(workspace.id, "failed");
				} catch (error) {
					// An installation may have been attached after the check.
					const reason = (await hasProviderInstallationForWorkspace(
						db(context),
						scope,
					).catch(() => false))
						? "partner_installation"
						: "failed";
					console.warn("[OsArchivedPurge] workspace delete failed", {
						purgeId: run.purgeId,
						workspaceId: workspace.id,
						exception: safeExceptionTopology(error),
					});
					tally.unpass(workspace.id, reason);
				}
			}
		}
		await recordDeletions(run, "os.workspace.deleted", "os_workspace", deleted);
		if (stopped) return;
		if (page.length < PAGE_SIZE) {
			tally.finished = true;
			return;
		}
	}
}

/** Same rules as `osWorkspaces.outputs.delete`. */
async function purgeOutputs(run: PurgeRun, tally: KindTally) {
	const { context, organizationId } = run;
	const visibleWorkspaces = new Map<string, Promise<boolean>>();
	while (run.budget.take(3)) {
		const ids = await listArchivedOsOutputPurgeCandidateIds(db(context), {
			organizationId,
			afterId: tally.cursor,
			archivedBefore: run.archivedBefore,
			limit: PAGE_SIZE,
		});
		if (ids.length === 0) {
			tally.finished = true;
			return;
		}
		const [withProposals, withShares] = await Promise.all([
			listOsIdsWithCollaborationProposals(db(context), {
				organizationId,
				by: "output",
				ids,
			}),
			listOsShareResourceIdsWithActiveLinks(db(context), {
				organizationId,
				resourceType: "output",
				resourceIds: ids,
			}),
		]);
		const deleted: string[] = [];
		let stopped = false;
		const visibleIn = (workspaceId: string) => {
			let visible = visibleWorkspaces.get(workspaceId);
			if (!visible) {
				visible = canSee(() =>
					assertOsWorkspaceChildVisible(
						context,
						organizationId,
						workspaceId,
						"OS output not found",
					),
				);
				visibleWorkspaces.set(workspaceId, visible);
			}
			return visible;
		};
		const handle = async (outputId: string) => {
			const output = await getOsOutput(db(context), {
				organizationId,
				outputId,
			});
			if (!output || output.status !== "archived") {
				tally.skip(outputId, "not_archived");
				return;
			}
			const visible = output.workspaceId
				? await visibleIn(output.workspaceId)
				: true;
			if (!visible) tally.skip(outputId, "not_visible");
			else if (withShares.has(outputId))
				tally.skip(outputId, "active_share_links");
			else if (withProposals.has(outputId))
				tally.skip(outputId, "collaboration_history");
			else {
				tally.pass(outputId);
				if (run.dryRun) return;
				try {
					if (await deleteOsOutput(db(context), { organizationId, outputId })) {
						tally.deleted++;
						deleted.push(outputId);
					} else tally.unpass(outputId, "failed");
				} catch (error) {
					console.warn("[OsArchivedPurge] output delete failed", {
						purgeId: run.purgeId,
						outputId,
						exception: safeExceptionTopology(error),
					});
					tally.unpass(outputId, "failed");
				}
			}
		};
		// Each output is confirmed against its storage owner, often a workspace
		// object, so a few run at once instead of one round trip at a time.
		for (let i = 0; i < ids.length && !stopped; i += OUTPUT_CONCURRENCY) {
			const chunk: string[] = [];
			for (const outputId of ids.slice(i, i + OUTPUT_CONCURRENCY)) {
				if (!run.budget.take(run.dryRun ? 5 : 9)) {
					stopped = true;
					break;
				}
				chunk.push(outputId);
			}
			await Promise.all(chunk.map(handle));
			// Items finish out of order; the next page starts after the whole chunk.
			if (chunk.length > 0) tally.cursor = chunk[chunk.length - 1];
		}
		await recordDeletions(run, "os.output.deleted", "os_output", deleted);
		if (stopped) return;
		if (ids.length < PAGE_SIZE) {
			tally.finished = true;
			return;
		}
	}
}

/** Same rules as `kernelRuntime.deleteConversation`, minus cancelling runs. */
async function purgeConversations(run: PurgeRun, tally: KindTally) {
	const { context, organizationId } = run;
	const callerId = context.descopeUserId ?? context.user?.sub ?? null;
	const workspaceChat = new Map<string, boolean>();
	while (run.budget.take(4)) {
		const page = await listArchivedKernelConversationPurgeCandidates(
			context.db,
			{
				organizationId,
				afterConversationId: tally.cursor,
				archivedBefore: run.archivedBefore,
				limit: PAGE_SIZE,
			},
		);
		if (page.length === 0) {
			tally.finished = true;
			return;
		}
		const ids = page.map((row) => row.conversationId);
		const [grants, activeRuns] = await Promise.all([
			listKernelConversationGrantsByConversation(context.db, {
				organizationId,
				conversationIds: ids,
			}),
			listKernelConversationIdsWithActiveRuns(context.db, {
				organizationId,
				conversationIds: ids,
			}),
		]);
		const eligible: string[] = [];
		let stopped = false;
		for (const row of page) {
			const id = row.conversationId;
			const checksWorkspace =
				context.authType === "user" &&
				row.workspaceId !== null &&
				!workspaceChat.has(row.workspaceId);
			if (!run.budget.take(checksWorkspace ? 3 : 0)) {
				stopped = true;
				break;
			}
			const rows = grants.get(id) ?? [];
			const best = rows
				.filter((grant) => grant.granteeDescopeUserId === callerId?.trim())
				.reduce((top, grant) => Math.max(top, ACCESS_RANK[grant.access]), 0);
			if (id === HOME_MAIN_CONVERSATION_ID) tally.skip(id, "main_thread");
			else if (row.pinnedAt !== null) tally.skip(id, "pinned");
			else if (activeRuns.has(id)) tally.skip(id, "active_run");
			else if (rows.length > 0 && best < ACCESS_RANK.edit)
				tally.skip(id, "no_access");
			else if (context.authType === "user" && row.workspaceId !== null) {
				const workspaceId = row.workspaceId;
				let allowed = workspaceChat.get(workspaceId);
				if (allowed === undefined) {
					allowed = await canSee(async () => {
						await requireWorkspaceCollaboratorAccess(
							context,
							workspaceId,
							"app.chat",
						);
					});
					workspaceChat.set(workspaceId, allowed);
				}
				if (allowed) {
					tally.pass(id);
					eligible.push(id);
				} else tally.skip(id, "no_access");
			} else {
				tally.pass(id);
				eligible.push(id);
			}
		}
		if (!run.dryRun && eligible.length > 0) {
			if (!run.budget.take(1)) {
				for (const id of eligible) tally.unpass(id, "failed");
				return;
			}
			try {
				const purged = await purgeKernelConversations(context.db, {
					organizationId,
					conversationIds: eligible,
					deletedAt: new Date().toISOString(),
					clearSessionPolicies: true,
					auditEvents: deletionAudit(
						run,
						"kernel.conversation.deleted",
						"kernel_conversation",
						eligible,
					),
				});
				tally.deleted += eligible.length;
				await cleanupToolResults(run, purged.evictedToolResults);
			} catch (error) {
				console.warn("[OsArchivedPurge] conversation purge failed", {
					purgeId: run.purgeId,
					count: eligible.length,
					exception: safeExceptionTopology(error),
				});
				for (const id of eligible) tally.unpass(id, "failed");
			}
		}
		if (stopped) return;
		if (page.length < PAGE_SIZE) {
			tally.finished = true;
			return;
		}
	}
}

/**
 * Removes stored tool results the purge evicted, as far as the budget allows.
 * Anything left stays evicted and the daily retention sweep removes it.
 */
async function cleanupToolResults(
	run: PurgeRun,
	rows: Awaited<
		ReturnType<typeof purgeKernelConversations>
	>["evictedToolResults"],
) {
	const bucket = run.context.env.TEDI_R2_BUCKET;
	if (!bucket || rows.length === 0) return;
	let affordable = 0;
	while (affordable < rows.length && run.budget.take(2)) affordable++;
	if (affordable === 0) return;
	await cleanupExactKernelToolResults({
		db: db(run.context),
		bucket,
		rows: rows.slice(0, affordable),
	}).catch((error) => {
		console.warn("[OsArchivedPurge] tool result cleanup failed", {
			purgeId: run.purgeId,
			exception: safeExceptionTopology(error),
		});
	});
}

const PURGE_ORDER: OsArchivedPurgeKind[] = [
	"conversations",
	"outputs",
	"workspaces",
];

export async function purgeArchivedOsItems(
	context: BaseContext,
	input: OsArchivedPurgeInput,
	options: {
		workspacePreferenceNamespace: string;
		workBudget?: number;
		timeBudgetMs?: number;
		now?: () => number;
	},
): Promise<OsArchivedPurgeResult> {
	const organizationId = requireOrgId(context);
	const kinds = new Set(input.kinds);
	if (kinds.has("conversations") && !hasTedisWriteAuthorization(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Deleting Home conversations also needs the right to manage tedis (tedis:update)",
		);
	}
	const now = options.now ?? Date.now;
	const run: PurgeRun = {
		context,
		organizationId,
		purgeId: crypto.randomUUID(),
		dryRun: input.dryRun,
		archivedBefore: input.archivedBefore,
		budget: new PurgeBudget(
			options.workBudget ?? OS_ARCHIVED_PURGE_WORK_BUDGET,
			now() + (options.timeBudgetMs ?? OS_ARCHIVED_PURGE_TIME_BUDGET_MS),
			now,
		),
		workspacePreferenceNamespace: options.workspacePreferenceNamespace,
	};
	const result: OsArchivedPurgeResult = {
		purgeId: run.purgeId,
		dryRun: input.dryRun,
		complete: true,
		stoppedBy: "finished",
	};
	for (const kind of PURGE_ORDER) {
		if (!kinds.has(kind)) continue;
		const tally = new KindTally();
		if (kind === "conversations") await purgeConversations(run, tally);
		else if (kind === "outputs") await purgeOutputs(run, tally);
		else await purgeWorkspaces(run, tally);
		const page = {
			organizationId,
			afterId: tally.cursor,
			archivedBefore: run.archivedBefore,
		};
		const remaining = tally.finished
			? 0
			: kind === "conversations"
				? await countArchivedKernelConversationPurgeCandidates(context.db, {
						organizationId,
						afterConversationId: tally.cursor,
						archivedBefore: run.archivedBefore,
					})
				: kind === "outputs"
					? await countArchivedOsOutputPurgeCandidates(db(context), page)
					: await countArchivedOsWorkspacePurgeCandidates(db(context), page);
		result[kind] = tally.result(remaining);
		if (remaining > 0) result.complete = false;
	}
	result.stoppedBy = result.complete ? "finished" : run.budget.stoppedBy;
	return result;
}
