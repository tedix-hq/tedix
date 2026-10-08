import {
	WorkAttemptCliRowSchema,
	WorkEvidenceCliRowSchema,
	WorkEventCliRowSchema,
	ListWorkAttemptCliProjectionResultSchema,
	ListWorkEvidenceCliProjectionResultSchema,
	ListWorkEventCliProjectionResultSchema,
} from "@tedix/api-contract/schemas/work-items";
import {
	heartbeatWorkItemAttempt,
	listWorkItemAttempts,
	recordWorkAttemptRepository,
	settleWorkItemAttempt,
	startWorkItemAttempt,
} from "@tedix/db/queries/work-items/attempts";
import {
	acceptWorkItem,
	cancelWorkItem,
	completeWorkItem,
	updateWorkItemSpecification,
} from "@tedix/db/queries/work-items/crud";
import {
	getWorkItemEvidence,
	listWorkItemEvidence,
	submitWorkItemEvidence,
} from "@tedix/db/queries/work-items/evidence";
import { listWorkItemEvents } from "@tedix/db/queries/work-items/events";
import { deriveWorkItemReadiness } from "@tedix/db/queries/work-items/readiness";
import {
	getWorkAdmissionSpecification,
	replaceWorkAdmissionSpecification,
	WorkAdmissionError,
	WorkAdmissionSpecificationError,
} from "@tedix/db/queries/work-items/admissions";
import { ORPCError } from "@orpc/server";
import {
	createWorkResourcePool,
	getWorkResourcePoolByKey,
	listWorkResourcePools,
	listActiveWorkResourceHolders,
	updateWorkResourcePool,
} from "@tedix/db/queries/work-items/resources";
import {
	createWorkBudgetEnvelope,
	getWorkBudgetEnvelopeByScope,
	listWorkBudgetEnvelopes,
	updateWorkBudgetEnvelope,
} from "@tedix/db/queries/work-items/budgets";
import {
	WorkBudgetEnvelopeProjectionSchema,
	WorkBudgetEnvelopeSchema,
	WorkResourcePoolProjectionSchema,
	WorkResourcePoolSchema,
} from "@tedix/api-contract/schemas/work-items";
import { toJsonRecord } from "@tedix/db/utils/json";
import { createError, ErrorCodes, withAuthorization } from "../../orpc";
import {
	assertTediAccess,
	corroborationPrincipal,
	stampExternalAgentMetadata,
	verifiedExternalAgent,
} from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	requireOwnerAdminWorkItemAuthor,
	workItemAcceptanceActor,
	rethrowWorkItemWriteError,
} from "./policy-helpers";
import { admitWorkAttempt } from "./attempt-admission";
import { requireFactoryAcceptance } from "../../../services/factory-cycle";
import {
	findAssignedActiveAttempt,
	isAssignedTediExecutor,
} from "./delegated-assignment";
import {
	normalizeSubmittedEvidence,
	previewWorkEvidence,
	resolveWorkEvidenceRow,
} from "../../../services/work-evidence-resolution";
import { provisionWorkAttemptRepository } from "../../../services/work-artifacts-repository";

type WorkActor = {
	type: "user" | "tedi" | "external_agent" | "team" | "system";
	id: string;
	sessionId?: string;
};

const factoryOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Each handler enforces organization scope plus its operation-specific member, owner, or executor policy",
		},
		"mcp:messaging.write",
	),
);

/**
 * Every admission-plane rejection is a typed client error. `WorkAdmissionError`
 * is the evaluated verdict and carries its rejection code; a specification that
 * names unregistered pools is unprocessable and carries the missing keys. Any
 * other `WorkControlError` here is a CAS or eligibility conflict. Nothing from
 * this plane may fall through as a 500.
 */
