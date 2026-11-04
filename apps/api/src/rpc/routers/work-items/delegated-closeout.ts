import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import { readDelegationAutonomyLessons } from "@tedix/db/queries/work-items/delegation-autonomy";
import { listSubmissionsByRun } from "@tedix/db/queries/runtime-submissions/read-models";
import {
	NativeStewardCloseoutProofSchema,
	StewardCloseoutTargetsSchema,
	type NativeStewardCloseoutProof,
} from "@tedix/api-contract/schemas/work-items";
import { KernelRequestPolicySchema } from "@tedix/api-contract/schemas/kernel-request";
import { getActiveOrganizationPolicyPack } from "@tedix/db/queries/kernel-runtime-support";
import { getWorkItemCommentById } from "@tedix/db/queries/work-items/comments";
import { getAuthoritativeWorkItemAttempt } from "@tedix/db/queries/work-items/attempts";
import type { NativeStewardCloseoutFence } from "@tedix/db/queries/work-items/crud";
import { findRepositoryPushObservations } from "@tedix/db/queries/repository-observer";
import { readConfiguredRepositoryDelivery } from "../../../kernel/request-target-readers";
import { guardedFetch } from "@tedix/ssrf-guard";
import { createRouterClient } from "@orpc/server";
import { DelegationCapabilityPlanSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { decideAutonomousAction } from "@tedix/api-contract/utils/approval-policy";
import {
	closeoutRequiresHuman,
	delegatedCloseoutProjects,
} from "@tedix/api-contract/utils/delegated-work-closeout";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { completeWorkItem } from "@tedix/db/queries/work-items/crud";
import {
	createError,
	ErrorCodes,
	type BaseContext,
	withAuthorization,
} from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { assertTediAccess } from "../work-items-principal";
import {
	assertWorkItemAccess,
	authOs,
	rethrowWorkItemWriteError,
} from "./policy-helpers";

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
const forbidden = (message: string): never => {
	throw createError(ErrorCodes.FORBIDDEN, message);
};

/** Native runtime authority is bounded by the owner's persisted request. A
 * supplied Home ID or a delegated MCP bearer grants no Work write authority. */
export async function closeoutDelegatedWork(
	context: BaseContext,
	input: {
		id: string;
		homeRunId: string;
		runId: string;
		linkedWorkItemId: string;
		sha: string;
	},
) {
	if (
		context.authType !== "service-binding" ||
		!context.tediId ||
		context.externalAgentPrincipalId ||
		context.headers.get("X-Tedix-Mcp-Tool-Id") ||
		context.serviceBindingAuthorization?.source === "mcp-tool" ||
		context.headers.get("X-Tedix-Caller-Source") !== "http-platform-client"
	)
		forbidden("Delegated closeout requires the native tedi runtime");
	const organizationId = requireOrgId(context);
	const tedi = await assertTediAccess(context, context.tediId!, organizationId);
	if (tedi.status !== "active")
		forbidden("Delegated closeout requires an active tedi");
	const home = await getKernelRuntimeRun(context.db, {
		id: input.homeRunId,
		organizationId,
	});
	if (
		!home ||
		!["queued", "running", "waiting"].includes(home.status) ||
		home.delegatedTediId !== tedi.id ||
		home.childRunId !== input.runId ||
		home.metadata?.workItemId !== input.linkedWorkItemId ||
		input.id === input.linkedWorkItemId
	)
		forbidden("Delegated closeout does not match an active Home dispatch");
	const original = record(home!.metadata?.redriveInput);
	const order = record(record(home!.metadata?.homeDelegation).workOrder);
	const plan = DelegationCapabilityPlanSchema.safeParse(order.capabilityPlan);
	const projects =
		typeof original.content === "string"
			? delegatedCloseoutProjects(original.content)
			: [];
	if (
		!plan.success ||
		!plan.data.allowedToolIds.includes("close_completed_work_item") ||
		!projects.length ||
		typeof original.descopeUserId !== "string"
	)
		forbidden("Home did not authorize a project-scoped closeout");
	const member = await getMemberByUserId(
		context.db,
		organizationId,
		original.descopeUserId as string,
	);
	if (member?.status !== "active" || !["owner", "admin"].includes(member.role))
		forbidden(
			"Delegated closeout requires the requesting owner's current active membership",
		);
	const { mcpGovernanceContractRouter } = await import("../mcp-governance");
	const policy = await createRouterClient(mcpGovernanceContractRouter, {
		context,
	}).resolveAgentTransportPolicy({ organizationId, tediId: tedi.id });
	const autonomy = decideAutonomousAction({
		policy: policy.autonomy,
		risk: "medium",
		content:
			"Complete one settled coding Work item with its closing SHA comment",
		classId: "native:close_completed_work_item",
	});
	if (
		policy.requireExplicitApprovalPolicy ||
		closeoutRequiresHuman(policy.autonomy?.askForClasses) ||
		!autonomy.autoApprove
	)
		forbidden("Current policy requires human approval for this Work closeout");
	const item = await assertWorkItemAccess(context, input.id);
	if (
		!item.projectId ||
		!projects.includes(item.projectId.toLowerCase()) ||
		item.workKind !== "coding" ||
		!["low", "medium"].includes(item.riskLevel) ||
		!["accepted", "completed"].includes(item.disposition)
	)
		forbidden(
			"Work item is outside the requested low/medium-risk coding closeout scope",
		);
	const attempts = await listWorkItemAttempts(context.db, {
		orgId: organizationId,
		workItemId: item.id,
		limit: 1,
	});
	const latest = attempts.data[0];
	if (
		!latest ||
		latest.runtimeState !== "finished" ||
		latest.outcome !== "succeeded" ||
		!latest.finishedAt ||
		!new RegExp(`\\b${input.sha}\\b`, "i").test(
			JSON.stringify([latest.summary, latest.metadata]),
		)
	)
		forbidden(
			"Closeout requires the latest settled successful Attempt with this exact full SHA",
		);
	const linked = await listWorkItemAttempts(context.db, {
		orgId: organizationId,
		workItemId: input.linkedWorkItemId,
		limit: 1,
	});
	const active = linked.data[0];
	if (
		!active ||
		active.executorType !== "tedi" ||
		active.executorId !== tedi.id ||
		active.runId !== input.runId ||
		!["running", "waiting", "retrying"].includes(active.runtimeState) ||
		!active.expiresAt ||
		active.expiresAt <= new Date().toISOString()
	)
		forbidden("Delegated closeout requires its current fenced Work Attempt");
	try {
		const completed = await completeWorkItem(context.db, {
			orgId: organizationId,
			workItemId: item.id,
			actor: { type: "tedi", id: tedi.id },
			expectedWorkItemVersion: item.version,
			closingComment: {
				id: `${input.homeRunId}:closeout:${item.id}`,
				body: `Completed: ${input.sha.toLowerCase()} verified on origin/main.`,
				metadata: {
					homeRunId: input.homeRunId,
					childRunId: input.runId,
					delegatedByUserId: member!.userId,
					settledAttemptId: latest!.id,
				},
			},
		});
		return completed;
	} catch (error) {
		rethrowWorkItemWriteError(error);
	}
}

const nativeCloseoutOs = authOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"The handler rejects human and MCP transports and verifies the persisted requesting owner's current membership",
		},
		"mcp:messaging.write",
	),
);
export const closeoutDelegatedProcedure =
	nativeCloseoutOs.closeoutDelegated.handler(({ input, context }) =>
		closeoutDelegatedWork(context, input),
	);

