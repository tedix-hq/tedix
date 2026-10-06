import { implement } from "@orpc/server";
import { workSchedulerContract } from "@tedix/api-contract/contracts/work-scheduler";
import {
	WorkExecutionClusterPlanSchema,
	WorkSchedulerReadyQueueSchema,
} from "@tedix/api-contract/schemas/work-scheduler";
import {
	listReadyWork,
	listReadyWorkExecutionClusters,
	type ReadyWorkCandidate,
} from "@tedix/db/queries/work-items/scheduler";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { verifiedActiveWorkActor } from "./work-items-principal";
import { rethrowWorkControlError } from "./work-items/policy-helpers";

const schedulerOs = implement(workSchedulerContract).$context<BaseContext>();
const authOs = schedulerOs.use(withAuth).use(AUTHZ.messagingRead);

const factorMetadata = {
	priority: ["priority", "Durable Work priority contribution"],
	urgency: ["urgency", "Due-date and deadline urgency contribution"],
	aging: ["aging_fairness", "Bounded aging fairness contribution"],
	downstream: [
		"downstream_impact",
		"Reachable downstream dependency contribution",
	],
	criticalPath: ["critical_path", "Dependency critical-path contribution"],
	risk: ["risk", "Risk penalty contribution"],
	cost: ["estimated_cost", "Bounded estimated-cost penalty"],
	verifierBackpressure: [
		"verification_backpressure",
		"Pending verification backpressure penalty",
	],
} as const;

/**
 * Project one ranked candidate onto the wire.
 *
 * `compact` (the default) drops every prose `explanation` while keeping all
 * eight factor names, values, and contributions. The prose is fixed per factor
 * and adds no per-item information, but it roughly doubled the receipt and made
 * the documented-as-inspectable ready queue unreadable through the MCP gateway
 * past six items.
 */
export function mapReadyCandidate(
	candidate: ReadyWorkCandidate,
	verbosity: "compact" | "full",
) {
	const verbose = verbosity === "full";
	const verificationHeavy =
		candidate.workItem.requiredAuthorities.length > 0 ||
		candidate.workItem.riskLevel === "high" ||
		candidate.workItem.riskLevel === "critical";
	return {
		workItemId: candidate.workItem.id,
		title: candidate.workItem.title,
		workKind: candidate.workItem.workKind,
		priority: candidate.workItem.priority,
		riskLevel: candidate.workItem.riskLevel,
		projectId: candidate.workItem.projectId,
		parentWorkItemId: candidate.workItem.parentWorkItemId,
		dueDate: candidate.workItem.dueDate,
		deadline: candidate.workItem.deadline,
		score: Math.round(candidate.score),
		factors: Object.entries(factorMetadata).map(
			([key, [factor, explanation]]) => ({
				factor,
				value: candidate.factors[key as keyof typeof factorMetadata],
				contribution: Math.round(
					candidate.factors[key as keyof typeof factorMetadata],
				),
				...(verbose ? { explanation } : {}),
			}),
		),
		eligibility: {
			state: "ready" as const,
			...(verbose
				? {
						explanation:
							"Every admission gate passed for this exact executor snapshot",
					}
				: {}),
		},
		taskGuidance: {
			taskClass: verificationHeavy
				? ("verification_heavy" as const)
				: ("atomic" as const),
			fanout: "single_executor" as const,
			recommendedMaxParallelism: 1 as const,
			...(verbose
				? {
						explanation: "One admitted executor owns the fenced Work attempt",
					}
				: {}),
		},
	};
}

function ineligibleReasons(result: {
	ineligibleByReason: Record<string, number>;
}) {
	return {
		not_accepted: 0,
		already_running: 0,
		already_admitted: 0,
		purpose_blocked: 0,
		dependencies_blocked: 0,
		capability_blocked: 0,
		approval_blocked: 0,
		budget_blocked: 0,
		resource_blocked: 0,
		evaluation_required: 0,
		coordination_parent: 0,
		cost_blocked: 0,
		...result.ineligibleByReason,
	};
}