function rethrowAdmissionError(error: unknown): never {
	if (error instanceof WorkAdmissionSpecificationError) {
		throw new ORPCError(ErrorCodes.UNPROCESSABLE_CONTENT, {
			message: error.message,
			data: { missingResourceKeys: error.missingResourceKeys },
			cause: error,
		});
	}
	if (error instanceof WorkAdmissionError) {
		throw new ORPCError(ErrorCodes.CONFLICT, {
			message: error.message,
			data: {
				rejectionCode: error.rejectionCode,
				reason: error.message.replace(/^NOT_ELIGIBLE: /, ""),
			},
			cause: error,
		});
	}
	if (
		error instanceof Error &&
		error.name === "WorkControlError" &&
		"code" in error &&
		typeof error.code === "string"
	) {
		if (error.code === "NOT_FOUND") {
			throw createError(ErrorCodes.NOT_FOUND, error.message);
		}
		if (error.code === "INVALID_PRINCIPAL") {
			throw createError(ErrorCodes.UNPROCESSABLE_CONTENT, error.message);
		}
		throw createError(ErrorCodes.CONFLICT, error.message);
	}
	const cause =
		error instanceof Error && "cause" in error
			? (error as Error & { cause?: unknown }).cause
			: undefined;
	if (
		(error instanceof Error && /(?:unique|constraint)/i.test(error.message)) ||
		(cause instanceof Error && /(?:unique|constraint)/i.test(cause.message))
	) {
		throw createError(ErrorCodes.CONFLICT, "The resource changed concurrently");
	}
	throw error;
}

/**
 * Attempt writes cross both planes: the admission queries throw
 * `WorkControlError`/`WorkAdmissionError`, the attempt ledger throws
 * `WorkFactoryError`. Map the admission plane first, then the ledger.
 */
function rethrowAttemptWriteError(error: unknown): never {
	if (
		error instanceof Error &&
		(error.name === "WorkControlError" ||
			error.name === "WorkAdmissionError" ||
			error.name === "WorkAdmissionSpecificationError")
	) {
		rethrowAdmissionError(error);
	}
	rethrowWorkItemWriteError(error);
}

function resourcePoolOutput(row: {
	id: string;
	orgId: string;
	resourceKey: string;
	allocationMode: "exclusive" | "capacity";
	capacity: number;
	ownerRef: string | null;
	createdAt: string;
	updatedAt: string | null;
	version: number;
}) {
	return WorkResourcePoolSchema.parse(row);
}

function budgetEnvelopeOutput(row: {
	id: string;
	orgId: string;
	scopeType: "organization" | "project" | "case" | "work_item";
	scopeId: string;
	currency: string;
	limitMicros: number;
	reservationMicros: number;
	createdAt: string;
	updatedAt: string | null;
	version: number;
}) {
	return WorkBudgetEnvelopeSchema.parse(row);
}

export const WORK_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;
async function resolveAttemptIdentity(
	context: Parameters<typeof verifiedExternalAgent>[0],
	orgId: string,
) {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) return { executor: external.executor, external };
	if (!context.tediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Attempt execution requires a tedi identity or verified external-agent session",
		);
	}
	await assertTediAccess(context, context.tediId, orgId);
	return {
		executor: { type: "tedi" as const, id: context.tediId },
		external: null,
	};
}

async function resolveActor(
	context: Parameters<typeof corroborationPrincipal>[0],
	orgId: string,
): Promise<WorkActor> {
	const principal = await corroborationPrincipal(context, orgId);
	if (principal.type === "organization") {
		return {
			type: "system",
			id: principal.id,
			sessionId: principal.sessionId,
		};
	}
	return {
		type: principal.type,
		id: principal.id,
		sessionId: principal.sessionId,
	};
}