export function normalizeNativeStewardCloseoutInput(input: {
	nativeStewardCloseout: NativeStewardCloseoutProof & { id: string };
}) {
	const { id, ...proof } = input.nativeStewardCloseout;
	return { id, nativeStewardCloseout: proof };
}

export async function assertNativeStewardCloseout(
	context: BaseContext,
	input: { id: string; nativeStewardCloseout: NativeStewardCloseoutProof },
) {
	const proof = NativeStewardCloseoutProofSchema.parse(
		input.nativeStewardCloseout,
	);
	if (
		context.authType !== "service-binding" ||
		!context.tediId ||
		context.externalAgentPrincipalId ||
		context.headers.get("X-Tedix-Mcp-Tool-Id") ||
		context.serviceBindingAuthorization?.source === "mcp-tool" ||
		context.headers.get("X-Tedix-Caller-Source") !== "http-platform-client"
	)
		return forbidden("Steward closeout requires the native tedi runtime");
	if (input.id === proof.linkedWorkItemId || !/^[a-f\d-]{36}$/i.test(input.id))
		return forbidden(
			"The coordinator's own Work cannot be a steward closeout target",
		);
	const organizationId = requireOrgId(context);
	const tedi = await assertTediAccess(context, context.tediId!, organizationId);
	if (tedi.status !== "active")
		return forbidden("Steward closeout requires an active tedi");
	const home = await getKernelRuntimeRun(context.db, {
		id: proof.homeRunId,
		organizationId,
	});
	if (
		!home ||
		!["queued", "running", "waiting"].includes(home.status) ||
		home.delegatedTediId !== tedi.id ||
		home.childRunId !== proof.runId ||
		home.metadata?.workItemId !== proof.linkedWorkItemId
	)
		return forbidden("Steward closeout does not match an active Home dispatch");
	const original = record(home!.metadata?.redriveInput);
	const order = record(record(home!.metadata?.homeDelegation).workOrder);
	const plan = DelegationCapabilityPlanSchema.safeParse(order.capabilityPlan);
	const requested = StewardCloseoutTargetsSchema.safeParse(
		record(original.runtimeMetadata).stewardCloseoutTargets,
	);
	if (
		!plan.success ||
		!requested.success ||
		!plan.data.stewardCloseoutTargets ||
		JSON.stringify(plan.data.stewardCloseoutTargets) !==
			JSON.stringify(requested.data) ||
		!plan.data.allowedToolIds.includes("read_steward_work") ||
		!plan.data.allowedToolIds.includes("complete_steward_work") ||
		typeof original.descopeUserId !== "string"
	)
		return forbidden(
			"Home did not authorize this exact native steward closeout request",
		);
	const target = plan.data.stewardCloseoutTargets!.find(
		(row) =>
			row.id === input.id &&
			row.expectedWorkItemVersion === proof.expectedWorkItemVersion,
	);
	if (!target) forbidden("Work is outside the owner's frozen closeout targets");
	const owner = await getMemberByUserId(
		context.db,
		organizationId,
		original.descopeUserId as string,
	);
	if (owner?.status !== "active" || !["owner", "admin"].includes(owner.role))
		return forbidden("The original requesting owner is no longer active");
	const coordinatorWork = await assertWorkItemAccess(
		context,
		proof.linkedWorkItemId,
	);
	if (
		coordinatorWork.disposition !== "accepted" ||
		(
			await listSubmissionsByRun(context.db, organizationId, proof.homeRunId)
		).some((row) => row.abortRequestedAt)
	)
		return forbidden("The native coordinator request was canceled or revoked");
	const linked = (
		await listWorkItemAttempts(context.db, {
			orgId: organizationId,
			workItemId: proof.linkedWorkItemId,
			limit: 1,
		})
	).data[0];
	if (
		!linked ||
		linked.executorType !== "tedi" ||
		linked.executorId !== tedi.id ||
		linked.runId !== proof.runId ||
		!linked.admissionId
	)
		return forbidden(
			"The native coordinator Attempt no longer owns this request",
		);
	const coordinator = await getAuthoritativeWorkItemAttempt(context.db, {
		orgId: organizationId,
		workItemId: proof.linkedWorkItemId,
		attemptId: linked!.id,
		executor: { type: "tedi", id: tedi.id },
	});
	const item = await assertWorkItemAccess(context, input.id);
	if (
		item.stewardType !== "tedi" ||
		item.stewardId !== tedi.id ||
		item.workKind !== "coding"
	)
		return forbidden(
			"Only this tedi's own coding Work stewardship permits closeout",
		);
	const commentId = `${proof.homeRunId}:steward-closeout:${item.id}:v${proof.expectedWorkItemVersion}`;
	if (item.disposition === "completed") {
		const comment = await getWorkItemCommentById(context.db, commentId);
		const receipt = record(comment?.metadata);
		if (
			item.version !== proof.expectedWorkItemVersion + 1 ||
			item.metadata?.completionCommentId !== commentId ||
			comment?.orgId !== organizationId ||
			comment.workItemId !== item.id ||
			comment.authorType !== "tedi" ||
			comment.authorId !== tedi.id ||
			receipt.source !== "native-steward-closeout.v1" ||
			receipt.homeRunId !== proof.homeRunId ||
			receipt.childRunId !== proof.runId ||
			receipt.linkedWorkItemId !== proof.linkedWorkItemId ||
			receipt.targetWorkItemVersion !== proof.expectedWorkItemVersion
		)
			return forbidden(
				"Completed Work does not match this exact closeout receipt",
			);
		return {
			tedi,
			capabilityPlanJson: JSON.stringify(order.capabilityPlan),
			item,
			proof,
			target: target!,
			owner: owner!,
			coordinator,
			commentId,
			completed: true as const,
		};
	}
	if (
		item.disposition !== "accepted" ||
		item.version !== proof.expectedWorkItemVersion
	)
		return forbidden("The accepted target Work version changed");
	return {
		tedi,
		capabilityPlanJson: JSON.stringify(order.capabilityPlan),
		item,
		proof,
		target: target!,
		owner: owner!,
		coordinator,
		commentId,
		completed: false as const,
	};
}

