import {
	canonicalSettlementMetadata,
	createCommitResolver,
} from "@tedix/db/queries/git-commit-aliases";
import { CREDIT_BUDGET_CURRENCY } from "@tedix/db/schema/work-factory";
import { walletRpc } from "../../../lib/wallet-rpc";
import { baseErrorConstructors } from "@tedix/api-contract/errors";
import { grantLaneAttempt } from "@tedix/db/queries/work-items/lane-attempt-grants";
import { hasRecoveredCommitCustody } from "./recovered-commit-custody";
import { verifiedImplementationCloseout } from "./implementation-closeout";
import {
	normalizeNativeStewardCloseoutInput,
	assertNativeStewardCloseout,
	prepareNativeStewardCloseout,
} from "./delegated-closeout";
import { recordObservedLearningInteraction } from "../../../services/learning-interaction-recorder";
import {
	assertValidWorkItemProject,
	requireOrgObjective,
	resolveWorkItemPurpose,
	WorkItemProjectError,
	WorkItemPurposeError,
} from "@tedix/db/queries/work-items/purpose";
import {
	PersonalCliReleaseTargetSchema,
	WorkAttemptCliRowSchema,
	WorkAttemptSettlementSchema,
	WorkEvidenceCliRowSchema,
	WorkEventCliRowSchema,
	ListWorkAttemptCliProjectionResultSchema,
	ListWorkEvidenceCliProjectionResultSchema,
	ListWorkEventCliProjectionResultSchema,
} from "@tedix/api-contract/schemas/work-items";
import {
	getAuthoritativeWorkItemAttempt,
	getRecordedWorkItemAttempt,
	getWorkAttemptRepositoryAdmission,
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
	restoreWorkItemFiling,
	updateWorkItemSpecification,
} from "@tedix/db/queries/work-items/crud";
import {
	getWorkItemEvidence,
	listWorkItemEvidence,
	submitWorkItemEvidence,
} from "@tedix/db/queries/work-items/evidence";
import { listWorkItemEvents } from "@tedix/db/queries/work-items/events";
import {
	deriveWorkItemReadiness,
	type WorkItemReadinessResult,
	type WorkItemReadinessGateName,
} from "@tedix/db/queries/work-items/readiness";
import {
	getWorkAdmissionSpecification,
	replaceWorkAdmissionSpecification,
	WorkAdmissionError,
	WorkAdmissionSpecificationError,
	type WorkAdmissionRejectionCode,
} from "@tedix/db/queries/work-items/admissions";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
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
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../../orpc";
import {
	assertTediAccess,
	workObservationPrincipal,
	stampExternalAgentMetadata,
	verifiedExternalAgent,
	verifiedActiveUserMembership,
} from "../work-items-principal";
import {
	assertWorkItemAccess,
	assertOwnerSetLaneExecution,
	authOs,
	requireOwnerAdminWorkItemAuthor,
	workItemAcceptanceActor,
	workItemStewardActor,
	ownAttemptCompletionProblem,
	rethrowWorkItemWriteError,
} from "./policy-helpers";
import { admitWorkAttempt, previewWorkAttempt } from "./attempt-admission";
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
		throw baseErrorConstructors.UNPROCESSABLE_CONTENT({
			message: error.message,
			data: { missingResourceKeys: error.missingResourceKeys },
			cause: error,
		});
	}
	if (error instanceof WorkAdmissionError) {
		throw baseErrorConstructors.CONFLICT({
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
	scopeType: "organization" | "project" | "case" | "work_item" | "objective";
	scopeId: string;
	currency: string;
	mode: "stop" | "alert";
	alertedPercent: number;
	limitMicros: number;
	reservationMicros: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string | null;
	version: number;
}) {
	return WorkBudgetEnvelopeSchema.parse(row);
}

export const WORK_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;
export async function resolveAttemptIdentity(
	context: Parameters<typeof verifiedExternalAgent>[0],
	orgId: string,
) {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) return { executor: external.executor, external };
	if (!context.tediId && context.authType === "user") {
		const member = await verifiedActiveUserMembership(context, orgId);
		return {
			executor: { type: "human" as const, id: member.userId },
			external: null,
		};
	}
	if (!context.tediId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Attempt execution requires a tedi identity or verified external-agent session. This call carried neither an external-agent credential nor an owner-host Agent-Session: run `tedix agent start`, then retry with TEDIX_EXTERNAL_AGENT set to its principal key",
		);
	}
	await assertTediAccess(context, context.tediId, orgId);
	return {
		executor: { type: "tedi" as const, id: context.tediId },
		external: null,
	};
}