export const updateSpecificationProcedure =
	factoryOs.updateSpecification.handler(async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actorId = await requireOwnerAdminWorkItemAuthor(
			context,
			workItem.orgId,
			"Work Item specification update",
		);
		try {
			return await updateWorkItemSpecification(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor: { type: "user", id: actorId },
				title: input.title,
				description: input.description,
				workKind: input.workKind,
				riskLevel: input.riskLevel,
				priority: input.priority,
				accountableOwnerType: input.accountableOwnerType,
				accountableOwnerId: input.accountableOwnerId,
				stewardType: input.stewardType,
				stewardId: input.stewardId,
				expectedWorkItemVersion: input.expectedWorkItemVersion,
				requiredCapabilities: input.requiredCapabilities,
				requiredAuthorities: input.requiredAuthorities,
				startAt: input.startAt,
				durationDays: input.durationDays,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	});

export const acceptProcedure = factoryOs.accept.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		// Owner/admin humans accept as before; a gateway-verified agent or tedi
		// may accept under its own principal when its credential carries the
		// explicitly granted work:accept scope. acceptWorkItem already takes a
		// principal-typed actor, so the identity is recorded, not flattened.
		const actor = await workItemAcceptanceActor(context, workItem.orgId);
		try {
			requireFactoryAcceptance(workItem.metadata, input.acceptanceContract);
			return await acceptWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				acceptanceContract: input.acceptanceContract,
				actor,
				acceptedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const getReadinessProcedure = factoryOs.getReadiness.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return deriveWorkItemReadiness(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			derivedAt: new Date().toISOString(),
		});
	},
);

export const startAttemptProcedure = factoryOs.startAttempt.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const { executor, external } = await resolveAttemptIdentity(
			context,
			workItem.orgId,
		);
		const startedAt = new Date().toISOString();
		if (input.metadata?.delegatedAssignedWorkItem === true) {
			// Home may already have admitted this actor without changing ownership.
			// Resume that live authority before checking permission for a new attempt.
			if (executor.type === "tedi") {
				const attempts = await listWorkItemAttempts(context.db, {
					orgId: workItem.orgId,
					workItemId: workItem.id,
					limit: 5,
				});
				const active = findAssignedActiveAttempt(
					attempts.data,
					executor.id,
					startedAt,
				);
				if (active) return { workItem, attempt: active, resumed: true };
			}
			if (
				!isAssignedTediExecutor({
					accountableOwnerType: workItem.accountableOwnerType,
					accountableOwnerId: workItem.accountableOwnerId,
					executorType: executor.type,
					executorId: executor.id,
				})
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Delegated execution is limited to Work Items assigned to this tedi",
				);
			}
		}
		try {
			const admission =
				executor.type === "external_agent"
					? await admitWorkAttempt(context.db, {
							workItem,
							executor,
							externalSessionKey: external!.externalSessionKey,
							leaseTtlMs: WORK_ATTEMPT_LEASE_TTL_MS,
							now: startedAt,
						})
					: await admitWorkAttempt(context.db, {
							workItem,
							executor,
							leaseTtlMs: WORK_ATTEMPT_LEASE_TTL_MS,
							now: startedAt,
						});
			const started = await startWorkItemAttempt(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				admissionId: admission.id,
				executor,
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
				runId: input.runId,
				expiresAt: admission.expiresAt,
				metadata: external
					? toJsonRecord(stampExternalAgentMetadata(external, input.metadata))
					: input.metadata
						? toJsonRecord(input.metadata)
						: undefined,
				startedAt,
			});
			if (!input.repository) return started;
			const repository = await provisionWorkAttemptRepository({
				artifacts: context.env.ARTIFACTS,
				enabled: context.env.WORK_ATTEMPT_ARTIFACTS_ENABLED === "true",
				request: input.repository,
				workItemId: workItem.id,
				workItemVersion: workItem.version,
				admissionSpecRevision: workItem.admissionSpecRevision,
				admissionId: admission.id,
				attemptId: started.attempt.id,
			});
			const attempt = await recordWorkAttemptRepository(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: started.attempt.id,
				executor,
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
				repository,
				recordedAt: repository.observedAt,
			});
			return { ...started, attempt, repository };
		} catch (error) {
			rethrowAttemptWriteError(error);
		}
	},
);

export const replaceAdmissionSpecificationProcedure =
	factoryOs.replaceAdmissionSpecification.handler(
		async ({ input, context }) => {
			const workItem = await assertWorkItemAccess(context, input.id);
			await requireOwnerAdminWorkItemAuthor(
				context,
				workItem.orgId,
				"Work admission specification replacement",
			);
			try {
				return await replaceWorkAdmissionSpecification(context.db, {
					orgId: workItem.orgId,
					workItemId: workItem.id,
					expectedWorkItemVersion: input.expectedWorkItemVersion,
					expectedAdmissionSpecRevision: input.expectedAdmissionSpecRevision,
					specification: input.specification,
					now: new Date().toISOString(),
				});
			} catch (error) {
				rethrowAttemptWriteError(error);
			}
		},
	);