export async function prepareNativeStewardCloseout(
	context: BaseContext,
	input: { id: string; nativeStewardCloseout: NativeStewardCloseoutProof },
) {
	const scope = await assertNativeStewardCloseout(context, input);
	if (scope.completed) return { ...scope, fence: null, closingComment: null };
	const latest = (
		await listWorkItemAttempts(context.db, {
			orgId: scope.item.orgId,
			workItemId: scope.item.id,
			limit: 1,
		})
	).data[0];
	const sourceCommit =
		record(latest?.metadata?.settlement).commitSha ??
		latest?.metadata?.sourceCommit;
	if (
		!latest ||
		latest.runtimeState !== "finished" ||
		latest.outcome !== "succeeded" ||
		!latest.finishedAt ||
		typeof sourceCommit !== "string" ||
		!/^[a-f\d]{40}$/.test(sourceCommit)
	)
		return forbidden(
			"Steward closeout requires the latest settled successful Attempt with an exact typed source commit",
		);
	if (!Number.isFinite(Date.parse(scope.item.createdAt)))
		return forbidden("The source Work creation timestamp is unavailable");
	const { mcpGovernanceContractRouter } = await import("../mcp-governance");
	const assertCurrentTransport = async () => {
		const transport = await createRouterClient(mcpGovernanceContractRouter, {
			context,
		}).resolveAgentTransportPolicy({
			organizationId: scope.item.orgId,
			tediId: context.tediId!,
		});
		// Only disposition and its receipt change; the target's implementation risk remains unchanged.
		const autonomy = decideAutonomousAction({
			policy: transport.autonomy,
			risk: "medium",
			content:
				"Complete the explicitly requested Work record after source and delivery verification",
			classId: "native:complete_steward_work",
		});
		if (
			transport.requireExplicitApprovalPolicy ||
			transport.platformAutonomy === false ||
			closeoutRequiresHuman(transport.autonomy?.askForClasses) ||
			!autonomy.autoApprove
		)
			return forbidden(
				"Current policy does not authorize autonomous steward completion",
			);
	};
	await assertCurrentTransport();
	const pack = await getActiveOrganizationPolicyPack(
		context.db,
		scope.item.orgId,
	);
	const policy = KernelRequestPolicySchema.safeParse(
		pack?.definition.kernelRequestCoordinator,
	);
	const configured = policy.success
		? policy.data.repositoryTargets.find(
				(row) => row.id === scope.target.repositoryTargetId,
			)
		: null;
	if (
		!policy.success ||
		!configured ||
		!pack ||
		!policy.data.enabled ||
		policy.data.workAttemptDelivery?.observerProjectId !== scope.item.projectId
	)
		return forbidden(
			"A matching registered repository delivery target is unavailable",
		);
	const response = await guardedFetch(
		configured.liveManifestUrl,
		{ signal: AbortSignal.timeout(policy.data.probeTimeoutMs) },
		{ allowTedixHosts: true, maxRedirects: 0 },
	);
	if (!response.ok) forbidden("The configured live manifest is unavailable");
	const manifest = record(await response.json());
	if (
		manifest.repository !== configured.repository ||
		manifest.surface !== configured.surface ||
		typeof manifest.commitSha !== "string" ||
		!/^[a-f\d]{40}$/.test(manifest.commitSha)
	)
		return forbidden("The configured live manifest identity is invalid");
	const liveCommitSha = manifest.commitSha as string;
	const delivered = await readConfiguredRepositoryDelivery(
		context,
		scope.item.orgId,
		policy.data,
		{
			kind: "repository_delivery",
			targetId: configured.id,
			surface: configured.surface,
			commitSha: liveCommitSha,
			sourceCommit: sourceCommit as string,
		},
	);
	if (
		delivered.liveSha !== liveCommitSha ||
		delivered.shipSha !== liveCommitSha ||
		delivered.shipStatus !== "success" ||
		delivered.surface !== configured.surface
	)
		return forbidden("Managed delivery changed or remains unverified");
	if (
		delivered.sourceAncestry?.sourceCommit !== sourceCommit ||
		delivered.sourceAncestry.liveCommitSha !== liveCommitSha ||
		delivered.sourceAncestry.mainCommitSha !== delivered.mainSha
	)
		return forbidden(
			"Source ancestry through the live surface to current main is unverified",
		);
	const observations = await findRepositoryPushObservations(context.db, {
		orgId: scope.item.orgId,
		projectId: scope.item.projectId!,
		shas: [sourceCommit as string],
		since: new Date(
			Date.parse(scope.item.createdAt) - 24 * 3600_000,
		).toISOString(),
	});
	const observed = observations.find(
		(row) =>
			row.sha === sourceCommit ||
			row.commitShas.includes(sourceCommit as string),
	);
	if (!observed)
		return forbidden("A registered source push observation is unavailable");
	const evidenceRefs = [
		...delivered.evidenceRefs,
		`repository-observation:${observed.id}`,
	];
	const fresh = await assertNativeStewardCloseout(context, input);
	if (fresh.completed) return { ...fresh, fence: null, closingComment: null };
	const autonomyLessonClasses = [
		...new Set(
			await readDelegationAutonomyLessons(context.db, scope.item.orgId),
		),
	].sort();
	const tediPolicyPackId = fresh.tedi.policyPackId ?? null;
	const tediPolicyPack = tediPolicyPackId
		? await getPolicyPackById(context.db, tediPolicyPackId)
		: null;
	if (
		tediPolicyPackId &&
		(!tediPolicyPack ||
			tediPolicyPack.status !== "active" ||
			(tediPolicyPack.organizationId !== null &&
				tediPolicyPack.organizationId !== scope.item.orgId))
	)
		return forbidden("The steward's linked policy is unavailable or revoked");
	await assertCurrentTransport();
	const fence: NativeStewardCloseoutFence = {
		homeRunId: scope.proof.homeRunId,
		runId: scope.proof.runId,
		linkedWorkItemId: scope.proof.linkedWorkItemId,
		coordinatorAttemptId: fresh.coordinator.id,
		coordinatorAdmissionId: fresh.coordinator.admissionId!,
		ownerUserId: scope.owner.descopeUserId,
		tediId: context.tediId!,
		targetWorkItemVersion: scope.proof.expectedWorkItemVersion,
		sourceAttemptId: latest!.id,
		sourceAttemptMetadata: latest!.metadata ?? {},
		sourceCommit: sourceCommit as string,
		repositoryTargetId: scope.target.repositoryTargetId,
		policyPackId: pack.id,
		policyDefinition: JSON.stringify(pack.definition),
		capabilityPlanJson: fresh.capabilityPlanJson,
		tediPolicyPackId,
		tediPolicyDefinition: tediPolicyPack
			? JSON.stringify(tediPolicyPack.definition)
			: null,
		autonomyLessonClasses,
	};
	return {
		...fresh,
		fence,
		closingComment: {
			id: scope.commentId,
			body: `Completed after native steward verification: ${sourceCommit}; ${configured.surface} is live on ${liveCommitSha}.`,
			metadata: {
				source: "native-steward-closeout.v1",
				homeRunId: scope.proof.homeRunId,
				childRunId: scope.proof.runId,
				linkedWorkItemId: scope.proof.linkedWorkItemId,
				targetWorkItemVersion: scope.proof.expectedWorkItemVersion,
				sourceAttemptId: latest!.id,
				sourceCommit: sourceCommit as string,
				repositoryTargetId: configured.id,
				liveCommitSha,
				evidenceRefs,
			},
		},
	};
}
