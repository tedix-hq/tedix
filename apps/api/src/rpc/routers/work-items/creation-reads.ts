import {
	ListWorkCliProjectionResultSchema,
	WorkCliBoardRowSchema,
	WorkCliResolveRowSchema,
	WorkCheckpointProjectionSchema,
} from "@tedix/api-contract/schemas/work-items";
import { withAuthorization } from "../../orpc";
import { getOrgGraphHealth } from "@tedix/db/queries/org-graph-health";
import {
	getWorkGraphHealth,
	runWorkGraphSteward,
} from "@tedix/db/queries/work-graph-steward";
import {
	attachWorkItemSource,
	getSourceFreshness,
	listWorkItemSources,
	markMissingSources,
	tombstoneMissingSources,
} from "@tedix/db/queries/work-item-sources";
import { listWorkActivity } from "@tedix/db/queries/work-items/activity";
import { listLiveWorkAttemptHolders } from "@tedix/db/queries/work-items/attempts";
import { listWorkItemComments } from "@tedix/db/queries/work-items/comments";
import {
	createWorkItem,
	listOrgWorkItemProjections,
	listWorkItemProjections,
	listWorkItemsPage,
} from "@tedix/db/queries/work-items/crud";
import { listWorkItemEvidence } from "@tedix/db/queries/work-items/evidence";
import {
	assertValidWorkItemProject,
	resolveWorkItemPurpose,
	WorkItemProjectError,
	WorkItemPurposeError,
} from "@tedix/db/queries/work-items/purpose";
import { listWorkItemRelations } from "@tedix/db/queries/work-items/relations";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	prepareFactoryCycle,
	replayFactoryCycle,
} from "../../../services/factory-cycle";
import { resolveWorkEvidenceRow } from "../../../services/work-evidence-resolution";
import { requireOrgId } from "../../org-scope";
import { ErrorCodes, createError } from "../../orpc";
import {
	assertWorkItemAccess,
	authOs,
	ownerHeldRiskLevel,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

function rethrowWorkItemContextError(error: unknown): never {
	if (error instanceof WorkItemProjectError) {
		throw createError(
			error.code === "not_found" ? ErrorCodes.NOT_FOUND : ErrorCodes.FORBIDDEN,
			error.message,
		);
	}
	if (error instanceof WorkItemPurposeError) {
		throw createError(
			error.code === "objective_not_found"
				? ErrorCodes.NOT_FOUND
				: error.code === "objective_wrong_org"
					? ErrorCodes.FORBIDDEN
					: ErrorCodes.BAD_REQUEST,
			error.message,
		);
	}
	throw error;
}

export const createProcedure = authOs.create.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		input = await prepareFactoryCycle(context.db, orgId, input);
		let attemptedCreate = false;
		try {
			const project = input.projectId
				? await assertValidWorkItemProject(context.db, {
						orgId,
						projectId: input.projectId,
					})
				: null;
			const parent = input.parentWorkItemId
				? await assertWorkItemAccess(context, input.parentWorkItemId)
				: null;
			const purpose = await resolveWorkItemPurpose(context.db, {
				orgId,
				now: new Date().toISOString(),
				objectiveId: input.objectiveId,
				workClass: input.workClass,
				purposeExceptionExpiresAt: input.purposeExceptionExpiresAt,
				parent,
				project,
			});
			const existing = await replayFactoryCycle(context.db, orgId, input);
			if (existing) return existing;
			attemptedCreate = true;
			return await createWorkItem(context.db, {
				id: crypto.randomUUID(),
				orgId,
				title: input.title,
				description: input.description,
				workKind: input.workKind,
				riskLevel: ownerHeldRiskLevel(context.authType, input.riskLevel),
				requiredCapabilities: input.requiredCapabilities,
				requiredAuthorities: input.requiredAuthorities,
				priority: input.priority,
				accountableOwnerType: input.accountableOwnerType,
				accountableOwnerId: input.accountableOwnerId,
				stewardType: input.stewardType,
				stewardId: input.stewardId,
				objectiveId: purpose.objectiveId ?? undefined,
				workClass: purpose.workClass,
				purposeExceptionExpiresAt:
					purpose.purposeExceptionExpiresAt ?? undefined,
				projectId: input.projectId,
				parentWorkItemId: input.parentWorkItemId,
				sourceSessionKey: input.sourceSessionKey,
				sourceIntentId: input.sourceIntentId,
				dueDate: input.dueDate,
				deadline: input.deadline,
				startAt: input.startAt,
				durationDays: input.durationDays,
				provenance:
					input.provenance === undefined
						? undefined
						: toJsonRecord(input.provenance),
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			// The organization/source-intent unique index arbitrates concurrent intake.
			if (attemptedCreate) {
				const winner = await replayFactoryCycle(context.db, orgId, input);
				if (winner) return winner;
			}
			try {
				rethrowWorkItemWriteError(error);
			} catch (mapped) {
				rethrowWorkItemContextError(mapped);
			}
		}
	},
);

export const listProcedure = authOs.list.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const limit = input?.limit ?? 50;
	const offset = input?.offset ?? 0;
	// Every filter is applied in SQL and `total` is an exact COUNT(*) over the
	// filtered set. This used to prefetch 1,000 rows and filter/page them in
	// memory, which made `total` the window size and hid every row older than
	// the newest 1,000 of its disposition from `idPrefix`.
	const { data, total } = await listWorkItemsPage(context.db, {
		orgId,
		disposition: input?.disposition,
		workKind: input?.workKind,
		projectId: input?.projectId,
		objectiveId: input?.objectiveId,
		workClass: input?.workClass,
		idPrefix: input?.idPrefix,
		titleContains: input?.titleContains,
		customerVisiblePreFilter: input?.customerVisibleOnly,
		limit,
		offset,
	});
	// Who holds each row, in one extra org-scoped read rather than a join —
	// see listLiveWorkAttemptHolders for why a join here is a D1 hazard. A row
	// with no live Attempt gets an explicit null so "nobody holds this" is
	// distinguishable from "this server does not report holders".
	const holders = await listLiveWorkAttemptHolders(context.db, { orgId });
	return {
		data: data.map((item) => ({
			...item,
			activeAttempt: holders.get(String(item.id)) ?? null,
		})),
		pagination: {
			limit,
			offset,
			total,
			hasMore: offset + data.length < total,
		},
	};
});