export const getAdmissionSpecificationProcedure =
	factoryOs.getAdmissionSpecification.handler(async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return getWorkAdmissionSpecification(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
		});
	});

export const putResourcePoolProcedure = factoryOs.putResourcePool.handler(
	async ({ input, context }) => {
		const orgId = context.organizationId;
		if (!orgId)
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		await requireOwnerAdminWorkItemAuthor(
			context,
			orgId,
			"Work resource pool configuration",
		);
		const now = new Date().toISOString();
		try {
			const current = await getWorkResourcePoolByKey(context.db, {
				orgId,
				resourceKey: input.resourceKey,
				includeDisabled: true,
			});
			if (current) {
				if (input.expectedVersion === undefined) {
					throw createError(
						ErrorCodes.CONFLICT,
						"expectedVersion is required to update an existing resource pool",
					);
				}
				return resourcePoolOutput(
					await updateWorkResourcePool(context.db, {
						orgId,
						poolId: current.id,
						expectedVersion: input.expectedVersion,
						allocationMode: input.allocationMode,
						capacity: input.capacity,
						ownerRef: input.ownerRef,
						now,
					}),
				);
			}
			if (input.expectedVersion !== undefined) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Cannot CAS-update a resource pool that does not exist",
				);
			}
			return resourcePoolOutput(
				await createWorkResourcePool(context.db, {
					id: crypto.randomUUID(),
					orgId,
					resourceKey: input.resourceKey,
					allocationMode: input.allocationMode,
					capacity: input.capacity,
					ownerRef: input.ownerRef,
					now,
				}),
			);
		} catch (error) {
			rethrowAdmissionError(error);
		}
	},
);

export const putBudgetEnvelopeProcedure = factoryOs.putBudgetEnvelope.handler(
	async ({ input, context }) => {
		const orgId = context.organizationId;
		if (!orgId)
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		await requireOwnerAdminWorkItemAuthor(
			context,
			orgId,
			"Work budget envelope configuration",
		);
		const now = new Date().toISOString();
		try {
			const current = await getWorkBudgetEnvelopeByScope(context.db, {
				orgId,
				scopeType: input.scopeType,
				scopeId: input.scopeId,
				includeDisabled: true,
			});
			if (current) {
				if (input.expectedVersion === undefined) {
					throw createError(
						ErrorCodes.CONFLICT,
						"expectedVersion is required to update an existing budget envelope",
					);
				}
				return budgetEnvelopeOutput(
					await updateWorkBudgetEnvelope(context.db, {
						orgId,
						envelopeId: current.id,
						expectedVersion: input.expectedVersion,
						limitMicros: input.limitMicros,
						reservationMicros: input.reservationMicros,
						now,
					}),
				);
			}
			if (input.expectedVersion !== undefined) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Cannot CAS-update a budget envelope that does not exist",
				);
			}
			return budgetEnvelopeOutput(
				await createWorkBudgetEnvelope(context.db, {
					id: crypto.randomUUID(),
					orgId,
					scopeType: input.scopeType,
					scopeId: input.scopeId,
					limitMicros: input.limitMicros,
					reservationMicros: input.reservationMicros,
					currency: "USD",
					now,
				}),
			);
		} catch (error) {
			rethrowAdmissionError(error);
		}
	},
);

