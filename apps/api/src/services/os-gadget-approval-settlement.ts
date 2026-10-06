import { ExecutionCapabilitySchema } from "@tedix/api-contract/schemas/execution-evidence";
import { parseModelRef } from "@tedix/api-contract/schemas/model-catalog";
import {
	type OsGadgetContextEnvelope,
	type OsGadgetManifest,
	OsGadgetManifestSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { SkillRunStatus } from "@tedix/api-contract/schemas/cognitive";
import { parseCapabilityManifest } from "@tedix/api-contract/utils/skill-manifest";
import type { DbClient } from "@tedix/db/client";
import { getSkillEntryBySlug } from "@tedix/db/queries/cognitive/skill-crud";
import { getRuntimeProfileById } from "@tedix/db/queries/control-plane/definitions";
import {
	claimApprovedOsGadgetExecution,
	failClaimedOsGadgetExecution,
	getOsGadgetExecution,
	recordOsGadgetDispatch,
	settleAwaitingApprovalOsGadgetExecution,
} from "@tedix/db/queries/os-workspaces/executions";
import {
	getOsGadget,
	getOsGadgetRevision,
} from "@tedix/db/queries/os-workspaces/gadgets";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediById } from "@tedix/db/queries/tedis";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import type { SkillEntry } from "@tedix/db/schema/cognitive";
import type { ModelPolicy } from "@tedix/db/schema/control-plane";
import type { OsGadgetExecutionRow } from "@tedix/db/schema/os-workspaces";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { authorizeRuntimeBudget } from "./runtime-budget-admission";
import { callSkillRuntime } from "./skill-runtime-client";
import {
	type ExecutionPreflightSubject,
	resolveWorkItemExecutionPreflight,
} from "./work-item-execution-preflight";

const GADGET_APPROVAL_ACTION = "os_gadget_execution";
const SKILL_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface GadgetApprovalSettlementContext {
	db: DbClient;
	env: CloudflareEnv;
	authType?: string;
	user?: { sub?: string };
	gatewayEndUserId?: string;
	externalAgentPrincipalId?: string;
	tediId?: string;
}

interface GadgetSkillExecutable {
	skill: SkillEntry;
	slug: string;
	workflowSource: string;
	skillDoc: string;
}

interface SkillRuntimeRunResponse {
	runId: string;
	workflowInstanceId: string;
	status?: SkillRunStatus;
	executionEpoch?: number;
}

export interface GadgetApprovalSettlementResult {
	handled: boolean;
	execution: OsGadgetExecutionRow | null;
	dispatched: boolean;
}

function gadgetSkillSlug(manifest: OsGadgetManifest): string | null {
	if (manifest.skillSlug) return manifest.skillSlug;
	if (manifest.entry.length <= 200 && SKILL_SLUG_SHAPE.test(manifest.entry)) {
		return manifest.entry;
	}
	return null;
}

export async function resolveGadgetExecutable(
	context: GadgetApprovalSettlementContext,
	organizationId: string,
	manifest: OsGadgetManifest,
): Promise<GadgetSkillExecutable | string> {
	const slug = gadgetSkillSlug(manifest);
	if (!slug) {
		return "gadget_not_executable: the manifest declares no skillSlug and entry is not a skill slug";
	}
	const skill = await getSkillEntryBySlug(context.db, organizationId, slug);
	if (!skill) return `gadget_not_executable: no skill exists for slug ${slug}`;
	const files = (skill.files ?? null) as Record<string, string> | null;
	const workflowSource = files?.["scripts/workflow.ts"];
	if (!workflowSource) {
		return `gadget_not_executable: skill ${slug} has no files['scripts/workflow.ts']`;
	}
	return {
		skill,
		slug,
		workflowSource,
		skillDoc: files?.["SKILL.md"] ?? (skill.content as string | null) ?? "",
	};
}

function gadgetRunParams(
	input: JsonValue | null | undefined,
): Record<string, unknown> {
	if (input === null || input === undefined) return {};
	if (typeof input === "object" && !Array.isArray(input)) {
		return input as Record<string, unknown>;
	}
	return { input };
}

function dispatchActor(
	context: GadgetApprovalSettlementContext,
	approval?: TediApprovalRequest,
): string {
	if (approval?.resolvedBy) return `user:${approval.resolvedBy}`;
	if (context.authType === "user" && context.user?.sub) {
		return `user:${context.user.sub}`;
	}
	if (context.gatewayEndUserId) return `user:${context.gatewayEndUserId}`;
	if (context.externalAgentPrincipalId) {
		return `agent:${context.externalAgentPrincipalId}`;
	}
	if (context.tediId) return `tedi:${context.tediId}`;
	return context.authType ?? "approval-workflow";
}