async function resolveActor(
	context: Parameters<typeof workObservationPrincipal>[0],
	orgId: string,
): Promise<WorkActor> {
	const principal = await workObservationPrincipal(context, orgId);
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

/**
 * A project move keeps the Work's purpose truthful: objective Work takes the
 * new project's objective.
 */
async function workItemProjectMovePurpose(
	context: BaseContext,
	workItem: Awaited<ReturnType<typeof assertWorkItemAccess>>,
	projectId: string,
): Promise<{ objectiveId?: string | null }> {
	let project: { objectiveId: string | null };
	try {
		project = await assertValidWorkItemProject(context.db, {
			orgId: workItem.orgId,
			projectId,
		});
	} catch (error) {
		if (error instanceof WorkItemProjectError)
			throw createError(ErrorCodes.NOT_FOUND, "Project not found");
		throw error;
	}
	if (workItem.workClass !== "objective") return {};
	if (!project.objectiveId)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Objective Work can move only to a project with an objective",
		);
	return { objectiveId: project.objectiveId };
}

export const updateSpecificationProcedure =
	factoryOs.updateSpecification.handler(async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		if (input.idleReassignment) {
			await requireOwnerAdminWorkItemAuthor(
				context,
				workItem.orgId,
				"Idle runner reassignment",
			);
			if (
				!input.executorReference ||
				input.executorReference.type !== "external_agent" ||
				!input.expectedWorkItemVersion ||
				Object.keys(input).some(
					(key) =>
						![
							"id",
							"executorReference",
							"expectedWorkItemVersion",
							"idleReassignment",
						].includes(key),
				)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Idle reassignment requires an executor and exact version, without specification edits",
				);
			const readiness = await deriveWorkItemReadiness(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				derivedAt: new Date().toISOString(),
			});
			if (!readiness.ready)
				throw createError(ErrorCodes.CONFLICT, "Work is not startable");
			const { reassignIdleWork } =
				await import("@tedix/db/queries/work-items/idle-reassignment");
			try {
				return await reassignIdleWork(context.db, {
					orgId: workItem.orgId,
					workItemId: workItem.id,
					expectedVersion: input.expectedWorkItemVersion,
					executor: input.executorReference.id,
					...input.idleReassignment,
				});
			} catch (error) {
				rethrowWorkItemWriteError(error);
			}
		}
		const { workItemSpecificationActor } =
			await import("./specification-policy");
		const actor = await workItemSpecificationActor(context, workItem, input);
		await assertOwnerSetLaneExecution(
			context,
			workItem.orgId,
			undefined,
			input,
		);
		if (
			input.expectedWorkItemVersion !== undefined &&
			input.expectedWorkItemVersion !== workItem.version
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Work changed before specification update",
			);
		if (
			actor.type !== "user" &&
			[
				actor.type === "tedi" ||
				("canAssignExecutor" in actor && actor.canAssignExecutor)
					? undefined
					: input.executorReference,
				"canMoveProject" in actor && actor.canMoveProject
					? undefined
					: input.projectId,
				input.riskLevel,
				input.workClass,
				input.purposeExceptionExpiresAt,
				input.requiredAuthorities,
				input.requiredCapabilities,
				input.accountableOwnerType,
				input.accountableOwnerId,
				input.stewardType,
				input.stewardId,
				input.delegationDepth,
				input.maxAttempts,
				input.rootWorkItemId,
				input.rootGoal,
				input.budgetShareMicros,
			].some((value) => value !== undefined)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Risk, admission requirements and ownership remain owner/admin controlled",
			);
		}
		try {
			if (
				input.projectId !== undefined &&
				input.projectId !== workItem.projectId &&
				(input.workClass !== undefined ||
					input.purposeExceptionExpiresAt !== undefined)
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Move the project and repair purpose in separate updates",
				);
			let purpose: {
				objectiveId?: string | null;
				workClass?: typeof workItem.workClass;
				purposeExceptionExpiresAt?: string | null;
			} = {};
			if (
				input.workClass !== undefined ||
				input.purposeExceptionExpiresAt !== undefined
			) {
				const useProjectObjective = input.workClass === "objective";
				if (
					!useProjectObjective &&
					(workItem.objectiveId ||
						(workItem.workClass &&
							input.workClass &&
							input.workClass !== workItem.workClass) ||
						(workItem.purposeExceptionExpiresAt &&
							input.purposeExceptionExpiresAt &&
							input.purposeExceptionExpiresAt <
								workItem.purposeExceptionExpiresAt))
				) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Purpose repair cannot replace an objective, change an existing class or shorten its window",
					);
				}
				const project = workItem.projectId
					? await assertValidWorkItemProject(context.db, {
							orgId: workItem.orgId,
							projectId: workItem.projectId,
						})
					: null;
				if (useProjectObjective && !project?.objectiveId)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						project
							? "This project's objective must be set before linking this Work item to it"
							: "This Work item must belong to a project with an objective",
					);
				if (useProjectObjective && input.purposeExceptionExpiresAt)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"An objective link cannot carry an exception expiry",
					);
				if (
					useProjectObjective &&
					workItem.objectiveId &&
					workItem.objectiveId !== project?.objectiveId
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Purpose repair cannot replace an objective",
					);
				const resolved = await resolveWorkItemPurpose(context.db, {
					orgId: workItem.orgId,
					now: new Date().toISOString(),
					workClass: input.workClass ?? workItem.workClass,
					purposeExceptionExpiresAt: useProjectObjective
						? null
						: (input.purposeExceptionExpiresAt ??
							workItem.purposeExceptionExpiresAt),
					parent: workItem.parentWorkItemId
						? await assertWorkItemAccess(context, workItem.parentWorkItemId)
						: null,
					project,
				});
				if (resolved.objectiveId && !useProjectObjective)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Operational repair cannot replace inherited objective context",
					);
				purpose = resolved;
			}
			if (
				input.projectId !== undefined &&
				input.projectId !== workItem.projectId
			)
				purpose = await workItemProjectMovePurpose(
					context,
					workItem,
					input.projectId,
				);
			const executorReference = input.executorReference;
			const laneProject =
				actor.type === "user" &&
				executorReference?.type === "external_agent" &&
				["codex", "claude-code"].includes(executorReference.id) &&
				workItem.projectId
					? await getProjectByIdForOrganization(
							context.db,
							workItem.orgId,
							workItem.projectId,
						)
					: undefined;
			const laneSteward =
				!workItem.stewardId &&
				input.stewardType === undefined &&
				input.stewardId === undefined
					? laneProject?.leadTediId
					: undefined;
			return await updateWorkItemSpecification(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				executorReference,
				laneDispatch: input.laneDispatch,
				projectId: input.projectId,
				title: input.title,
				description: input.description,
				workKind: input.workKind,
				objectiveId: purpose.objectiveId,
				workClass: purpose.workClass ?? undefined,
				purposeExceptionExpiresAt: purpose.purposeExceptionExpiresAt,
				riskLevel: input.riskLevel,
				priority: input.priority,
				accountableOwnerType: input.accountableOwnerType,
				accountableOwnerId: input.accountableOwnerId,
				stewardType: laneSteward ? "tedi" : input.stewardType,
				stewardId: laneSteward ?? input.stewardId,
				expectedWorkItemVersion: workItem.version,
				requiredCapabilities: input.requiredCapabilities,
				requiredAuthorities: input.requiredAuthorities,
				dueDate: input.dueDate,
				deadline: input.deadline,
				startAt: input.startAt,
				durationDays: input.durationDays,
				delegationDepth: input.delegationDepth,
				maxAttempts: input.maxAttempts,
				rootWorkItemId: input.rootWorkItemId,
				rootGoal: input.rootGoal,
				budgetShareMicros: input.budgetShareMicros,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			if (error instanceof WorkItemPurposeError)
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			rethrowWorkItemWriteError(error);
		}
	});