export const listResourcePoolsProcedure = factoryOs.listResourcePools.handler(
	async ({ input, context }) => {
		const orgId = context.organizationId;
		if (!orgId)
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		const observedAt = new Date().toISOString();
		const limit = input?.limit ?? 50;
		const page = await listWorkResourcePools(context.db, {
			orgId,
			at: observedAt,
			resourceKey: input?.resourceKey,
			saturatedOnly: input?.saturatedOnly,
			cursor: input?.cursor,
			limit,
		});
		const holders = await listActiveWorkResourceHolders(context.db, {
			orgId,
			poolIds: page.data.map((row) => row.pool.id),
			at: observedAt,
		});
		return {
			data: page.data.map((row) =>
				WorkResourcePoolProjectionSchema.parse({
					pool: resourcePoolOutput(row.pool),
					activeReserved: row.activeReserved,
					effectiveAvailable: row.effectiveAvailable,
					holders: holders
						.filter((holder) => holder.poolId === row.pool.id)
						.slice(0, 8)
						.map(
							({
								poolId: _poolId,
								reservationId: _reservationId,
								holderRank: _rank,
								...holder
							}) => holder,
						),
					holdersTruncated:
						holders.filter((holder) => holder.poolId === row.pool.id).length >
						8,
				}),
			),
			nextCursor: page.nextCursor,
			observedAt,
		};
	},
);

export const listBudgetEnvelopesProcedure =
	factoryOs.listBudgetEnvelopes.handler(async ({ input, context }) => {
		const orgId = context.organizationId;
		if (!orgId)
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		const observedAt = new Date().toISOString();
		const limit = input?.limit ?? 50;
		const page = await listWorkBudgetEnvelopes(context.db, {
			orgId,
			at: observedAt,
			cursor: input?.cursor,
			limit,
		});
		return {
			data: page.data.map((row) =>
				WorkBudgetEnvelopeProjectionSchema.parse({
					envelope: budgetEnvelopeOutput(row),
					committedMicros: row.committedMicros,
					availableMicros: Math.max(0, row.limitMicros - row.committedMicros),
				}),
			),
			nextCursor: page.nextCursor,
			observedAt,
		};
	});

export const heartbeatAttemptProcedure = factoryOs.heartbeatAttempt.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const { executor, external } = await resolveAttemptIdentity(
			context,
			workItem.orgId,
		);
		try {
			return await heartbeatWorkItemAttempt(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				executor,
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
				heartbeatAt: new Date().toISOString(),
				leaseTtlMs: WORK_ATTEMPT_LEASE_TTL_MS,
				costMicros: input.costMicros,
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const settleAttemptProcedure = factoryOs.settleAttempt.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const { executor, external } = await resolveAttemptIdentity(
			context,
			workItem.orgId,
		);
		try {
			return await settleWorkItemAttempt(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				executor,
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
				outcome: input.outcome,
				summary: input.summary,
				metadata: external
					? toJsonRecord(stampExternalAgentMetadata(external, input.metadata))
					: input.metadata
						? toJsonRecord(input.metadata)
						: undefined,
				repositoryLifecycle: input.repositoryLifecycle,
				costMicros: input.costMicros,
				settledAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const listAttemptsProcedure = factoryOs.listAttempts.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return listWorkItemAttempts(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			cursor: input.cursor
				? { startedAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input.limit,
		}).then((page) => ({
			data: page.data,
			nextCursor: page.nextCursor
				? { at: page.nextCursor.startedAt, id: page.nextCursor.id }
				: null,
		}));
	},
);

export const submitEvidenceProcedure = factoryOs.submitEvidence.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actor = await resolveActor(context, workItem.orgId);
		const external =
			actor.type === "external_agent"
				? await verifiedExternalAgent(context, workItem.orgId)
				: null;
		try {
			const normalized = await normalizeSubmittedEvidence(context, {
				uri: input.uri,
				metadata: input.metadata ? toJsonRecord(input.metadata) : undefined,
			});
			const evidence = await submitWorkItemEvidence(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				externalSessionKey: external?.externalSessionKey,
				claimKey: input.claimKey,
				kind: input.kind,
				uri: normalized.uri,
				digest: normalized.digest,
				mediaType: normalized.mediaType,
				label: input.label,
				metadata: normalized.metadata,
				submittedBy: actor,
				submittedAt: new Date().toISOString(),
			});
			// Evidence is recorded telemetry, not a gate: nothing is woken, no
			// readback is performed, and no disposition is required
			// (decisions/minimal-gates-over-pre-proof.md).
			return resolveWorkEvidenceRow(context, evidence);
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const listEvidenceProcedure = factoryOs.listEvidence.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		return listWorkItemEvidence(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			cursor: input.cursor
				? { submittedAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input.limit,
		}).then(async (page) => ({
			data: await Promise.all(
				page.data.map((row) => resolveWorkEvidenceRow(context, row)),
			),
			nextCursor: page.nextCursor
				? { at: page.nextCursor.submittedAt, id: page.nextCursor.id }
				: null,
		}));
	},
);

