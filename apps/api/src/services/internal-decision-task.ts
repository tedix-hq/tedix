import { call } from "@orpc/server";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "@tedix/api-contract/schemas/os-decision-deck";
import {
	DEFAULT_DECISION_AUTONOMY,
	decideDecisionAutonomy,
} from "@tedix/api-contract/utils/decision-autonomy";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import {
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import { requireOrgId } from "../rpc/org-scope";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import { readOrgDispatchPolicyLayer } from "../rpc/routers/kernel/tedi-capabilities";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";

type TaskEffect = Extract<
	NonNullable<DecisionEnvelope["options"][number]["effect"]>,
	{ kind: "create_owner_task" }
>;

/** Executes only internal task creation; it never answers a person's card. */
export async function executeInternalDecisionTask(
	context: BaseContext,
	request: {
		id: string;
		orgId: string;
		targetId: string | null;
		workItemId: string | null;
		creatorType: string;
		creatorId: string;
		creatorSessionId?: string | null;
		kind?: string;
		metadata: Record<string, unknown>;
	},
	effect: TaskEffect,
) {
	const orgId = requireOrgId(context);
	if (request.orgId !== orgId || !request.targetId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Internal task scope is unavailable",
		);
	const metadata = request.metadata;
	if (
		request.kind === "handoff" ||
		metadata.approvalOperation !== undefined ||
		metadata.localImport ||
		metadata.schema === "tedix.outbound.v1" ||
		(metadata.riskLevel !== undefined &&
			metadata.riskLevel !== "low" &&
			metadata.riskLevel !== "medium") ||
		(Object.hasOwn(metadata, "protectedEffects") &&
			(!Array.isArray(metadata.protectedEffects) ||
				metadata.protectedEffects.length > 0)) ||
		(typeof metadata.decisionClass === "string" &&
			new RegExp(DEFAULT_DECISION_AUTONOMY.reservedClassPattern, "i").test(
				metadata.decisionClass,
			))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"This request protects a human-reserved action",
		);
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type === "user")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An owning agent must handle this task",
		);
	const author =
		request.creatorType === actor.type &&
		request.creatorId === actor.id &&
		(actor.type !== "external_agent" ||
			request.creatorSessionId === actor.sessionId);
	const curator =
		!author &&
		actor.type === "tedi" &&
		(await getDecisionLearningConfig(context.db, orgId)).deckCurators.some(
			(grant) =>
				grant.enabled &&
				grant.tediId === actor.id &&
				grant.recipientId === request.targetId,
		);
	if (!author && !curator)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the author or granted curator can handle this task",
		);
	const parsed = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	const approvedEffects = parsed.success
		? parsed.data.options.filter(
				(option) => option.intent === "approve" && option.effect,
			)
		: [];
	const stored = approvedEffects[0]?.effect;
	if (
		!parsed.success ||
		parsed.data.kind === "approval" ||
		approvedEffects.length !== 1 ||
		stored?.kind !== "create_owner_task" ||
		effect.kind !== "create_owner_task" ||
		stored.workItemId !== effect.workItemId ||
		stored.title !== effect.title ||
		stored.description !== effect.description ||
		request.workItemId !== effect.workItemId ||
		(parsed.data.expiresAt && Date.parse(parsed.data.expiresAt) <= Date.now())
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The stored internal task effect is unavailable",
		);
	const layer = await readOrgDispatchPolicyLayer(context.db, orgId);
	const verdict = decideDecisionAutonomy({
		policy: layer?.effect === "deny" ? null : layer?.autonomy,
		action: {
			classId: "internal.work.create",
			risk: "low",
			reversibility: "two_way",
			scope: "internal",
			ownerType: actor.type,
			effectKind: "create_owner_task",
			actionContent: "Create internal Work item",
		},
		decision: parsed.data,
	});
	if (!verdict.eligible)
		throw createError(ErrorCodes.FORBIDDEN, verdict.reason);
	const source = await getWorkItemById(context.db, effect.workItemId, orgId);
	if (!source)
		throw createError(ErrorCodes.NOT_FOUND, "The source task is unavailable");
	const sourceIntentId = `decision-owner-task:${request.id}`;
	const lookup = () =>
		getWorkItemBySourceIntentId(context.db, { orgId, sourceIntentId });
	let task = await lookup();
	if (!task) {
		const { createProcedure } =
			await import("../rpc/routers/work-items/creation-reads");
		try {
			task = await call(
				createProcedure,
				{
					title: effect.title,
					description: effect.description,
					workKind: "communication",
					riskLevel: "low",
					parentWorkItemId: source.id,
					projectId: source.projectId ?? undefined,
					accountableOwnerType: "user",
					accountableOwnerId: request.targetId,
					sourceIntentId,
					metadata: {
						source: "decision-owner-task",
						requestId: request.id,
						sendingReservedForOwner: true,
						handledBy: { type: actor.type, id: actor.id },
					},
				},
				{ context },
			);
		} catch (error) {
			task = await lookup();
			if (!task) throw error;
		}
	}
	if (
		task.parentWorkItemId !== source.id ||
		task.accountableOwnerType !== "user" ||
		task.accountableOwnerId !== request.targetId ||
		task.title !== effect.title ||
		task.description !== effect.description ||
		task.metadata?.source !== "decision-owner-task" ||
		task.metadata?.requestId !== request.id ||
		task.metadata?.sendingReservedForOwner !== true
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"The internal task provenance does not match this request",
		);
	if (task.disposition === "cancelled")
		throw createError(
			ErrorCodes.CONFLICT,
			"This internal task was cancelled; a new owner request is required",
		);
	return {
		taskId: task.id,
		state: task.disposition,
		classId: verdict.classId,
		...(layer?.autonomy?.policyPack
			? { policyPack: layer.autonomy.policyPack }
			: {}),
	};
}
