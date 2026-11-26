import { createChildWorkItem } from "@tedix/db/queries/work-items/child-delegation";
import { verifiedActiveWorkActor } from "../work-items-principal";
import {
	assertNativeStewardCloseout,
	normalizeNativeStewardCloseoutInput,
} from "./delegated-closeout";
import {
	ListWorkCliProjectionResultSchema,
	type LaneDispatchPlan,
	WorkCliBoardRowSchema,
	WorkCliResolveRowSchema,
	WorkCheckpointProjectionSchema,
	WorkCaseSchema,
	WorkExecutorSchema,
	isLaneReadyExecutorReference,
	workExecutorReference,
} from "@tedix/api-contract/schemas/work-items";
import { withAuthorization } from "../../orpc";
import {
	defaultAccountableOwner,
	externalAgentWorkCreator,
	workItemCreationActor,
} from "./creation-actor";
import { getOrgGraphHealth } from "@tedix/db/queries/org-graph-health";
import {
	getProjectById,
	getProjectByIdForOrganization,
} from "@tedix/db/queries/projects";
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
import { listWorkCasesForWorkItem } from "@tedix/db/queries/work-items/cases";
import {
	listLiveWorkAttemptHolders,
	listLatestWorkAttemptSummaries,
} from "@tedix/db/queries/work-items/attempts";
import { listWorkItemComments } from "@tedix/db/queries/work-items/comments";
import {
	createWorkItem,
	getWorkItemsByIds,
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
import { canShowWorkItemCompletion } from "./operator-policy";
import {
	assertOwnerSetLaneExecution,
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
		if (
			[input.sourceSessionKey, input.sourceIntentId].some((key) =>
				key?.startsWith("workspace:"),
			)
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Workspace chat sets its own conversation keys",
			);
		const callerInput = input;
		input = await prepareFactoryCycle(context.db, orgId, input);
		if (input.factoryCard) {
			const { prepareFactoryCard } =
				await import("../../../services/factory-card-envelope");
			input = await prepareFactoryCard(context, orgId, input);
		}
		await assertOwnerSetLaneExecution(
			context,
			orgId,
			callerInput.metadata,
			callerInput,
		);
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
			const legacyExecutor = WorkExecutorSchema.safeParse(
				input.executor ?? input.metadata?.executor,
			);
			const legacyReference = legacyExecutor.success
				? workExecutorReference(legacyExecutor.data)
				: undefined;
			if (
				input.executorReference &&
				legacyReference &&
				(input.executorReference.type !== legacyReference.type ||
					input.executorReference.id !== legacyReference.id)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"executor and executorReference must name the same executor",
				);
			const executorReference = input.executorReference ?? legacyReference;
			if (
				parent &&
				(context.externalAgentPrincipalId ||
					context.ownerHostSessionId ||
					context.tediId)
			) {
				const actor = await verifiedActiveWorkActor(context, orgId);
				const child = await createChildWorkItem(context.db, {
					input: { ...input, executorReference },
					parent,
					actor,
					externalSessionKey:
						actor.type === "external_agent"
							? actor.externalSessionKey
							: undefined,
					now: new Date().toISOString(),
				});
				if (child) return child;
			}
			if (input.blockedByWorkItemIds?.length)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Creation-time predecessors require a child of your running Attempt",
				);
			const executor = executorReference?.id;
			const laneExecution = input.metadata?.laneExecution as
				| { delegationDepth?: number; maxAttempts?: number }
				| undefined;
			const factoryCycle = input.metadata?.factoryCycle as
				| { maxAttempts?: number }
				| undefined;
			const metadata = { ...input.metadata };
			delete metadata.executor;
			delete metadata.laneDispatch;
			if (laneExecution) {
				const {
					delegationDepth: _depth,
					maxAttempts: _attempts,
					...policy
				} = laneExecution;
				metadata.laneExecution = policy;
			}
			if (factoryCycle) {
				const { maxAttempts: _attempts, ...cycle } = factoryCycle;
				metadata.factoryCycle = cycle;
			}
			const laneProject =
				executorReference?.type === "external_agent" &&
				["codex", "claude-code"].includes(String(executor)) &&
				input.projectId
					? await getProjectByIdForOrganization(
							context.db,
							orgId,
							input.projectId,
						)
					: undefined;
			const laneSteward =
				!input.stewardType && !input.stewardId
					? laneProject?.leadTediId
					: undefined;
			const laneDispatch: LaneDispatchPlan | undefined =
				isLaneReadyExecutorReference(executorReference)
					? { state: "ready" as const }
					: undefined;
			if (
				Boolean(input.accountableOwnerType) !==
				Boolean(input.accountableOwnerId)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"accountableOwnerType and accountableOwnerId must be provided together",
				);
			const createdBy = await workItemCreationActor(context, orgId);
			const owner =
				input.accountableOwnerType || input.accountableOwnerId
					? undefined
					: await defaultAccountableOwner(context, orgId, createdBy);
			const accountableOwnerType = input.accountableOwnerType ?? owner?.type;
			const accountableOwnerId = input.accountableOwnerId || owner?.id;
			if (
				(!accountableOwnerType || !accountableOwnerId) &&
				(await externalAgentWorkCreator(context, orgId, createdBy))
			)
				// Acceptance refuses Work without an accountable owner and only
				// a person can assign one afterwards, so ownerless routine Work
				// an agent files fails here with the one thing it can supply.
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Creating Work as an external agent requires an accountable owner. Pass accountableOwnerType and accountableOwnerId naming the person or tedi that answers for it.",
				);
			return await createWorkItem(context.db, {
				id: crypto.randomUUID(),
				orgId,
				createdBy,
				title: input.title,
				description: input.description,
				workKind: input.workKind,
				riskLevel: ownerHeldRiskLevel(context.authType, input.riskLevel),
				requiredCapabilities: input.requiredCapabilities,
				requiredAuthorities: input.requiredAuthorities,
				priority: input.priority,
				accountableOwnerType,
				accountableOwnerId,
				stewardType: input.stewardType ?? (laneSteward ? "tedi" : undefined),
				stewardId: input.stewardId ?? laneSteward ?? undefined,
				objectiveId: purpose.objectiveId ?? undefined,
				workClass: purpose.workClass,
				purposeExceptionExpiresAt:
					purpose.purposeExceptionExpiresAt ?? undefined,
				projectId: input.projectId,
				parentWorkItemId: input.parentWorkItemId,
				executorType: executorReference?.type,
				executorId: executor === undefined ? undefined : String(executor),
				dispatchState: laneDispatch?.state,
				delegationDepth:
					input.delegationDepth ?? laneExecution?.delegationDepth,
				maxAttempts:
					input.maxAttempts ??
					laneExecution?.maxAttempts ??
					factoryCycle?.maxAttempts,
				rootWorkItemId: input.rootWorkItemId,
				rootGoal: input.rootGoal,
				budgetShareMicros: input.budgetShareMicros,
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
				metadata: toJsonRecord({
					...metadata,
					// A person who names the tool keeps the task on it.
					...(executor !== undefined &&
					executor !== "any-local" &&
					createdBy?.type === "user"
						? { onlyExecutor: true }
						: {}),
					...(laneDispatch?.score === undefined &&
					!laneDispatch?.reason &&
					!laneDispatch?.note
						? {}
						: {
								laneDispatch: {
									...(laneDispatch.score === undefined
										? {}
										: { score: laneDispatch.score }),
									...(laneDispatch.reason
										? { reason: laneDispatch.reason }
										: {}),
									...(laneDispatch.note ? { note: laneDispatch.note } : {}),
								},
							}),
				}),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			// The organization/source-intent unique index arbitrates concurrent intake.
			if (attemptedCreate) {
				const winner = await replayFactoryCycle(context.db, orgId, input);
				if (winner) return winner;
			}
			// Any other caller that reuses a key gets a reason instead of a
			// database failure.
			for (let cause = error; cause instanceof Error; cause = cause.cause)
				if (
					/unique constraint failed: work_items\.org_id, work_items\.source_intent_id/i.test(
						cause.message,
					)
				)
					throw createError(
						ErrorCodes.CONFLICT,
						"A Work Item with this sourceIntentId already exists in this organization",
					);
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
		excludeDisposition: input?.excludeDisposition,
		executor: input?.executor,
		executorType: input?.executorType,
		dispatchReadyOnly: input?.dispatchReadyOnly,
		workKind: input?.workKind,
		projectId: input?.projectId,
		objectiveId: input?.objectiveId,
		workClass: input?.workClass,
		accountableOwnerId: input?.accountableOwnerId,
		objectiveLinked: input?.objectiveLinked,
		idPrefix: input?.idPrefix,
		titleContains: input?.titleContains,
		customerVisiblePreFilter: input?.customerVisibleOnly,
		mattersThrough: input?.mattersThrough,
		needsProject: input?.needsProject,
		limit,
		offset,
	});
	// Who holds each row, in one extra org-scoped read rather than a join —
	// see listLiveWorkAttemptHolders for why a join here is a D1 hazard. A row
	// with no live Attempt gets an explicit null so "nobody holds this" is
	// distinguishable from "this server does not report holders".
	const [holders, latest] = await Promise.all([
		listLiveWorkAttemptHolders(context.db, { orgId }),
		listLatestWorkAttemptSummaries(context.db, {
			orgId,
			workItemIds: data.map((item) => item.id),
		}),
	]);
	return {
		data: data.map((item) => ({
			...item,
			activeAttempt: holders.get(String(item.id)) ?? null,
			latestAttempt: latest.get(item.id) ?? null,
		})),
		pagination: {
			limit,
			offset,
			total,
			hasMore: offset + data.length < total,
		},
	};
});