async function dispatchGadgetSkillRun(
	context: GadgetApprovalSettlementContext,
	params: {
		executionId: string;
		orgId: string;
		tediId: string;
		workItemId: string | null;
		executable: GadgetSkillExecutable;
		input: JsonValue | null | undefined;
		idempotencyKey: string;
		createdBy: string;
		contextEnvelope: OsGadgetContextEnvelope;
	},
): Promise<SkillRuntimeRunResponse> {
	const { skill, workflowSource, skillDoc } = params.executable;
	return callSkillRuntime<SkillRuntimeRunResponse>(context, "/run", {
		runId: params.executionId,
		createdBy: params.createdBy,
		workItemId: params.workItemId ?? undefined,
		idempotencyKey: params.idempotencyKey,
		skillId: skill.id,
		skillSlug: skill.slug,
		skillRevision: skill.revision ?? null,
		orgId: params.orgId,
		tediId: params.tediId,
		params: {
			...gadgetRunParams(params.input),
			_tedixContext: params.contextEnvelope,
		},
		workflowSource,
		skillDoc,
		capabilityManifest: parseCapabilityManifest(skillDoc),
	});
}

export async function authorizeGadgetInference(
	context: GadgetApprovalSettlementContext,
	params: {
		orgId: string;
		tediId: string;
		runtimeProfileId: string | null;
		executionId: string;
		idempotencyKey?: string;
	},
): Promise<
	| { allowed: true; reservationId: string | null }
	| { allowed: false; code: string }
> {
	const profile = params.runtimeProfileId
		? await getRuntimeProfileById(context.db, params.runtimeProfileId)
		: null;
	const modelPolicy = profile?.config?.modelPolicy as ModelPolicy | undefined;
	const ref =
		typeof modelPolicy?.chatModelRef === "string"
			? parseModelRef(modelPolicy.chatModelRef)
			: null;
	const decision = await authorizeRuntimeBudget({
		db: context.db,
		env: context.env,
		request: {
			organizationId: params.orgId,
			tediId: params.tediId,
			settlementMode: resolveBillingSettlementMode(context.env),
			source: "gadget",
			provider: ref?.provider ?? "azure-openai",
			model: ref?.modelId ?? context.env.AZURE_CHAT_DEPLOYMENT,
			estimatedInputTokens: 1,
			estimatedOutputTokens: 4_096,
			runId: params.executionId,
			idempotencyKey:
				params.idempotencyKey ?? `gadget-inference:${crypto.randomUUID()}`,
			metadata: { source: "gadget", executionId: params.executionId },
		},
	});
	if (!decision.allowed) return { allowed: false, code: decision.code };
	return { allowed: true, reservationId: decision.reservationId };
}

export function gadgetPreflightSubject(params: {
	subjectId: string;
	orgId: string;
	tediId: string;
	requestedCapabilities: string[];
}): ExecutionPreflightSubject {
	const requiredCapabilities = [
		...new Set(params.requestedCapabilities),
	].filter(
		(capability) => ExecutionCapabilitySchema.safeParse(capability).success,
	);
	return {
		id: params.subjectId,
		orgId: params.orgId,
		metadata: {
			capabilityBundle: {
				version: 1,
				targetTediId: params.tediId,
				requiredCapabilities,
			},
		},
		accountableOwnerType: "tedi",
		accountableOwnerId: params.tediId,
	};
}

export async function dispatchGovernedGadgetExecution(
	context: GadgetApprovalSettlementContext,
	params: {
		executionId: string;
		orgId: string;
		tediId: string;
		workItemId: string | null;
		executable: GadgetSkillExecutable;
		input: JsonValue | null | undefined;
		idempotencyKey: string;
		approval?: TediApprovalRequest;
		contextEnvelope: OsGadgetContextEnvelope;
	},
): Promise<SkillRuntimeRunResponse> {
	return dispatchGadgetSkillRun(context, {
		...params,
		createdBy: dispatchActor(context, params.approval),
	});
}

export function dispatchedReceiptStatus(
	status: SkillRunStatus | undefined,
): SkillRunStatus {
	return status ?? "queued";
}

function approvalPayload(
	approval: TediApprovalRequest,
): { executionId: string } | null {
	if (approval.actionType !== GADGET_APPROVAL_ACTION) return null;
	const payload = approval.payload;
	const executionId = payload.executionId;
	return typeof executionId === "string" ? { executionId } : null;
}