export const restoreFilingProcedure = factoryOs.restoreFiling.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const userId = await requireOwnerAdminWorkItemAuthor(
			context,
			workItem.orgId,
			"Restoring Work filing",
		);
		if (input.expectedWorkItemVersion !== workItem.version)
			throw createError(
				ErrorCodes.CONFLICT,
				"Work changed before filing restore",
			);
		try {
			if (input.projectId)
				await assertValidWorkItemProject(context.db, {
					orgId: workItem.orgId,
					projectId: input.projectId,
				});
			if (input.objectiveId) {
				await requireOrgObjective(context.db, {
					orgId: workItem.orgId,
					objectiveId: input.objectiveId,
				});
			}
			return await restoreWorkItemFiling(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor: { type: "user", id: userId },
				expectedWorkItemVersion: input.expectedWorkItemVersion,
				filing: {
					projectId: input.projectId,
					objectiveId: input.objectiveId,
					workClass: input.workClass,
					purposeExceptionExpiresAt: input.purposeExceptionExpiresAt,
				},
			});
		} catch (error) {
			if (error instanceof WorkItemProjectError)
				throw createError(ErrorCodes.NOT_FOUND, "Project not found");
			if (error instanceof WorkItemPurposeError)
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			rethrowWorkItemWriteError(error);
		}
	},
);