export const previewEvidenceProcedure = factoryOs.previewEvidence.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const evidence = await getWorkItemEvidence(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			evidenceId: input.evidenceId,
		});
		if (!evidence)
			throw createError(ErrorCodes.NOT_FOUND, "Work evidence not found");
		return previewWorkEvidence(context, evidence);
	},
);

export const listEventsProcedure = factoryOs.listEvents.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const events = await listWorkItemEvents(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			afterSequence: input.afterSequence,
			limit: input.limit,
		});
		return {
			events,
			nextSequence:
				events.length === input.limit
					? events[events.length - 1]!.sequence
					: null,
		};
	},
);

export const completeProcedure = factoryOs.complete.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actorId = await requireOwnerAdminWorkItemAuthor(
			context,
			workItem.orgId,
			"Work Item completion",
		);
		try {
			return await completeWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor: { type: "user", id: actorId },
				completedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const cancelFactoryWorkItemProcedure = factoryOs.cancel.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actorId = await requireOwnerAdminWorkItemAuthor(
			context,
			workItem.orgId,
			"Work Item cancellation",
		);
		try {
			return await cancelWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor: { type: "user", id: actorId },
				reason: input.reason,
				cancelledAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

const cliLedgerOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Each ledger verifies Work Item organization access before reading scoped rows",
		},
		"mcp:work.read",
	),
);
export const listAttemptCliProjectionProcedure =
	cliLedgerOs.listAttemptCliProjection.handler(async ({ input, context }) => {
		const w = await assertWorkItemAccess(context, input.id);
		const p = await listWorkItemAttempts(context.db, {
			orgId: w.orgId,
			workItemId: w.id,
			cursor: input.cursor
				? { startedAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input.limit,
		});
		return ListWorkAttemptCliProjectionResultSchema.parse({
			data: p.data.map((row) => WorkAttemptCliRowSchema.strip().parse(row)),
			nextCursor: p.nextCursor
				? { at: p.nextCursor.startedAt, id: p.nextCursor.id }
				: null,
		});
	});
export const listEvidenceCliProjectionProcedure =
	cliLedgerOs.listEvidenceCliProjection.handler(async ({ input, context }) => {
		const w = await assertWorkItemAccess(context, input.id);
		const p = await listWorkItemEvidence(context.db, {
			orgId: w.orgId,
			workItemId: w.id,
			cursor: input.cursor
				? { submittedAt: input.cursor.at, id: input.cursor.id }
				: undefined,
			limit: input.limit,
		});
		const rows = await Promise.all(
			p.data.map((row) => resolveWorkEvidenceRow(context, row)),
		);
		return ListWorkEvidenceCliProjectionResultSchema.parse({
			data: rows.map((row) => WorkEvidenceCliRowSchema.strip().parse(row)),
			nextCursor: p.nextCursor
				? { at: p.nextCursor.submittedAt, id: p.nextCursor.id }
				: null,
		});
	});
export const listEventCliProjectionProcedure =
	cliLedgerOs.listEventCliProjection.handler(async ({ input, context }) => {
		const w = await assertWorkItemAccess(context, input.id);
		const rows = await listWorkItemEvents(context.db, {
			orgId: w.orgId,
			workItemId: w.id,
			afterSequence: input.afterSequence,
			limit: input.limit,
		});
		return ListWorkEventCliProjectionResultSchema.parse({
			events: rows.map((row) => WorkEventCliRowSchema.strip().parse(row)),
			nextSequence: rows.length === input.limit ? rows.at(-1)!.sequence : null,
		});
	});