export const getByIdProcedure = authOs.getById.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const [comments, evidencePage, projections] = await Promise.all([
			listWorkItemComments(context.db, input.id),
			listWorkItemEvidence(context.db, {
				orgId: workItem.orgId,
				workItemId: input.id,
				limit: 100,
			}),
			listWorkItemProjections(context.db, input.id),
		]);
		return {
			workItem,
			comments,
			evidence: await Promise.all(
				evidencePage.data.map((row) => resolveWorkEvidenceRow(context, row)),
			),
			evidenceNextCursor: evidencePage.nextCursor
				? {
						at: evidencePage.nextCursor.submittedAt,
						id: evidencePage.nextCursor.id,
					}
				: null,
			projections,
		};
	},
);

export const getWorkGraphHealthProcedure = authOs.getWorkGraphHealth.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const report = await getWorkGraphHealth(context.db, {
			orgId,
			projectId: input.projectId,
			idleThresholdDays: input.idleThresholdDays,
			dupThreshold: input.dupThreshold,
			scanCap: input.scanCap,
			now: new Date().toISOString(),
		});
		return report;
	},
);

export const runWorkGraphStewardProcedure = authOs.runWorkGraphSteward.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const outcome = await runWorkGraphSteward(context.db, {
			orgId,
			now: new Date().toISOString(),
			apply: input.apply,
			projectId: input.projectId,
			idleThresholdDays: input.idleThresholdDays,
			dupThreshold: input.dupThreshold,
			scanCap: input.scanCap,
			actions: input.actions,
			limit: input.limit,
		});
		return outcome;
	},
);

export const getOrgGraphHealthProcedure = authOs.getOrgGraphHealth.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const report = await getOrgGraphHealth(context.db, {
			orgId,
			projectId: input.projectId,
			limit: input.limit,
			now: new Date().toISOString(),
		});
		return report;
	},
);

export const listRelationsProcedure = authOs.listRelations.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const limit = input.limit ?? 200;
		const relations = await listWorkItemRelations(context.db, {
			orgId,
			projectId: input.projectId,
			limit,
		});
		return { relations, truncated: relations.length === limit };
	},
);

/**
 * Who attached this source. Kept coarse on purpose — it answers "which surface
 * put this in the graph" for provenance, not "which principal", which the audit
 * log already owns.
 */
function describeSourceAttribution(context: {
	authType?: string;
	tediId?: string | null;
}): string {
	const tediId = context.tediId?.trim();
	if (tediId) return `tedi:${tediId}`;
	return context.authType ? `auth:${context.authType}` : "system";
}

export const attachWorkItemSourceProcedure =
	authOs.attachWorkItemSource.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const source = await attachWorkItemSource(context.db, {
			id: crypto.randomUUID(),
			orgId,
			projectId: input.projectId ?? null,
			workItemId: input.workItemId ?? null,
			provider: input.provider,
			externalId: input.externalId,
			kind: input.kind,
			externalUrl: input.externalUrl ?? null,
			title: input.title ?? null,
			contentHash: input.contentHash ?? null,
			attributedTo: describeSourceAttribution(context),
			metadata: input.metadata,
			now: new Date().toISOString(),
		});
		return { source };
	});