export const acceptProcedure = factoryOs.accept.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		// Owner/admin humans accept as before; a gateway-verified agent or tedi
		// may accept under its own principal when its credential carries the
		// explicitly granted work:accept scope. acceptWorkItem already takes a
		// principal-typed actor, so the identity is recorded, not flattened.
		const actor = await workItemAcceptanceActor(
			context,
			workItem.orgId,
			workItem,
		);
		try {
			requireFactoryAcceptance(workItem.metadata, input.acceptanceContract);
			return await acceptWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				acceptanceContract: input.acceptanceContract,
				priority: input.priority,
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
		const now = new Date().toISOString();
		const readiness = await deriveWorkItemReadiness(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			derivedAt: now,
		});
		const external = await verifiedExternalAgent(context, workItem.orgId);
		if (!external && !context.tediId) return readiness;
		if (!external)
			await assertTediAccess(context, context.tediId!, workItem.orgId);
		try {
			const preview = external
				? await previewWorkAttempt(context.db, {
						workItem,
						executor: external.executor,
						externalSessionKey: external.externalSessionKey,
						now,
					})
				: await previewWorkAttempt(context.db, {
						workItem,
						executor: { type: "tedi", id: context.tediId! },
						now,
					});
			return executorReadiness(readiness, preview.rejection);
		} catch (error) {
			rethrowAttemptWriteError(error);
		}
	},
);