async function terminalizeAwaiting(
	context: GadgetApprovalSettlementContext,
	execution: OsGadgetExecutionRow,
	params: {
		status: "denied" | "canceled";
		reason: string;
		decisions?: unknown[];
	},
): Promise<OsGadgetExecutionRow> {
	if (
		execution.status === "queued" &&
		execution.runId === execution.id &&
		execution.workflowInstanceId === null
	) {
		return (
			(await failClaimedOsGadgetExecution(createDbQueryClient(context.env.DB), {
				organizationId: execution.organizationId,
				executionId: execution.id,
				runId: execution.id,
				error: params.reason,
			})) ?? execution
		);
	}
	const settled = await settleAwaitingApprovalOsGadgetExecution(
		createDbQueryClient(context.env.DB),
		{
			organizationId: execution.organizationId,
			executionId: execution.id,
			status: params.status,
			error: params.reason,
			policyDecision: JSON.stringify({
				allowed: false,
				reasons: [params.reason],
				...(params.decisions ? { decisions: params.decisions } : {}),
			}),
		},
	);
	return settled ?? execution;
}

/**
 * Settle a resolved Gadget approval onto its exact parked receipt. The D1
 * receipt is claimed before the external runtime call; retries use the same
 * run id, billing idempotency key, and runtime idempotency key.
 */