const listReadyProcedure = authOs.listReady.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		if (actor.type === "user") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"The ready queue requires an active tedi or external-agent executor",
			);
		}
		if (
			input.executor &&
			(input.executor.type !== actor.type ||
				input.executor.id !== actor.id ||
				(input.executor.type === "external_agent" &&
					input.executor.sessionId !== actor.sessionId))
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Scheduler executor must match the authenticated credential",
			);
		}
		const verbosity = input.verbosity ?? "compact";
		const now = new Date().toISOString();
		let result: Awaited<ReturnType<typeof listReadyWork>>;
		try {
			result = await listReadyWork(context.db, {
				orgId,
				executorType: actor.type,
				executorId: actor.id,
				executorSessionId: actor.sessionId,
				externalSessionKey: actor.externalSessionKey,
				now,
				limit: input.limit,
				candidateLimit: input.candidateLimit,
				cursor: input.cursor,
			});
		} catch (error) {
			rethrowWorkControlError(error, {
				invalidPrincipal: "forbidden",
				notFound: "bad_request",
			});
		}
		return WorkSchedulerReadyQueueSchema.parse({
			policyRevision: "work-scheduler/v1",
			verbosity,
			observedAt: result.observedAt,
			evaluatedCandidates: result.evaluatedCandidates,
			ineligibleByReason: ineligibleReasons(result),
			graphTruncated: result.graphTruncated,
			factsTruncated: result.factsTruncated,
			truncatedFacts: result.truncatedFacts,
			items: result.data.map((item) => mapReadyCandidate(item, verbosity)),
			nextCursor: result.nextCursor,
			boundedCandidateLimit: result.boundedCandidateLimit,
		});
	},
);

const planClustersProcedure = authOs.planClusters.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		if (actor.type === "user" && input.executor?.type !== "tedi")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Operator cluster planning requires an explicit active tedi executor",
			);
		if (
			actor.type !== "user" &&
			input.executor &&
			(input.executor.type !== actor.type ||
				input.executor.id !== actor.id ||
				(input.executor.type === "external_agent" &&
					input.executor.sessionId !== actor.sessionId))
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cluster executor must match the authenticated credential",
			);
		const executor = actor.type === "user" ? input.executor! : actor;
		const verbosity = input.verbosity ?? "compact";
		let result: Awaited<ReturnType<typeof listReadyWorkExecutionClusters>>;
		try {
			result = await listReadyWorkExecutionClusters(context.db, {
				orgId,
				executorType: executor.type,
				executorId: executor.id,
				executorSessionId:
					executor.type === "external_agent" ? executor.sessionId : undefined,
				externalSessionKey:
					executor.type === "external_agent"
						? actor.type === "external_agent"
							? actor.externalSessionKey
							: undefined
						: undefined,
				now: new Date().toISOString(),
				limit: input.limit,
				candidateLimit: input.candidateLimit,
				maxParallelism: input.maxParallelism,
			});
		} catch (error) {
			rethrowWorkControlError(error, {
				invalidPrincipal: "forbidden",
				notFound: "bad_request",
			});
		}
		return WorkExecutionClusterPlanSchema.parse({
			policyRevision: "work-clusters/v1",
			verbosity,
			observedAt: result.observedAt,
			evaluatedCandidates: result.evaluatedCandidates,
			ineligibleByReason: ineligibleReasons(result),
			boundedCandidateLimit: result.boundedCandidateLimit,
			graphTruncated: result.graphTruncated,
			factsTruncated: result.factsTruncated,
			truncatedFacts: result.truncatedFacts,
			clusters: result.clusters.map((cluster) => ({
				index: cluster.index,
				items: cluster.items.map((item) => mapReadyCandidate(item, verbosity)),
				recommendedMaxParallelism: cluster.items.length,
				resourceKeys: cluster.resourceKeys,
				...(verbosity === "full"
					? {
							explanation:
								"Items in this wave are mutually compatible at the observed resource snapshot; start still re-evaluates admission.",
						}
					: {}),
			})),
			totalReadyItems: result.data.length,
			maxParallelism: result.maxParallelism,
			advisory: true,
		});
	},
);

export const workSchedulerContractRouter = schedulerOs.router({
	listReady: listReadyProcedure,
	planClusters: planClustersProcedure,
});