function executorReadiness(
	readiness: WorkItemReadinessResult,
	rejection: Awaited<ReturnType<typeof previewWorkAttempt>>["rejection"],
): WorkItemReadinessResult {
	// Admission does not look at the start date, so a passed preview keeps it.
	const waitsForStart = readiness.gates.find(
		(gate) => gate.gate === "not_before" && gate.evaluation === "failed",
	);
	if (!rejection)
		return {
			...readiness,
			state: waitsForStart ? "not_before" : "ready",
			ready: !waitsForStart,
			reasons: waitsForStart
				? [{ code: "not_before", detail: waitsForStart.detail }]
				: [],
			gates: readiness.gates.map((gate) =>
				gate.gate === "not_before"
					? gate
					: {
							...gate,
							evaluation: "passed",
							detail:
								gate.evaluation === "passed"
									? gate.detail
									: "Verified executor admission preview passed",
						},
			),
		};
	const gateByCode: Record<
		WorkAdmissionRejectionCode,
		WorkItemReadinessGateName
	> = {
		not_accepted: "disposition",
		stale_specification: "disposition",
		purpose_blocked: "purpose",
		dependencies_blocked: "dependencies",
		capability_blocked: "capabilities",
		approval_blocked: "approvals",
		resource_blocked: "resources",
		task_contract_blocked: "task_contract",
		budget_blocked: "budget",
		already_running: "attempt",
		evaluation_required: "resources",
	};
	const state =
		readiness.state === "terminal"
			? "terminal"
			: rejection.code === "stale_specification"
				? "evaluation_required"
				: rejection.code;
	return {
		...readiness,
		state,
		ready: false,
		reasons: [{ code: state, detail: rejection.reason }],
		gates: readiness.gates.map((gate) => {
			if (gate.gate === gateByCode[rejection.code])
				return {
					...gate,
					evaluation: state === "evaluation_required" ? "unknown" : "failed",
					detail: rejection.reason,
				};
			if (
				["capabilities", "approvals", "risk", "budget", "resources"].includes(
					gate.gate,
				)
			)
				return {
					...gate,
					evaluation: "unknown",
					detail:
						"Not established by the unsuccessful executor admission preview",
				};
			return gate;
		}),
	};
}

export const startAttemptProcedure = factoryOs.startAttempt.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const { executor, external } = await resolveAttemptIdentity(
			context,
			workItem.orgId,
		);
		if (executor.type === "human") {
			if (
				workItem.workKind !== "operations" ||
				!PersonalCliReleaseTargetSchema.safeParse(input.metadata?.cliRelease)
					.success
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Human Attempts require operations Work and an exact cliRelease target (commitSha and version)",
				);
		}
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
				executor.type === "human" ||
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
				admission,
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
				enabled: true,
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