export async function settleOsGadgetApproval(
	context: GadgetApprovalSettlementContext,
	approval: TediApprovalRequest,
): Promise<GadgetApprovalSettlementResult> {
	const payload = approvalPayload(approval);
	if (!payload) {
		return { handled: false, execution: null, dispatched: false };
	}
	const db = createDbQueryClient(context.env.DB);
	let execution = await getOsGadgetExecution(db, {
		organizationId: approval.orgId,
		executionId: payload.executionId,
	});
	if (!execution || execution.approvalRequestId !== approval.id) {
		throw new Error(
			`Gadget approval ${approval.id} is not linked to execution ${payload.executionId}`,
		);
	}
	if (approval.status === "pending") {
		return { handled: true, execution, dispatched: false };
	}
	if (approval.status !== "approved") {
		const status = approval.status === "rejected" ? "denied" : "canceled";
		const reason = `approval_${approval.status}: ${approval.resolution ?? "no reviewer note"}`;
		execution = await terminalizeAwaiting(context, execution, {
			status,
			reason,
		});
		return { handled: true, execution, dispatched: false };
	}

	if (
		execution.status !== "awaiting_approval" &&
		!(
			execution.status === "queued" &&
			execution.runId === execution.id &&
			execution.workflowInstanceId === null
		)
	) {
		return { handled: true, execution, dispatched: false };
	}
	if (!execution.tediId) {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: "approved receipt has no executing tedi",
		});
		return { handled: true, execution, dispatched: false };
	}
	const tediId = execution.tediId;

	const revision = execution.revisionId
		? await getOsGadgetRevision(db, {
				organizationId: execution.organizationId,
				revisionId: execution.revisionId,
			})
		: undefined;
	if (!revision) {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: "approved receipt's pinned revision is no longer readable",
		});
		return { handled: true, execution, dispatched: false };
	}
	const manifest = OsGadgetManifestSchema.parse(JSON.parse(revision.manifest));
	const executable = await resolveGadgetExecutable(
		context,
		execution.organizationId,
		manifest,
	);
	if (typeof executable === "string") {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: executable,
		});
		return { handled: true, execution, dispatched: false };
	}
	const [workspace, gadget, resources] = await Promise.all([
		getOsWorkspace(db, {
			organizationId: execution.organizationId,
			workspaceId: execution.workspaceId,
		}),
		getOsGadget(db, {
			organizationId: execution.organizationId,
			gadgetId: execution.gadgetId,
		}),
		listOsWorkspaceResources(db, {
			organizationId: execution.organizationId,
			workspaceId: execution.workspaceId,
			status: "active",
			limit: 200,
		}),
	]);
	if (!workspace || !gadget) {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: "approved receipt's workspace or gadget is no longer readable",
		});
		return { handled: true, execution, dispatched: false };
	}
	const bySlot = new Map(
		resources
			.filter((resource) => resource.slot)
			.map((resource) => [resource.slot, resource]),
	);
	const grantedResources: Array<{
		workspaceResourceId: string;
		workspaceId: string;
		slot: string;
		providerId: string;
		connectionScope: "tenant";
		requiredScopes: string[];
		resourceType: string;
		providerResourceId: string;
		name: string;
		operations: string[];
	}> = [];
	for (const grant of manifest.resourceGrants ?? []) {
		const resource = bySlot.get(grant.slot);
		if (!resource || resource.connectionScope === "user") {
			execution = await terminalizeAwaiting(context, execution, {
				status: "denied",
				reason: !resource
					? `resource slot ${grant.slot} has no active selection`
					: `resource slot ${grant.slot} uses a personal connection; background tedis never inherit personal grants`,
			});
			return { handled: true, execution, dispatched: false };
		}
		grantedResources.push({
			workspaceResourceId: resource.id,
			workspaceId: resource.workspaceId,
			slot: grant.slot,
			providerId: resource.providerId,
			connectionScope: "tenant",
			requiredScopes: JSON.parse(resource.requiredScopes) as string[],
			resourceType: resource.resourceType,
			providerResourceId: resource.providerResourceId,
			name: resource.name,
			operations: grant.operations,
		});
	}

	const requested = JSON.parse(execution.grantedCapabilities) as string[];
	const preflight = await resolveWorkItemExecutionPreflight({
		db: context.db,
		env: context.env,
		workItem: gadgetPreflightSubject({
			subjectId: execution.workItemId ?? execution.id,
			orgId: execution.organizationId,
			tediId,
			requestedCapabilities: requested,
		}),
	});
	if (preflight.status === "blocked" || preflight.status === "not_configured") {
		const reason =
			preflight.blockingReasons[0] ??
			"policy recheck blocked the approved dispatch";
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason,
			decisions: preflight.decisions,
		});
		return { handled: true, execution, dispatched: false };
	}

	const tedi = await getTediById(context.db, tediId);
	if (!tedi || tedi.organizationId !== execution.organizationId) {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: "the approved tedi no longer exists in this organization",
		});
		return { handled: true, execution, dispatched: false };
	}
	const budget = await authorizeGadgetInference(context, {
		orgId: execution.organizationId,
		tediId,
		runtimeProfileId:
			preflight.runtimeProfile?.id ?? tedi.runtimeProfileId ?? null,
		executionId: execution.id,
		idempotencyKey: `gadget-inference:${execution.id}:approval:${approval.id}`,
	});
	if (!budget.allowed) {
		execution = await terminalizeAwaiting(context, execution, {
			status: "denied",
			reason: `billing_denied: ${budget.code}`,
			decisions: preflight.decisions,
		});
		return { handled: true, execution, dispatched: false };
	}

	if (execution.status === "awaiting_approval") {
		const claimed = await claimApprovedOsGadgetExecution(db, {
			organizationId: execution.organizationId,
			executionId: execution.id,
			runId: execution.id,
			billingReservationId: budget.reservationId,
			policyDecision: JSON.stringify({
				allowed: true,
				reasons: [],
				decisions: preflight.decisions,
			}),
			resourceAccessEnvelope: JSON.stringify({
				version: 1,
				sources: grantedResources.map(
					({ slot: _slot, name: _name, ...source }) => source,
				),
			}),
		});
		if (!claimed) {
			execution =
				(await getOsGadgetExecution(db, {
					organizationId: approval.orgId,
					executionId: payload.executionId,
				})) ?? execution;
			if (
				execution.workflowInstanceId !== null ||
				execution.runId !== execution.id
			) {
				return { handled: true, execution, dispatched: false };
			}
		} else {
			execution = claimed;
		}
	}

	const dispatched = await dispatchGadgetSkillRun(context, {
		executionId: execution.id,
		orgId: execution.organizationId,
		tediId,
		workItemId: execution.workItemId,
		executable,
		input:
			execution.input === null
				? null
				: (JSON.parse(execution.input) as JsonValue),
		idempotencyKey: `gadget-approval:${approval.id}:${execution.id}`,
		createdBy: dispatchActor(context, approval),
		contextEnvelope: {
			version: 1,
			organizationId: execution.organizationId,
			workspace: { id: workspace.id, name: workspace.name },
			gadget: {
				id: gadget.id,
				name: gadget.name,
				revisionId: revision.id,
				revision: revision.revision,
			},
			resources: grantedResources.map(
				({
					workspaceResourceId: _id,
					workspaceId: _workspaceId,
					connectionScope: _scope,
					requiredScopes: _scopes,
					...resource
				}) => resource,
			),
		},
	});
	const recorded = await recordOsGadgetDispatch(db, {
		organizationId: execution.organizationId,
		executionId: execution.id,
		runId: dispatched.runId,
		status: dispatchedReceiptStatus(dispatched.status),
		workflowInstanceId: dispatched.workflowInstanceId,
		executionEpoch: dispatched.executionEpoch ?? 0,
	});
	return {
		handled: true,
		execution: recorded ?? execution,
		dispatched: recorded !== undefined,
	};
}

/** Terminalize a claimed receipt only after Workflow-level dispatch retries exhaust. */
export async function failOsGadgetApprovalDispatch(
	context: GadgetApprovalSettlementContext,
	approval: TediApprovalRequest,
	error: unknown,
): Promise<OsGadgetExecutionRow | null> {
	const payload = approvalPayload(approval);
	if (!payload) return null;
	return (
		(await failClaimedOsGadgetExecution(createDbQueryClient(context.env.DB), {
			organizationId: approval.orgId,
			executionId: payload.executionId,
			runId: payload.executionId,
			error: error instanceof Error ? error.message : String(error),
		})) ?? null
	);
}