export const getManyProcedure = authOs.getMany
	.use(withAuthorization("tedis:read", "mcp:work.read"))
	.handler(async ({ input, context }) => {
		const ids = [...new Set(input.ids.map((id) => id.toLowerCase()))];
		const rows = await getWorkItemsByIds(context.db, {
			orgId: requireOrgId(context),
			ids,
		});
		const byId = new Map(rows.map((row) => [row.id, row]));
		return {
			items: ids.flatMap((id) => {
				const row = byId.get(id);
				return row ? [row] : [];
			}),
			missingIds: ids.filter((id) => !byId.has(id)),
		};
	});

export const getByIdProcedure = authOs.getById.handler(
	async ({ input, context }) => {
		const request =
			input.nativeStewardCloseout !== undefined
				? normalizeNativeStewardCloseoutInput({
						nativeStewardCloseout: input.nativeStewardCloseout,
					})
				: { id: input.id, nativeStewardCloseout: undefined };
		if (request.nativeStewardCloseout)
			await assertNativeStewardCloseout(context, {
				id: request.id,
				nativeStewardCloseout: request.nativeStewardCloseout,
			});
		let id = request.id.toLowerCase();
		if (id.length !== 36) {
			const matches = await listWorkItemsPage(context.db, {
				orgId: requireOrgId(context),
				idPrefix: id,
				limit: 10,
			});
			if (matches.total === 0)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"No Work Item matches this prefix in this organization",
				);
			if (matches.total !== 1)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Ambiguous Work prefix (${matches.total} matches). Use a canonical id: ${matches.data.map((item) => item.id).join(", ")}`,
				);
			id = matches.data[0]!.id;
		}
		const workItem = await assertWorkItemAccess(context, id);
		const [comments, evidencePage, project, epics] = await Promise.all([
			listWorkItemComments(context.db, id),
			listWorkItemEvidence(context.db, {
				orgId: workItem.orgId,
				workItemId: id,
				limit: 100,
			}),
			workItem.projectId
				? getProjectById(context.db, workItem.projectId)
				: undefined,
			listWorkCasesForWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: id,
			}),
		]);
		return {
			workItem,
			canComplete: await canShowWorkItemCompletion(
				context,
				workItem,
				project ?? null,
			),
			project:
				project && project.orgId === workItem.orgId
					? {
							id: project.id,
							name: project.name,
							description: project.description,
						}
					: null,
			epics: epics.map(({ metadata: _metadata, ...epic }) =>
				WorkCaseSchema.parse(epic),
			),
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
		return {
			relations: relations.map(
				({ id, fromWorkItemId, toWorkItemId, relationType, createdAt }) => ({
					id,
					fromWorkItemId,
					toWorkItemId,
					relationType,
					createdAt,
				}),
			),
			truncated: relations.length === limit,
		};
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

export const listActivityProcedure = authOs.listActivity.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const result = await listWorkActivity(context.db, {
			orgId,
			viewerUserId: context.authType === "user" ? context.userId : undefined,
			cursor: input.cursor,
			afterSequence: input.afterSequence,
			workItemId: input.workItemId,
			projectId: input.projectId,
			objectiveId: input.objectiveId,
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
			executor: input.executor,
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