export const grantLaneAttemptProcedure = factoryOs.grantLaneAttempt.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		// Restoring budget is a person's decision: an agent session, including
		// an owner-host session, never grants its own Attempts.
		if (
			context.externalAgentPrincipalId ||
			context.externalAgentSessionId ||
			context.externalAgentClientRecordId ||
			context.ownerHostSessionId
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Granting a lane Attempt requires the owner, not an agent session",
			);
		const userId = await requireOwnerAdminWorkItemAuthor(
			context,
			workItem.orgId,
			"Granting a lane Attempt",
		);
		try {
			return await grantLaneAttempt(context.db, {
				id: crypto.randomUUID(),
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				userId,
				reason: input.reason,
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
		if (input.scopeType === "objective" && input.currency !== "credits")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"An objective budget is a credit budget: set currency to credits",
			);
		if (input.mode === "alert" && input.currency === "USD")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a credit budget can be alert-only",
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
				if (input.currency && input.currency !== current.currency)
					throw createError(
						ErrorCodes.CONFLICT,
						"A budget envelope keeps its currency; disable it and create a new one",
					);
				if (input.mode && current.currency !== CREDIT_BUDGET_CURRENCY)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Only a credit budget can be alert-only",
					);
				return budgetEnvelopeOutput(
					await updateWorkBudgetEnvelope(context.db, {
						orgId,
						envelopeId: current.id,
						expectedVersion: input.expectedVersion,
						limitMicros: input.limitMicros,
						reservationMicros: input.reservationMicros,
						mode: input.mode,
						enabled: input.enabled,
						now,
					}),
				);
			}
			if (input.enabled === false)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"There is no budget to turn off at this scope",
				);
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
					reservationMicros:
						input.currency === "credits" ? 0 : input.reservationMicros,
					currency: input.currency ?? "USD",
					mode: input.mode,
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
			includeDisabled: input?.includeDisabled,
		});
		// A credit budget's spend lives in the organization wallet.
		const creditIds = page.data
			.filter((row) => row.currency === CREDIT_BUDGET_CURRENCY)
			.map((row) => row.id);
		const walletSpend = creditIds.length
			? ((await walletRpc(context.env).wallet(orgId, "budget-spend", {
					budgetIds: creditIds,
				})) as Record<string, number>)
			: {};
		return {
			data: page.data.map((row) => {
				const committedMicros =
					row.currency === CREDIT_BUDGET_CURRENCY
						? (walletSpend[row.id] ?? 0)
						: row.committedMicros;
				return WorkBudgetEnvelopeProjectionSchema.parse({
					envelope: budgetEnvelopeOutput(row),
					committedMicros,
					availableMicros: Math.max(0, row.limitMicros - committedMicros),
				});
			}),
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
			const { complete, settlement } = input;
			if (input.metadata && "runQuestion" in input.metadata)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Create a canonical Work Interaction before returning waiting_on_user",
				);
			if (input.metadata && "settlement" in input.metadata)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Put result proof in the typed settlement field.",
				);
			if (complete && input.outcome !== "succeeded")
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Closeout requires outcome succeeded.",
				);
			if (complete && workItem.disposition === "completed") {
				const prior = await getRecordedWorkItemAttempt(context.db, {
					orgId: workItem.orgId,
					workItemId: workItem.id,
					attemptId: input.attemptId,
				});
				if (
					prior?.outcome === "succeeded" &&
					prior.executorType === executor.type &&
					prior.executorId === executor.id &&
					prior.executorSessionId === (external?.executor.sessionId ?? null) &&
					prior.externalSessionKey === (external?.externalSessionKey ?? null) &&
					prior.metadata.closedWorkVersion ===
						complete.expectedWorkItemVersion &&
					workItem.version === complete.expectedWorkItemVersion + 1 &&
					prior.finishedAt === workItem.completedAt
				)
					return {
						workItem,
						attempt: prior,
						settlement: WorkAttemptSettlementSchema.safeParse(
							prior.metadata.settlement,
						).data,
					};
			}
			const attempt = await getAuthoritativeWorkItemAttempt(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				attemptId: input.attemptId,
				executor,
				sessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey: external?.externalSessionKey,
			});
			const receiptMetadata = {
				...input.metadata,
				...(settlement ? { settlement } : {}),
			};
			const mergedMetadata = {
				...attempt.metadata,
				...toJsonRecord(receiptMetadata),
			};
			if (
				input.outcome === "succeeded" &&
				!(await hasRecoveredCommitCustody(context, attempt, mergedMetadata))
			) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Recovered commits require custody from an admitted Attempt of this Work and its recorded session",
				);
			}
			let completion:
				| { actor: WorkActor; expectedWorkItemVersion: number }
				| undefined;
			if (complete) {
				if (
					workItem.disposition !== "accepted" ||
					workItem.version !== complete.expectedWorkItemVersion
				)
					throw createError(
						ErrorCodes.CONFLICT,
						"Work changed before closeout. Read its current revision before retrying.",
					);
				if (external) {
					const problem = await ownAttemptCompletionProblem(context, workItem, {
						...attempt,
						metadata: mergedMetadata,
					});
					if (problem) throw createError(ErrorCodes.FORBIDDEN, problem);
					completion = {
						actor: {
							type: "external_agent",
							id: executor.id,
							sessionId: external.executor.sessionId,
						},
						expectedWorkItemVersion: complete.expectedWorkItemVersion,
					};
				} else {
					completion = {
						actor: await workItemStewardActor(context, workItem, "completion"),
						expectedWorkItemVersion: complete.expectedWorkItemVersion,
					};
				}
			}
			const { summarizeFeedOutcome } =
				await import("../../../services/feed-outcome-summary");
			const feedSentence = await summarizeFeedOutcome(context, {
				organizationId: workItem.orgId,
				title: workItem.title,
				outcome: input.outcome,
				summary: input.summary,
			});
			const { attemptRunnerMetrics } =
				await import("../../../services/attempt-runner-metrics");
			const metadata = {
				...receiptMetadata,
				feedSentence,
				runnerMetrics: await attemptRunnerMetrics(
					context,
					external,
					toJsonRecord(receiptMetadata),
				),
			};
			const settledAt = new Date().toISOString();
			const settled = await settleWorkItemAttempt(context.db, {
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
					? toJsonRecord(stampExternalAgentMetadata(external, metadata))
					: toJsonRecord(metadata),
				repositoryLifecycle: input.repositoryLifecycle,
				completion,
				costMicros: input.costMicros,
				settledAt,
			});
			const { notifyAgentRunEnded } =
				await import("../../../services/agent-run-ended-notice");
			// The settle is recorded; reporting it to the chat must not delay or
			// fail the runner's response.
			const notice = notifyAgentRunEnded(
				context,
				settled.workItem,
				settled.attempt,
			);
			if (context.waitUntil) context.waitUntil(notice);
			else await notice;
			const { recordAgentRunOutcomeLesson } =
				await import("../../../services/agent-run-outcome-lesson");
			// The tedi that started the run remembers how it ended.
			const lesson = recordAgentRunOutcomeLesson(
				context,
				settled.workItem,
				settled.attempt,
			);
			if (context.waitUntil) context.waitUntil(lesson);
			else await lesson;
			if (completion)
				await recordWorkCompletedLearning(context, settled.workItem);
			return { ...settled, settlement };
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const listAttemptsProcedure = factoryOs.listAttempts.handler(
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
		const workItem = await assertWorkItemAccess(context, request.id);
		const cursor = "cursor" in input ? input.cursor : undefined;
		const resolver = createCommitResolver(context.db);
		return listWorkItemAttempts(context.db, {
			orgId: workItem.orgId,
			workItemId: workItem.id,
			cursor: cursor ? { startedAt: cursor.at, id: cursor.id } : undefined,
			limit: "limit" in input ? input.limit : 1,
		}).then(async (page) => ({
			data: await Promise.all(
				page.data.map(async (row) => ({
					...row,
					metadata: await canonicalSettlementMetadata(resolver, row.metadata),
				})),
			),
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

async function recordWorkCompletedLearning(
	context: BaseContext,
	completed: Awaited<ReturnType<typeof assertWorkItemAccess>>,
) {
	await recordObservedLearningInteraction(context, {
		organizationId: completed.orgId,
		clientEventId: `work-outcome:${completed.id}:completed`,
		eventKind: "accepted",
		surface: "work_outcome",
		targetType: "work_item",
		targetId: completed.id,
		metadata: {
			decisionClass: completed.workKind,
			projectId: completed.projectId,
			outcome:
				!completed.deadline || !completed.completedAt
					? "completed"
					: Date.parse(completed.completedAt) <=
						  Date.parse(
								completed.deadline.length === 10
									? `${completed.deadline}T23:59:59.999Z`
									: completed.deadline,
						  )
						? "completed_on_time"
						: "completed_late",
			deadline: completed.deadline,
			completedAt: completed.completedAt,
		},
	});
}

export const completeProcedure = factoryOs.complete.handler(
	async ({ input, context }) => {
		const request =
			input.nativeStewardCloseout !== undefined
				? normalizeNativeStewardCloseoutInput({
						nativeStewardCloseout: input.nativeStewardCloseout,
					})
				: { id: input.id, nativeStewardCloseout: undefined };
		const native = request.nativeStewardCloseout
			? await prepareNativeStewardCloseout(context, {
					id: request.id,
					nativeStewardCloseout: request.nativeStewardCloseout,
				})
			: null;
		const workItem =
			native?.item ?? (await assertWorkItemAccess(context, request.id));
		if (native?.completed) return workItem;
		const implementation = native
			? null
			: await verifiedImplementationCloseout(context, workItem);
		const actor =
			implementation?.actor ??
			(await workItemStewardActor(context, workItem, "completion"));
		try {
			const completed = await completeWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				expectedWorkItemVersion:
					request.nativeStewardCloseout?.expectedWorkItemVersion ??
					workItem.version,
				nativeStewardCloseout: native?.fence ?? undefined,
				reclassifiedImplementationAttemptId: implementation?.attemptId,
				closingComment: implementation
					? {
							id: crypto.randomUUID(),
							body: `Classified as coding and completed after verifying commit ${implementation.commit} on main.`,
							metadata: {
								observationId: implementation.observationId,
								attemptId: implementation.attemptId,
								previousKind: "design",
							},
						}
					: (native?.closingComment ?? undefined),
				completedAt: new Date().toISOString(),
			});
			await recordWorkCompletedLearning(context, completed);
			return completed;
		} catch (error) {
			rethrowWorkItemWriteError(error);
		}
	},
);

export const cancelFactoryWorkItemProcedure = factoryOs.cancel.handler(
	async ({ input, context }) => {
		const workItem = await assertWorkItemAccess(context, input.id);
		const actor = await workItemStewardActor(
			context,
			workItem,
			"cancellation",
			input.reason,
		);
		try {
			return await cancelWorkItem(context.db, {
				orgId: workItem.orgId,
				workItemId: workItem.id,
				actor,
				reason: input.reason,
				expectedWorkItemVersion:
					input.hygiene?.expectedWorkItemVersion ?? workItem.version,
				hygiene: input.hygiene,
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
		const resolver = createCommitResolver(context.db);
		return ListWorkAttemptCliProjectionResultSchema.parse({
			data: await Promise.all(
				p.data.map(async (row) =>
					WorkAttemptCliRowSchema.strip().parse({
						...row,
						runnerMetrics: row.metadata.runnerMetrics,
						metadata: await canonicalSettlementMetadata(resolver, row.metadata),
					}),
				),
			),
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

/** A personal login authorizes only its own live, dedicated release Attempt. */
export const authorizePersonalCliReleaseProcedure =
	cliLedgerOs.authorizePersonalCliRelease.handler(
		async ({ input, context }) => {
			const work = await assertWorkItemAccess(context, input.id);
			if ((await verifiedExternalAgent(context, work.orgId)) || context.tediId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Personal release authorization requires a human login",
				);
			const member = await verifiedActiveUserMembership(context, work.orgId);
			const page = await listWorkItemAttempts(context.db, {
				orgId: work.orgId,
				workItemId: work.id,
				limit: 1,
			});
			const attempt = page.data[0];
			const admission = attempt
				? await getWorkAttemptRepositoryAdmission(context.db, attempt)
				: null;
			const target = PersonalCliReleaseTargetSchema.safeParse(
				attempt?.metadata.cliRelease,
			);
			const resolver = createCommitResolver(context.db);
			if (
				work.disposition !== "accepted" ||
				work.workKind !== "operations" ||
				!attempt ||
				!admission ||
				admission.workItemVersion !== work.version ||
				admission.admissionSpecRevision !== work.admissionSpecRevision ||
				attempt.executorType !== "human" ||
				attempt.executorId !== member.userId ||
				attempt.runtimeState !== "running" ||
				attempt.outcome !== null ||
				attempt.finishedAt !== null ||
				!attempt.expiresAt ||
				!(Date.parse(attempt.expiresAt) > Date.now()) ||
				!target.success ||
				(await resolver.canonicalCommit(target.data.commitSha)) !==
					(await resolver.canonicalCommit(input.commitSha)) ||
				target.data.version !== input.version ||
				!["refs/heads/main", `refs/tags/cli-v${input.version}`].includes(
					input.ref,
				)
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Personal release requires a live matching Work Attempt for the exact release",
				);
			return {
				userId: member.userId,
				orgId: work.orgId,
				attemptId: attempt.id,
				expiresAt: attempt.expiresAt,
				commitSha: input.commitSha,
				ref: input.ref,
			};
		},
	);