export const listWorkItemSourcesProcedure = authOs.listWorkItemSources.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const limit = input.limit ?? 100;
		const offset = input.offset ?? 0;
		const [{ data, total }, freshness] = await Promise.all([
			listWorkItemSources(context.db, {
				orgId,
				projectId: input.projectId,
				workItemId: input.workItemId,
				provider: input.provider,
				includeTombstoned: input.includeTombstoned,
				limit,
				offset,
			}),
			getSourceFreshness(context.db, {
				orgId,
				projectId: input.projectId,
			}),
		]);
		return {
			data,
			pagination: { limit, offset, total, hasMore: offset + limit < total },
			freshness,
		};
	},
);

export const reconcileWorkItemSourcesProcedure =
	authOs.reconcileWorkItemSources.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const now = new Date().toISOString();

		// A dry run answers "what would this sweep retire" without touching state —
		// the safe way to check a connector's output before letting it mark an
		// engagement's context missing.
		if (input.dryRun) {
			const freshness = await getSourceFreshness(context.db, {
				orgId,
				projectId: input.projectId,
			});
			return { markedMissing: 0, tombstoned: [], dryRun: true, freshness };
		}

		const { marked } = await markMissingSources(context.db, {
			orgId,
			provider: input.provider,
			projectId: input.projectId,
			seenExternalIds: input.seenExternalIds,
			now,
		});
		const { tombstoned } = await tombstoneMissingSources(context.db, {
			orgId,
			provider: input.provider,
			graceHours: input.graceHours,
			now,
		});
		const freshness = await getSourceFreshness(context.db, {
			orgId,
			projectId: input.projectId,
		});
		return {
			markedMissing: marked,
			tombstoned,
			dryRun: false,
			freshness,
		};
	});

export const listProjectionsProcedure = authOs.listProjections.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const limit = input.limit ?? 100;
		const offset = input.offset ?? 0;
		// The page is a real SQL LIMIT/OFFSET over the same predicate `total`
		// counts. This used to fetch `offset + limit` rows and slice, so the cost
		// of a page grew linearly with its offset and every row before the page
		// was serialized out of D1 only to be discarded.
		const { data: rows, total } = await listOrgWorkItemProjections(context.db, {
			orgId,
			projectId: input.projectId,
			provider: input.provider,
			limit,
			offset,
		});
		const data = rows.map(({ workItemStatus, ...row }) => ({
			...row,
			workItemDisposition: workItemStatus,
		}));
		return {
			data,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + data.length < total,
			},
		};
	},
);

export const listActivityProcedure = authOs.listActivity.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const result = await listWorkActivity(context.db, {
			orgId,
			workItemId: input.workItemId,
			projectId: input.projectId,
			eventTypes: input.eventTypes,
			limit: input.limit,
		});
		return {
			...result,
			events: result.events.map(({ workItemStatus, ...event }) => ({
				...event,
				workItemDisposition: workItemStatus,
			})),
		};
	},
);

const cliReadOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Each read is scoped to the verified organization; record reads additionally assert Work Item access",
		},
		"mcp:work.read",
	),
);
export const listCliProjectionProcedure = cliReadOs.listCliProjection.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const page = await listWorkItemsPage(context.db, {
			orgId,
			disposition: input.disposition,
			workKind: input.workKind,
			projectId: input.projectId,
			objectiveId: input.objectiveId,
			workClass: input.workClass,
			idPrefix: input.idPrefix,
			titleContains: input.titleContains,
			customerVisiblePreFilter: input.customerVisibleOnly,
			limit: input.limit,
			offset: input.offset,
		});
		const pagination = {
			limit: input.limit,
			offset: input.offset,
			total: page.total,
			hasMore: input.offset + page.data.length < page.total,
		};
		if (input.view === "resolve")
			return ListWorkCliProjectionResultSchema.parse({
				view: input.view,
				data: page.data.map((row) =>
					WorkCliResolveRowSchema.strip().parse(row),
				),
				pagination,
			});
		const holders = await listLiveWorkAttemptHolders(context.db, { orgId });
		return ListWorkCliProjectionResultSchema.parse({
			view: input.view,
			data: page.data.map((row) => {
				const holder = holders.get(row.id);
				return WorkCliBoardRowSchema.strip().parse({
					...row,
					activeAttempt: holder
						? {
								agentSession: holder.agentSession,
								executorId: holder.executorId,
							}
						: null,
				});
			}),
			pagination,
		});
	},
);
export const getCheckpointProjectionProcedure =
	cliReadOs.getCheckpointProjection.handler(async ({ input, context }) =>
		WorkCheckpointProjectionSchema.strip().parse(
			await assertWorkItemAccess(context, input.id),
		),
	);
