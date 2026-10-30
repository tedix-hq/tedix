/**
 * MCP Governance Router
 *
 * Internal, service-binding-only surface for the MCP tool-approval grant
 * layer. See `packages/api-contract/src/contracts/mcp-governance.ts` for the
 * "why not a direct D1 query from apps/mcp" rationale.
 */

import { ProviderCredentialSummarySchema } from "@tedix/api-contract/schemas/provider-probe-receipt";
import { toJsonValue } from "@tedix/db/utils/json";
import * as z from "zod";
import {
	createApprovalRequestWithAudit,
	getApprovalRequestById,
	consumeHomeToolApprovalCall,
	consumeOwnerToolApproval,
	findPendingOwnerToolApproval,
	getApprovalAnchor,
} from "@tedix/db/queries/approvals";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	getRunSensitiveDataLatch,
	isConnectionProviderRestricted,
	latchRunSensitiveData,
} from "@tedix/db/queries/sensitive-data-latch";
import {
	approvingUserId,
	parseHomeToolWritePayload,
} from "./kernel/write-executor";
import { initiatingAgentMayStillAct } from "./kernel/write-approval-settlement";
import { canonicalDigest, canonicalJson } from "../../lib/blueprint-digest";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { createError, ErrorCodes } from "../orpc";
import { resolveAgentLifecycleAuthorization } from "@tedix/db/queries/mcp-agent-lifecycle";
import { implement } from "@orpc/server";
import { mcpGovernanceContract } from "@tedix/api-contract/contracts/mcp-governance";
import {
	type ProviderIdentityMount,
	ProviderIdentityMountSchema,
	ProviderIdentityProbeProfileSchema,
	ProviderIdentityProfileSchema,
} from "@tedix/api-contract/schemas/provider-identity-profile";
import {
	type ResolveTenantToolPolicyInput,
	type RequestMachineToolApprovalInput,
	type TenantToolPolicyRawMountDescriptor,
	TenantToolPolicySetSchema,
	TenantToolPolicyEffectSchema,
	TenantToolPolicyBoundDescriptorSchema,
	TenantToolPolicyMountDescriptorSchema,
	TenantToolPolicyProfileDescriptorSchema,
	TenantToolPolicyMachineDescriptorSchema,
	TenantToolPolicyRawMountDescriptorSchema,
	TenantNativeRpcMountSchema,
	TenantNativeRpcPolicyDescriptorSchema,
	TenantToolPolicySchema,
	ResolveTenantToolPolicyResponseSchema,
} from "@tedix/api-contract/schemas/tenant-tool-policy";
import {
	createTenantPolicyEvaluationBudget,
	evaluateTenantPolicyPredicate,
} from "@tedix/api-contract/utils/tenant-policy-predicate";
import {
	consumeTenantToolPolicyPreparation,
	consumeProviderIdentityPreparation,
	createProviderIdentityPreparation,
	createProviderIdentityProfile,
	replaceTenantToolPolicy,
	createTenantToolPolicyPreparation,
	findTenantToolPolicyRevisions,
	findTenantToolPolicySubjectFences,
	tenantPolicySubjectKey,
	findTenantToolPolicyCandidatesBySource,
	hasTenantToolPolicyFenceForSource,
	getTenantToolPolicyResourceGenerations,
	getProviderIdentityProfile,
	listProviderIdentityProfiles,
	listTenantToolPolicies,
	listDeletedTenantPolicyFences,
	revokeTenantToolPolicy,
	revokeProviderIdentityProfile,
} from "@tedix/db/queries/tenant-tool-policy";
import {
	createProviderProbeReceipt,
	consumeProviderProbeReceipt,
	createProviderProbeResult,
	consumeProviderProbeResult,
	createMachineProviderProbeResult,
	listMachineProviderProbeResults,
	consumeMachineProviderProbeResult,
	createMachineProviderProbeAuthorization,
	consumeMachineProviderProbeAuthorization,
} from "@tedix/db/queries/provider-probe-receipts";
import {
	resolveAuthorizedExternalAgentMcpSession,
	listMachinePolicyInventoryCandidates,
} from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import { getAppByIdForOrganization } from "@tedix/db/queries/app-records";
import {
	getToolByIdForOrganization,
	listDeclaredActionToolsForOrganization,
} from "@tedix/db/queries/tools";
import {
	isPlatformCriticalActionType,
	parseKernelGovernancePolicy,
} from "@tedix/api-contract/utils/approval-policy";
import {
	isMethodAllowed,
	readPinnedCapabilityManifest,
} from "@tedix/api-contract/utils/skill-manifest";
import { getSkillRun } from "@tedix/db/queries/skill-runs";
import {
	getSkillEntry,
	getSkillEntryBySlug,
} from "@tedix/db/queries/cognitive/skill-crud";
import {
	resolveSkillMcpNamespaceSlugs,
	skillMcpProxyIncludesSource,
} from "@tedix/db/queries/cognitive/skill-mcp-bindings";
import { getPolicyPackById } from "@tedix/db/queries/control-plane/definitions";
import { getActivePolicyPackDefinition } from "@tedix/db/queries/kernel-runtime-support";
import {
	findActionTypeOptIn,
	listActionTypeOptIns,
	resolveToolApprovalGrant,
	resolveWorkItemAuthorization,
	setActionTypeOptIn,
} from "@tedix/db/queries/mcp-governance";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { readDelegationAutonomyLessons } from "@tedix/db/queries/work-items/delegation-autonomy";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	resolveServiceBindingOrganizationId,
	withAuth,
	withServiceAuth,
} from "../orpc";

const mcpGovernanceOs = implement(
	mcpGovernanceContract,
).$context<BaseContext>();
const serviceOs = mcpGovernanceOs.use(withServiceAuth);
const authOs = mcpGovernanceOs.use(withAuth);
const RESERVED_SKILL_NAMESPACES = new Set(["tedi", "home", "kernel", "os"]);
const RUNNABLE_SKILL_STATES = new Set(["active", "proven", "crystallized"]);

/** withServiceAuth leaves the organization to the gateway's X-Tedix-Org-Id. */
async function assertGatewayOrganization(
	context: BaseContext,
	organizationId: string,
): Promise<void> {
	const gatewayOrganizationId =
		context.organizationId ??
		(await resolveServiceBindingOrganizationId(context));
	if (gatewayOrganizationId !== organizationId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Approval organization does not match the gateway context",
		);
}

async function isActiveOwnerOrAdmin(
	context: BaseContext,
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const member = await getMemberByUserId(context.db, organizationId, userId);
	return (
		member?.status === "active" && ["owner", "admin"].includes(member.role)
	);
}

async function profileMount(
	context: BaseContext,
	organizationId: string,
	rootAppId: string,
	mountedToolId: string,
): Promise<ProviderIdentityMount> {
	const response = await context.env.MCP_SERVICE.fetch(
		new Request(
			"https://mcp.internal/_internal/tenant-tool-policy/prepare-profile",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({ organizationId, rootAppId, mountedToolId }),
			},
		),
	);
	if (!response.ok)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Tool identity could not be reviewed",
		);
	const result = (await response.json()) as {
		descriptor?: unknown;
		descriptorDigest?: unknown;
	};
	const parsed = ProviderIdentityMountSchema.safeParse(result.descriptor);
	if (
		!parsed.success ||
		parsed.data.organizationId !== organizationId ||
		parsed.data.rootAppId !== rootAppId ||
		parsed.data.mountedToolId !== mountedToolId ||
		parsed.data.mountAppIds[0] !== rootAppId ||
		parsed.data.mountAppIds.at(-1) !== parsed.data.sourceAppId ||
		new Set(parsed.data.mountAppIds).size !== parsed.data.mountAppIds.length ||
		(await canonicalDigest(parsed.data)) !== result.descriptorDigest
	)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Tool identity could not be verified",
		);
	return parsed.data;
}

function sameProfileConnection(
	mount: ProviderIdentityMount,
	probe: ProviderIdentityMount,
) {
	return (
		mount.organizationId === probe.organizationId &&
		mount.rootAppId === probe.rootAppId &&
		mount.sourceAppId === probe.sourceAppId &&
		mount.endpointDigest === probe.endpointDigest &&
		mount.authBindingDigest === probe.authBindingDigest &&
		mount.upstreamOperation !== probe.upstreamOperation &&
		probe.acceptsEmptyArguments &&
		mount.providerId === probe.providerId &&
		mount.connectionScope === probe.connectionScope &&
		(mount.credentialPreference ?? null) ===
			(probe.credentialPreference ?? null) &&
		(mount.connectionInstanceId ?? null) ===
			(probe.connectionInstanceId ?? null)
	);
}

async function profileGenerations(
	context: BaseContext,
	mount: ProviderIdentityMount,
	probe: ProviderIdentityMount,
) {
	const vector = (value: ProviderIdentityMount) =>
		getTenantToolPolicyResourceGenerations(context.db, {
			organizationId: value.organizationId,
			appIds: value.mountAppIds,
			toolRowId: value.sourceToolRowId,
			connectionInstanceId: value.connectionInstanceId ?? "",
		});
	return canonicalDigest({
		mount: await vector(mount),
		probe: await vector(probe),
	});
}

async function currentProbeProfile(
	context: BaseContext,
	organizationId: string,
	id: string,
) {
	const row = await getProviderIdentityProfile(context.db, {
		organizationId,
		id,
	});
	if (!row || row.revokedAt) return null;
	const parsed = ProviderIdentityProfileSchema.safeParse(row);
	if (!parsed.success) return null;
	const {
		mount,
		probeMount,
		profile,
		safetyAttestation,
		resourceGenerationDigest,
	} = parsed.data;
	if (
		!sameProfileConnection(mount, probeMount) ||
		profile.operation !== probeMount.upstreamOperation ||
		(await profileGenerations(context, mount, probeMount)) !==
			resourceGenerationDigest ||
		(await canonicalDigest({
			organizationId,
			mount,
			probeMount,
			profile,
			safetyAttestation,
			resourceGenerationDigest,
		})) !== row.profileDigest
	)
		return null;
	return parsed.data;
}

/** Probe only with a current authenticated owner and an exact reviewed profile. */
export async function probeReviewedProviderIdentity(
	context: BaseContext,
	input: {
		organizationId: string;
		profileId: string;
		exampleArgs: ResolveTenantToolPolicyInput["args"];
	},
) {
	const actor = context.userId;
	if (
		context.authType !== "user" ||
		!actor ||
		context.organizationId !== input.organizationId ||
		context.user?.sub !== actor ||
		!Array.isArray(context.user.scopes) ||
		!context.user.scopes.includes("connections.execute") ||
		!(await isActiveOwnerOrAdmin(context, input.organizationId, actor))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An active owner or admin with a verified connections.execute grant is required",
		);
	const profile = await currentProbeProfile(
		context,
		input.organizationId,
		input.profileId,
	);
	if (
		!profile ||
		!(await isActiveOwnerOrAdmin(
			context,
			input.organizationId,
			profile.createdBy,
		))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The reviewed provider profile is unavailable",
		);
	const receiptId = crypto.randomUUID();
	await createProviderProbeReceipt(context.db, {
		id: receiptId,
		organizationId: input.organizationId,
		actorUserId: actor,
		profileId: profile.id,
		profileDigest: profile.profileDigest,
		argsDigest: await canonicalDigest(input.exampleArgs),
		expiresAt: new Date(Date.now() + 30_000).toISOString(),
	});
	const response = await context.env.MCP_SERVICE.fetch(
		new Request(
			"https://mcp.internal/_internal/tenant-tool-policy/probe-profile",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({
					organizationId: input.organizationId,
					receiptId,
					exampleArgs: input.exampleArgs,
				}),
			},
		),
	);
	if (!response.ok)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"The reviewed provider identity could not be verified",
		);
	const result = (await response.json()) as {
		accountRevisionDigest?: unknown;
		credentialSummary?: unknown;
	};
	if (
		typeof result.accountRevisionDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(result.accountRevisionDigest)
	)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"The reviewed provider identity could not be verified",
		);
	const current = await currentProbeProfile(
		context,
		input.organizationId,
		profile.id,
	);
	if (
		!current ||
		current.profileDigest !== profile.profileDigest ||
		!(await isActiveOwnerOrAdmin(context, input.organizationId, actor)) ||
		!(await isActiveOwnerOrAdmin(
			context,
			input.organizationId,
			current.createdBy,
		))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Provider profile or owner changed during verification",
		);
	const summary = ProviderCredentialSummarySchema.safeParse(
		result.credentialSummary,
	);
	return {
		profile: current,
		accountRevisionDigest: result.accountRevisionDigest,
		...(summary.success ? { credentialSummary: summary.data } : {}),
	};
}

/** Resolve only a digest of the selected account; never return its token. */
async function ownerReviewedAccountDigest(
	context: BaseContext,
	descriptor: TenantToolPolicyRawMountDescriptor,
	args: ResolveTenantToolPolicyInput["args"],
) {
	if (
		context.authType !== "user" ||
		!context.userId ||
		context.user?.sub !== context.userId ||
		!Array.isArray(context.user.scopes) ||
		!context.user.scopes.includes("connections.execute")
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A verified connections.execute grant is required to review this account",
		);
	if (
		descriptor.mountAppIds[0] !== descriptor.rootAppId ||
		descriptor.mountAppIds.at(-1) !== descriptor.sourceAppId ||
		new Set(descriptor.mountAppIds).size !== descriptor.mountAppIds.length
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The tool mount path could not be verified",
		);
	const org = await getOrganizationById(context.db, descriptor.organizationId);
	if (!org?.descopeTenantId)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Organization connection is unavailable",
		);
	const headers = new Headers(context.headers);
	headers.set("X-Tedix-Mcp-Tool-Id", descriptor.sourceToolId);
	const { resolveCredentialChain } =
		await import("./connections/policy-resolution");
	const result = await resolveCredentialChain(
		{ ...context, headers },
		{
			organizationId: descriptor.organizationId,
			descopeTenantId: org.descopeTenantId,
			providerId: descriptor.providerId,
			scopes: descriptor.requestedScopes,
			scope: "tenant",
			connectionInstanceId: descriptor.connectionInstanceId,
			callerUserId: context.userId,
			delegatedToolUse: { appId: descriptor.sourceAppId, arguments: args },
		},
	);
	const selected = result.selectedCredential;
	if (
		selected.scope !== "tenant" ||
		selected.organizationId !== descriptor.organizationId ||
		selected.providerId !== descriptor.providerId ||
		selected.connectionInstanceId !== descriptor.connectionInstanceId ||
		!selected.accountRevisionDigest
	)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"The selected account could not be verified",
		);
	return selected.accountRevisionDigest;
}

async function nativeRpcMount(
	context: BaseContext,
	organizationId: string,
	rootAppId: string,
	mountedToolId: string,
) {
	const response = await context.env.MCP_SERVICE.fetch(
		new Request(
			"https://mcp.internal/_internal/tenant-tool-policy/prepare-native",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({ organizationId, rootAppId, mountedToolId }),
			},
		),
	);
	if (!response.ok)
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Native tool could not be reviewed",
		);
	const result = (await response.json()) as {
		descriptor?: unknown;
		descriptorDigest?: unknown;
	};
	const parsed = TenantNativeRpcMountSchema.safeParse(result.descriptor);
	if (
		!parsed.success ||
		parsed.data.organizationId !== organizationId ||
		parsed.data.rootAppId !== rootAppId ||
		parsed.data.mountedToolId !== mountedToolId ||
		parsed.data.mountAppIds[0] !== rootAppId ||
		parsed.data.mountAppIds.at(-1) !== parsed.data.sourceAppId ||
		(await canonicalDigest(parsed.data)) !== result.descriptorDigest
	)
		throw createError(ErrorCodes.FORBIDDEN, "Native tool identity is invalid");
	return parsed.data;
}
async function resourceGenerationDigest(
	context: BaseContext,
	descriptor:
		| TenantToolPolicyRawMountDescriptor
		| ProviderIdentityMount
		| import("@tedix/api-contract/schemas/tenant-tool-policy").TenantNativeRpcMount,
) {
	return canonicalDigest(
		await getTenantToolPolicyResourceGenerations(context.db, {
			organizationId: descriptor.organizationId,
			appIds: descriptor.mountAppIds,
			toolRowId: descriptor.sourceToolRowId,
			connectionInstanceId:
				"connectionInstanceId" in descriptor
					? (descriptor.connectionInstanceId ?? "")
					: "",
		}),
	);
}

function restrictivePolicyEffect(
	effects: Array<z.infer<typeof TenantToolPolicyEffectSchema>>,
) {
	if (!effects.length) return null;
	const disposition = effects.some((effect) => effect.disposition === "deny")
		? "deny"
		: effects.some((effect) => effect.disposition === "ask")
			? "ask"
			: "allow";
	const riskOrder = [
		"read",
		"bounded_write",
		"high_impact_write",
		"external_side_effect",
	] as const;
	const radiusOrder = [
		"none",
		"single_resource",
		"tenant",
		"multi_tenant",
		"external_system",
	] as const;
	const riskTier =
		riskOrder[
			Math.max(...effects.map((effect) => riskOrder.indexOf(effect.riskTier)))
		];
	const blastRadius =
		radiusOrder[
			Math.max(
				...effects.map((effect) => radiusOrder.indexOf(effect.blastRadius)),
			)
		];
	const merged = TenantToolPolicyEffectSchema.safeParse({
		disposition,
		riskTier,
		blastRadius,
	});
	return merged.success ? merged.data : null;
}

/** Resolve the latest owner-reviewed mount revision; callers recheck before execution. */
async function resolveSingleTenantToolPolicyForGateway(
	context: BaseContext,
	input: ResolveTenantToolPolicyInput,
): Promise<z.infer<typeof ResolveTenantToolPolicyResponseSchema>> {
	await assertGatewayOrganization(context, input.organizationId);
	const none = { matched: false, revisionId: null, ruleDigest: null };
	const descriptor = input.descriptor;
	const isProfile = "kind" in descriptor;
	const mount = isProfile ? descriptor.mount : descriptor;
	if (
		mount.organizationId !== input.organizationId ||
		(await canonicalDigest(descriptor)) !== input.descriptorDigest
	)
		return none;
	if (isProfile && descriptor.kind !== "native_rpc") {
		const profile = await currentProbeProfile(
			context,
			input.organizationId,
			descriptor.profileId,
		);
		if (
			!profile ||
			profile.profileDigest !== descriptor.profileDigest ||
			(await canonicalDigest(profile.mount)) !==
				(await canonicalDigest(mount)) ||
			!(await isActiveOwnerOrAdmin(
				context,
				input.organizationId,
				profile.createdBy,
			))
		)
			return none;
		if (descriptor.kind === "profile") {
			if (
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					descriptor.actorUserId,
				))
			)
				return none;
		} else {
			const subject = descriptor.subject;
			const sessionId = context.externalAgentSessionId,
				clientRecordId = context.externalAgentClientRecordId;
			if (
				context.authType !== "service-binding" ||
				context.externalAgentPrincipalId !== subject.principalId ||
				!sessionId ||
				!clientRecordId ||
				(subject.scope === "session" &&
					(sessionId !== subject.sessionId ||
						clientRecordId !== subject.clientRecordId)) ||
				!context.tediScopes?.includes("connections.execute") ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					descriptor.ownerUserId,
				))
			)
				return none;
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId: input.organizationId,
					principalId: subject.principalId,
					sessionId,
					clientRecordId,
					now: new Date().toISOString(),
				},
			);
			if (!active || active.credential.mcpServerId !== subject.mcpServerId)
				return none;
		}
	}
	if (isProfile && descriptor.kind === "native_rpc") {
		const subject = descriptor.subject;
		const sessionId = context.externalAgentSessionId,
			clientRecordId = context.externalAgentClientRecordId;
		if (
			context.authType !== "service-binding" ||
			context.externalAgentPrincipalId !== subject.principalId ||
			!sessionId ||
			!clientRecordId ||
			(subject.scope === "session" &&
				(sessionId !== subject.sessionId ||
					clientRecordId !== subject.clientRecordId)) ||
			!(await isActiveOwnerOrAdmin(
				context,
				input.organizationId,
				descriptor.ownerUserId,
			))
		)
			return none;
		const active = await resolveAuthorizedExternalAgentMcpSession(context.db, {
			organizationId: input.organizationId,
			principalId: subject.principalId,
			sessionId,
			clientRecordId,
			now: new Date().toISOString(),
		});
		if (!active || active.credential.mcpServerId !== subject.mcpServerId)
			return none;
	}
	const tool = await getToolByIdForOrganization(context.db, {
		organizationId: input.organizationId,
		toolId: mount.sourceToolRowId,
	});
	if (!tool || !tool.enabled || tool.appId !== mount.sourceAppId) return none;
	const toolDigest = await canonicalDigest(tool);
	const subjectKey = tenantPolicySubjectKey(descriptor);
	if (!subjectKey) return none;
	const revisions = await findTenantToolPolicyRevisions(context.db, {
		organizationId: input.organizationId,
		rootAppId: mount.rootAppId,
		mountedToolId: mount.mountedToolId,
		subjectKey,
	});
	const row = revisions[0];
	if (!row) return none;
	const generations = await resourceGenerationDigest(context, mount);
	const saved = TenantToolPolicyBoundDescriptorSchema.safeParse(
		row.mountDescriptor,
	);
	if (
		!saved.success ||
		(await canonicalDigest(saved.data)) !== input.descriptorDigest ||
		row.revokedAt ||
		row.appId !== tool.appId ||
		row.toolRowId !== tool.id ||
		row.toolDigest !== toolDigest ||
		!row.resourceGenerationDigest ||
		row.resourceGenerationDigest !== generations ||
		row.mountDigest !== input.descriptorDigest
	)
		return none;
	const policySet = TenantToolPolicySetSchema.safeParse(row.policySet);
	if (!policySet.success) return none;
	const matching: typeof policySet.data.rules = [];
	const budget = createTenantPolicyEvaluationBudget();
	let evaluationInvalid = false;
	for (const rule of policySet.data.rules) {
		const result = evaluateTenantPolicyPredicate(
			rule.predicate,
			input.args,
			budget,
		);
		if (result === "invalid") {
			evaluationInvalid = true;
			break;
		}
		if (result === "match") matching.push(rule);
	}
	const selected = restrictivePolicyEffect(matching.map((rule) => rule.effect));
	const ruleDigest = await canonicalDigest({
		organizationId: row.organizationId,
		appId: row.appId,
		rootAppId: row.rootAppId,
		mountedToolId: row.mountedToolId,
		toolRowId: row.toolRowId,
		toolDigest,
		mountDigest: row.mountDigest,
		resourceGenerationDigest: row.resourceGenerationDigest,
		policySet: row.policySet,
	});
	if (ruleDigest !== row.ruleDigest) return none;
	if (!evaluationInvalid && matching.length > 0 && !selected) return none;
	if (evaluationInvalid || !selected)
		return {
			matched: true,
			revisionId: row.id,
			ruleDigest,
			defaultAsk: true as const,
		};
	return {
		matched: true,
		revisionId: row.id,
		ruleDigest,
		effect: selected,
	};
}

/** Resolve every applicable subject together and bind the whole mount revision. */
export async function resolveTenantToolPolicyForGateway(
	context: BaseContext,
	input: ResolveTenantToolPolicyInput,
): Promise<z.infer<typeof ResolveTenantToolPolicyResponseSchema>> {
	await assertGatewayOrganization(context, input.organizationId);
	const none = { matched: false, revisionId: null, ruleDigest: null };
	const descriptor = input.descriptor;
	const subjectKey = tenantPolicySubjectKey(descriptor);
	if (
		!subjectKey ||
		!("kind" in descriptor) ||
		(await canonicalDigest(descriptor)) !== input.descriptorDigest
	)
		return none;
	const mount = descriptor.mount;
	const scope = {
		organizationId: input.organizationId,
		rootAppId: mount.rootAppId,
		mountedToolId: mount.mountedToolId,
	};
	const fences = await findTenantToolPolicySubjectFences(context.db, scope);
	if (fences.some((item) => !item.subjectKey)) return none;
	let keys = [subjectKey];
	if (descriptor.kind === "machine" || descriptor.kind === "native_rpc") {
		const subject = descriptor.subject;
		if (!context.externalAgentSessionId || !context.externalAgentClientRecordId)
			return none;
		keys = [
			JSON.stringify([
				"machine-principal",
				subject.principalId,
				subject.mcpServerId,
			]),
			JSON.stringify([
				"machine-session",
				subject.principalId,
				subject.mcpServerId,
				context.externalAgentSessionId,
				context.externalAgentClientRecordId,
			]),
		];
	}
	const relevant = fences.filter(
		(item) => item.subjectKey && keys.includes(item.subjectKey),
	);
	if (
		!relevant.some((item) => item.subjectKey === subjectKey) ||
		relevant.some((item) => !item.policyRowId || item.revokedAt)
	)
		return none;
	const decisions = [];
	for (const fence of relevant) {
		const [row] = await findTenantToolPolicyRevisions(context.db, {
			...scope,
			subjectKey: fence.subjectKey!,
		});
		const parsed = TenantToolPolicyBoundDescriptorSchema.safeParse(
			row?.mountDescriptor,
		);
		if (
			!row ||
			!parsed.success ||
			!row.mountDigest ||
			row.id !== fence.policyId
		)
			return none;
		if (
			fence.subjectKey === subjectKey &&
			row.mountDigest !== input.descriptorDigest
		)
			return none;
		const other = parsed.data;
		if (!("kind" in other) || other.kind !== descriptor.kind) return none;
		if (
			descriptor.kind === "machine" &&
			(other.kind !== "machine" ||
				other.profileId !== descriptor.profileId ||
				other.profileDigest !== descriptor.profileDigest ||
				other.accountRevisionDigest !== descriptor.accountRevisionDigest)
		)
			return none;
		if ((await canonicalDigest(other.mount)) !== (await canonicalDigest(mount)))
			return none;
		const decision = await resolveSingleTenantToolPolicyForGateway(context, {
			...input,
			descriptor: other,
			descriptorDigest: row.mountDigest,
		});
		if (!decision.matched || !decision.ruleDigest || !decision.revisionId)
			return none;
		decisions.push(decision);
	}
	if (
		(await canonicalDigest(fences)) !==
		(await canonicalDigest(
			await findTenantToolPolicySubjectFences(context.db, scope),
		))
	)
		return none;
	const primary = decisions.find(
		(item) =>
			item.revisionId ===
			relevant.find((fence) => fence.subjectKey === subjectKey)?.policyId,
	);
	if (!primary) return none;
	const effects = decisions.flatMap((item) =>
		item.effect ? [item.effect] : [],
	);
	const merged = restrictivePolicyEffect(effects);
	if (effects.length > 0 && !merged) return none;
	const denied = merged?.disposition === "deny";
	const defaultAsk = !denied && decisions.some((item) => item.defaultAsk);
	if (
		defaultAsk &&
		effects.some((effect) => effect.riskTier === "external_side_effect")
	)
		return none;
	const ruleDigest = await canonicalDigest({
		fences,
		decisions: decisions.map((item) => ({
			revisionId: item.revisionId,
			ruleDigest: item.ruleDigest,
		})),
	});
	return {
		matched: true,
		revisionId: primary.revisionId,
		ruleDigest,
		...(defaultAsk
			? { defaultAsk: true as const }
			: { effect: merged ?? undefined }),
	};
}

async function machinePolicySubjectKeys(
	context: BaseContext,
	organizationId: string,
) {
	const principalId = context.externalAgentPrincipalId,
		sessionId = context.externalAgentSessionId,
		clientRecordId = context.externalAgentClientRecordId;
	if (
		context.authType !== "service-binding" ||
		!principalId ||
		!sessionId ||
		!clientRecordId
	)
		return [];
	const active = await resolveAuthorizedExternalAgentMcpSession(context.db, {
		organizationId,
		principalId,
		sessionId,
		clientRecordId,
		now: new Date().toISOString(),
	});
	if (!active?.credential.mcpServerId) return [];
	return [
		JSON.stringify([
			"machine-session",
			principalId,
			active.credential.mcpServerId,
			sessionId,
			clientRecordId,
		]),
		JSON.stringify([
			"machine-principal",
			principalId,
			active.credential.mcpServerId,
		]),
	];
}
function uniqueSubjectMount<
	T extends {
		rootAppId: string | null;
		mountedToolId: string | null;
		mountDescriptor: unknown;
	},
>(rows: T[], subjectKeys: string[]): T | undefined {
	if (
		new Set(
			rows.map((row) => JSON.stringify([row.rootAppId, row.mountedToolId])),
		).size !== 1
	)
		return undefined;
	return subjectKeys
		.map((key) =>
			rows.find((row) => tenantPolicySubjectKey(row.mountDescriptor) === key),
		)
		.find(Boolean);
}

/** The skill a gateway skill start names, read only inside the gateway organization. */
async function skillForStart(
	context: BaseContext,
	organizationId: string,
	args: Record<string, unknown>,
) {
	if (typeof args.skillId === "string" && args.skillId)
		return getSkillEntry(context.db, args.skillId, organizationId);
	if (typeof args.slug === "string" && args.slug)
		return getSkillEntryBySlug(context.db, organizationId, args.slug);
	return undefined;
}

function isSkillStart(target: Record<string, unknown>): boolean {
	return target.transport === "rpc" && target.endpoint === "skills/runWorkflow";
}

/**
 * The call an owner approval binds, independent of where it was mounted: the
 * organization, the requester, the tool's own name, its target and the exact
 * arguments. A `connect` session names `tedix_unified_tedix__x`; the same tool
 * on the organization gateway is `tedix__x`, and a platform-side replay runs
 * there. Only the gateway config hash is left out: it carries mount-time
 * fields that differ between two otherwise identical calls.
 */
function ownerToolCallIdentity(input: {
	organizationId: string;
	userId: string;
	toolId: string;
	target: Record<string, unknown>;
	args: Record<string, unknown>;
}) {
	return {
		organizationId: input.organizationId,
		userId: input.userId,
		toolName: input.toolId.split("__").at(-1) ?? input.toolId,
		// Every target binding the gateway or a workspace app recorded (endpoint,
		// provider, resource and account hashes, revision) except the gateway
		// config hash.
		target: Object.fromEntries(
			Object.entries(input.target).filter(([key]) => key !== "configHash"),
		),
		args: input.args,
	};
}

function ownerToolCallFingerprint(
	input: Parameters<typeof ownerToolCallIdentity>[0],
): Promise<string> {
	return canonicalDigest(ownerToolCallIdentity(input));
}

/** Which bindings a retry changed, for a refusal people can act on. */
function ownerToolCallDifferences(
	stored: ReturnType<typeof ownerToolCallIdentity>,
	call: ReturnType<typeof ownerToolCallIdentity>,
): string[] {
	const differences: string[] = [];
	if (stored.organizationId !== call.organizationId)
		differences.push("organization");
	if (stored.userId !== call.userId) differences.push("requester");
	if (stored.toolName !== call.toolName) differences.push("tool");
	if (canonicalJson(stored.target) !== canonicalJson(call.target))
		differences.push("target");
	if (canonicalJson(stored.args) !== canonicalJson(call.args))
		differences.push("arguments");
	return differences;
}

/** Plain-language card title; the tool slug stays in the payload. */
function ownerToolApprovalTitle(
	toolId: string,
	skillTitle: string | undefined,
	args: Record<string, unknown> = {},
): string {
	if (skillTitle) return `Run skill: ${skillTitle}`;
	const action = (toolId.split("__").at(-1) ?? toolId)
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.trim();
	if (/^(?:execute|run)$/i.test(action))
		return typeof args.code === "string"
			? "Run the submitted code"
			: typeof args.command === "string"
				? "Run the submitted command"
				: `Run the ${action.toLowerCase()} tool`;
	if (!action.includes(" "))
		return action
			? `Run the ${action.toLowerCase()} tool`
			: "Run the submitted tool call";
	return action[0]!.toUpperCase() + action.slice(1);
}

async function requestMachineApproval(
	context: BaseContext,
	input: RequestMachineToolApprovalInput,
) {
	await assertGatewayOrganization(context, input.organizationId);
	const principalId = context.externalAgentPrincipalId;
	const sessionId = context.externalAgentSessionId;
	const clientRecordId = context.externalAgentClientRecordId;
	if (
		!principalId ||
		!sessionId ||
		!clientRecordId ||
		(input.descriptor.kind === "machine" &&
			!context.tediScopes?.includes("connections.execute"))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A verified machine session with the required grant is required",
		);
	const decision = await resolveTenantToolPolicyForGateway(context, {
		organizationId: input.organizationId,
		descriptor: input.descriptor,
		descriptorDigest: input.descriptorDigest,
		args: input.args,
	});
	if (
		!decision.matched ||
		decision.revisionId !== input.revisionId ||
		decision.ruleDigest !== input.ruleDigest ||
		(!decision.defaultAsk && decision.effect?.disposition !== "ask")
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Machine policy changed or does not require approval",
		);
	const organization = await getOrganizationById(
		context.db,
		input.organizationId,
	);
	const origin =
		organization &&
		buildSurfaceUrl("os", organization.slug, {
			platformDomain: platformDomainForEnvironment(context.env.ENVIRONMENT),
		});
	if (!origin)
		throw createError(ErrorCodes.NOT_FOUND, "Organization OS is unavailable");
	const fingerprint = await canonicalDigest({
		organizationId: input.organizationId,
		principalId,
		sessionId,
		clientRecordId,
		descriptorDigest: input.descriptorDigest,
		revisionId: input.revisionId,
		ruleDigest: input.ruleDigest,
		args: input.args,
	});
	const now = new Date().toISOString();
	const url = (id: string) =>
		`${origin.replace(/\/+$/, "")}/work/approvals#${id}`;
	if (input.approvalRequestId) {
		const approval = await getApprovalRequestById(
			context.db,
			input.approvalRequestId,
		);
		if (
			!approval ||
			approval.orgId !== input.organizationId ||
			approval.actionType !== "mcp.tool_call" ||
			approval.payload.kind !== "mcp_machine_tool_call" ||
			approval.payload.fingerprint !== fingerprint
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Approval is for a different machine call",
			);
		const approverId = approvingUserId(approval.resolvedBy);
		const approver = approverId
			? await getMemberByUserId(context.db, input.organizationId, approverId)
			: undefined;
		const approved =
			approval.status === "approved" &&
			approver?.status === "active" &&
			["owner", "admin"].includes(approver.role) &&
			(await consumeOwnerToolApproval(context.db, {
				id: approval.id,
				organizationId: input.organizationId,
				fingerprint,
				now,
			}));
		return {
			approved: Boolean(approved),
			approvalRequestId: approval.id,
			status: approved ? "consumed" : approval.status,
			url: url(approval.id),
		};
	}
	const pending = await findPendingOwnerToolApproval(context.db, {
		organizationId: input.organizationId,
		fingerprint,
		now,
	});
	if (pending)
		return {
			approved: false,
			approvalRequestId: pending.id,
			status: "pending",
			url: url(pending.id),
		};
	const anchor = await getApprovalAnchor(context.db, input.organizationId);
	if (!anchor)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Organization has no approval anchor",
		);
	const id = crypto.randomUUID();
	await createApprovalRequestWithAudit(
		context.db,
		{
			id,
			orgId: input.organizationId,
			tediId: anchor.id,
			actionType: "mcp.tool_call",
			description: `Allow the machine to ${input.descriptor.mount.sourceToolId.replace(/[_-]+/g, " ")}? Nothing has run yet. After approval, the same machine session must retry the exact call.`,
			payload: {
				kind: "mcp_machine_tool_call",
				principalId,
				sessionId,
				clientRecordId,
				riskTier: decision.effect?.riskTier ?? "high_impact_write",
				blastRadius: decision.effect?.blastRadius ?? "external_system",
				descriptor: input.descriptor,
				descriptorDigest: input.descriptorDigest,
				revisionId: input.revisionId,
				ruleDigest: input.ruleDigest,
				args: input.args,
				fingerprint,
			},
			createdAt: now,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
		},
		{
			organizationId: input.organizationId,
			actorId: principalId,
			actorType: "m2m",
			action: "approval.requested",
			resourceType: "approval_request",
			resourceId: id,
			metadata: {
				source: "mcp.gateway",
				toolId: input.descriptor.mount.sourceToolId,
			},
		},
	);
	return {
		approved: false,
		approvalRequestId: id,
		status: "pending",
		url: url(id),
	};
}

export const mcpGovernanceContractRouter = mcpGovernanceOs.router({
	resolveHomeToolApproval: serviceOs.resolveHomeToolApproval.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const approval = await getApprovalRequestById(
				context.db,
				input.approvalRequestId,
			);
			const payload = parseHomeToolWritePayload(approval?.payload);
			const digest = await canonicalDigest(input.args);
			// The receipt's principal: the member who asked for a Home write, or,
			// for an agent-started run with no initiator, the human who approved
			// it. The approver's receipt is only valid on the tenant credential; it
			// never selects their personal connection or user scopes.
			const approvedByUserId = approvingUserId(approval?.resolvedBy);
			const principalMatches = payload?.initiatedByUserId
				? payload.initiatedByUserId === input.userId
				: input.credential === "tenant" &&
					approvedByUserId !== undefined &&
					approvedByUserId === input.userId;
			if (
				approval?.orgId !== input.organizationId ||
				approval.actionType !== "home.tool_write" ||
				approval.status !== "approved" ||
				!payload ||
				payload.organizationId !== input.organizationId ||
				!principalMatches ||
				payload.appSlug !== input.appSlug ||
				payload.toolName !== input.toolName ||
				!(
					await Promise.all(
						[payload.args, ...(payload.additionalArgs ?? [])].map(
							canonicalDigest,
						),
					)
				).includes(digest)
			)
				return { approved: false };
			if (
				payload.initiatedByAgentPrincipalId &&
				!(await initiatingAgentMayStillAct(
					context,
					input.organizationId,
					payload.initiatedByAgentPrincipalId,
				))
			)
				return { approved: false };
			const initiator = await getMemberByUserId(
				context.db,
				input.organizationId,
				input.userId,
			);
			if (initiator?.status !== "active") return { approved: false };
			// The canonical resolve path already checked os:approve, including
			// explicit member grants. Recheck membership without narrowing it to roles.
			if (approval.resolvedBy !== "policy") {
				const approver = approval.resolvedBy
					? await getMemberByUserId(
							context.db,
							input.organizationId,
							approval.resolvedBy.replace(/^user:/, ""),
						)
					: undefined;
				if (approver?.status !== "active") return { approved: false };
			}
			const run = await getKernelRuntimeRun(context.db, {
				id: payload.homeRunId,
				organizationId: input.organizationId,
			});
			// Settlement owns the one-shot run claim. A parked or terminal run is
			// never authority to replay the same approved call.
			if (
				!(
					run?.status === "running" &&
					run.conversationId === payload.conversationId &&
					run.metadata?.approvalStatus === "approved" &&
					run.metadata.kernelWriteExecutedAt
				)
			)
				return { approved: false };
			// While the run is still running, the same call must not run twice.
			return {
				approved: await consumeHomeToolApprovalCall(context.db, {
					id: input.approvalRequestId,
					organizationId: input.organizationId,
					slot: `${input.credential}_${digest}`,
					now: new Date().toISOString(),
				}),
			};
		},
	),
	recordPolicyToolApproval: serviceOs.recordPolicyToolApproval.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			// The anchor supplies the approval queue's FK, never tedi authority.
			const anchor = await getApprovalAnchor(context.db, input.organizationId);
			if (!anchor) return { approvalRequestId: null };
			const id = crypto.randomUUID();
			const now = new Date().toISOString();
			const actor = input.userId ?? input.tediId ?? "mcp.gateway";
			await createApprovalRequestWithAudit(
				context.db,
				{
					id,
					orgId: input.organizationId,
					tediId: anchor.id,
					actionType: "mcp.tool_call",
					description: ownerToolApprovalTitle(input.toolId, undefined),
					payload: {
						kind: "mcp_tool_call",
						appSlug: input.appSlug,
						toolId: input.toolId,
						platformOperation: input.operationId,
						...(input.userId ? { initiatedByUserId: input.userId } : {}),
						...(input.tediId ? { initiatedByTediId: input.tediId } : {}),
						...(input.externalAgentPrincipalId
							? { externalAgentPrincipalId: input.externalAgentPrincipalId }
							: {}),
					},
					createdAt: now,
					expiresAt: now,
					// Settled at creation by policy: Activity reads resolvedBy "policy"
					// as an automatic approval. Nothing waits on this row.
					automaticApproval: { tediId: "policy", reason: input.reason },
				},
				{
					organizationId: input.organizationId,
					actorId: actor,
					actorType: input.userId ? "user" : input.tediId ? "tedi" : "service",
					action: "approval.approved",
					resourceType: "approval_request",
					resourceId: id,
					metadata: {
						source: "mcp.gateway",
						resolvedBy: "policy",
						appSlug: input.appSlug,
						toolId: input.toolId,
						platformOperation: input.operationId,
					},
				},
			);
			return { approvalRequestId: id };
		},
	),
	prepareOwnerPolicyReplay: serviceOs.prepareOwnerPolicyReplay.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const actor = context.gatewayEndUserId;
			if (
				context.authType !== "service-binding" ||
				context.headers.get("X-Tedix-Kernel") !== "true" ||
				!actor ||
				!context.tediScopes?.includes("connections.execute") ||
				!(await isActiveOwnerOrAdmin(context, input.organizationId, actor))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Verified requester and connection access are required",
				);
			const approval = await getApprovalRequestById(
				context.db,
				input.approvalRequestId,
			);
			const now = new Date().toISOString();
			const stored = approval?.payload as Record<string, unknown> | undefined;
			if (
				!approval ||
				approval.orgId !== input.organizationId ||
				approval.actionType !== "mcp.tool_call" ||
				approval.status !== "approved" ||
				approval.expiresAt <= now ||
				stored?.kind !== "mcp_tool_call" ||
				stored.initiatedByUserId !== actor ||
				typeof stored.consumedAt === "string" ||
				!stored.args ||
				(await canonicalDigest(stored.args)) !==
					(await canonicalDigest(input.args))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Approved call is unavailable or does not match",
				);
			const approver = approvingUserId(approval.resolvedBy);
			if (
				!approver ||
				!(await isActiveOwnerOrAdmin(context, input.organizationId, approver))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Approver is no longer authorized",
				);
			const target = stored.target;
			const raw =
				target && typeof target === "object" && !Array.isArray(target)
					? (target as Record<string, unknown>).tenantPolicyBinding
					: null;
			const binding =
				raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as Record<string, unknown>)
					: null;
			const descriptor = TenantToolPolicyProfileDescriptorSchema.safeParse(
				binding?.descriptor,
			);
			if (
				!descriptor.success ||
				descriptor.data.actorUserId !== actor ||
				typeof binding?.descriptorDigest !== "string" ||
				typeof binding.revisionId !== "string" ||
				typeof binding.ruleDigest !== "string"
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Approved policy binding is invalid",
				);
			const current = await resolveTenantToolPolicyForGateway(context, {
				organizationId: input.organizationId,
				descriptor: descriptor.data,
				descriptorDigest: binding.descriptorDigest,
				args: input.args,
			});
			if (
				!current.matched ||
				current.revisionId !== binding.revisionId ||
				current.ruleDigest !== binding.ruleDigest ||
				(!current.defaultAsk && current.effect?.disposition !== "ask")
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Tool policy changed or was revoked",
				);
			const probeReceiptId = crypto.randomUUID();
			await createProviderProbeReceipt(context.db, {
				id: probeReceiptId,
				organizationId: input.organizationId,
				actorUserId: actor,
				profileId: descriptor.data.profileId,
				profileDigest: descriptor.data.profileDigest,
				argsDigest: await canonicalDigest(input.args),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			});
			return {
				binding: {
					descriptor: descriptor.data,
					descriptorDigest: binding.descriptorDigest,
					revisionId: binding.revisionId,
					ruleDigest: binding.ruleDigest,
				},
				probeReceiptId,
			};
		},
	),
	requestMachineToolApproval: serviceOs.requestMachineToolApproval.handler(
		({ input, context }) => requestMachineApproval(context, input),
	),
	requestNativeMachineToolApproval:
		serviceOs.requestNativeMachineToolApproval.handler(({ input, context }) =>
			requestMachineApproval(context, input),
		),
	requestOwnerToolApproval: serviceOs.requestOwnerToolApproval.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const requester = await getMemberByUserId(
				context.db,
				input.organizationId,
				input.userId,
			);
			if (
				requester?.status !== "active" ||
				!["owner", "admin"].includes(requester.role)
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Tool approval requests require an active organization owner or admin",
				);
			const organization = await getOrganizationById(
				context.db,
				input.organizationId,
			);
			const origin =
				organization &&
				buildSurfaceUrl("os", organization.slug, {
					platformDomain: platformDomainForEnvironment(context.env.ENVIRONMENT),
				});
			if (!origin)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Organization OS is unavailable",
				);
			const fingerprint = await canonicalDigest({
				organizationId: input.organizationId,
				userId: input.userId,
				appSlug: input.appSlug,
				toolId: input.toolId,
				target: input.target,
				args: input.args,
			});
			const callIdentity = ownerToolCallIdentity(input);
			const callFingerprint = await canonicalDigest(callIdentity);
			const now = new Date().toISOString();
			if (input.approvalRequestId) {
				const approval = await getApprovalRequestById(
					context.db,
					input.approvalRequestId,
				);
				if (
					!approval ||
					approval.orgId !== input.organizationId ||
					approval.actionType !== "mcp.tool_call" ||
					typeof approval.payload.fingerprint !== "string"
				)
					throw createError(
						ErrorCodes.NOT_FOUND,
						"Approval request not found in this organization",
					);
				// Rows parked before the mount-independent fingerprint existed carry
				// the fields it is computed from, so they match the same way.
				const stored = approval.payload as Record<string, unknown>;
				const storedIdentity = ownerToolCallIdentity({
					organizationId: approval.orgId,
					userId:
						typeof stored.initiatedByUserId === "string"
							? stored.initiatedByUserId
							: "",
					toolId: typeof stored.toolId === "string" ? stored.toolId : "",
					target:
						stored.target && typeof stored.target === "object"
							? (stored.target as Record<string, unknown>)
							: {},
					args:
						stored.args && typeof stored.args === "object"
							? (stored.args as Record<string, unknown>)
							: {},
				});
				if (
					approval.payload.fingerprint !== fingerprint &&
					(await canonicalDigest(storedIdentity)) !== callFingerprint
				) {
					const differences = ownerToolCallDifferences(
						storedIdentity,
						callIdentity,
					);
					throw createError(
						ErrorCodes.FORBIDDEN,
						`Approval ${approval.id} is for a different call (${differences.join(", ") || "bindings"} differ); request a new approval`,
					);
				}
				// A policy-bound approval can be consumed only while the exact
				// owner-reviewed rule still matches. The gateway must independently
				// verify the current mount and credential before dispatch.
				if (Object.hasOwn(storedIdentity.target, "tenantPolicyBinding")) {
					const binding = storedIdentity.target.tenantPolicyBinding;
					if (!binding || typeof binding !== "object" || Array.isArray(binding))
						throw createError(
							ErrorCodes.FORBIDDEN,
							"Tool policy binding is invalid",
						);
					const fields = binding as Record<string, unknown>;
					const descriptor = TenantToolPolicyBoundDescriptorSchema.safeParse(
						fields.descriptor,
					);
					if (
						!descriptor.success ||
						("kind" in descriptor.data &&
							(descriptor.data.kind !== "profile" ||
								descriptor.data.actorUserId !== input.userId)) ||
						typeof fields.descriptorDigest !== "string" ||
						typeof fields.revisionId !== "string" ||
						typeof fields.ruleDigest !== "string"
					)
						throw createError(
							ErrorCodes.FORBIDDEN,
							"Tool policy binding is invalid",
						);
					const current = await resolveTenantToolPolicyForGateway(context, {
						organizationId: input.organizationId,
						descriptor: descriptor.data,
						descriptorDigest: fields.descriptorDigest,
						args: input.args,
					});
					if (
						!current.matched ||
						current.revisionId !== fields.revisionId ||
						current.ruleDigest !== fields.ruleDigest
					)
						throw createError(
							ErrorCodes.FORBIDDEN,
							"Tool policy changed or was revoked; request a new approval",
						);
				}
				const approver = approval.resolvedBy
					? await getMemberByUserId(
							context.db,
							input.organizationId,
							approval.resolvedBy.replace(/^user:/, ""),
						)
					: undefined;
				const approved =
					approval.status === "approved" &&
					approver?.status === "active" &&
					["owner", "admin"].includes(approver.role) &&
					(await consumeOwnerToolApproval(context.db, {
						id: approval.id,
						organizationId: input.organizationId,
						fingerprint: approval.payload.fingerprint,
						now,
					}));
				const execution = stored.execution as { status?: unknown } | undefined;
				return {
					approved: Boolean(approved),
					approvalRequestId: approval.id,
					status: approved
						? "consumed"
						: approval.status === "approved" &&
							  (execution?.status === "executed" ||
									execution?.status === "failed")
							? execution.status
							: approval.status === "approved" &&
								  typeof stored.consumedAt === "string"
								? "consumed"
								: approval.status,
					url: `${origin.replace(/\/+$/, "")}/work/approvals#${approval.id}`,
				};
			}
			// A retry of the same refused call reuses its open request.
			const pending = await findPendingOwnerToolApproval(context.db, {
				organizationId: input.organizationId,
				fingerprint,
				now,
			});
			if (pending)
				return {
					approved: false,
					approvalRequestId: pending.id,
					status: "pending",
					url: `${origin.replace(/\/+$/, "")}/work/approvals#${pending.id}`,
				};
			// Never park a skill start that the API would refuse after approval.
			const skill = isSkillStart(input.target)
				? await skillForStart(context, input.organizationId, input.args)
				: undefined;
			if (isSkillStart(input.target) && !skill)
				throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
			const title = ownerToolApprovalTitle(
				input.toolId,
				skill?.title,
				input.args,
			);
			const app = input.appSlug.replace(/[-_]+/g, " ");
			const organizationName = organization!.name || organization!.slug;
			const requestedFor =
				requester.name || "the requesting organization member";
			// The anchor supplies the existing approval queue's FK, never tedi authority.
			const anchor = await getApprovalAnchor(context.db, input.organizationId);
			if (!anchor)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Organization has no approval anchor",
				);
			const id = crypto.randomUUID();
			await createApprovalRequestWithAudit(
				context.db,
				{
					id,
					orgId: input.organizationId,
					tediId: anchor.id,
					actionType: "mcp.tool_call",
					description: `${title}. In ${app} for ${requestedFor} (${organizationName}). Nothing has run yet; approving runs this exact call once.`,
					payload: {
						kind: "mcp_tool_call",
						initiatedByUserId: input.userId,
						appSlug: input.appSlug,
						toolId: input.toolId,
						target: input.target,
						args: input.args,
						fingerprint,
					},
					createdAt: now,
					expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
				},
				{
					organizationId: input.organizationId,
					actorId: input.userId,
					actorType: "user",
					action: "approval.requested",
					resourceType: "approval_request",
					resourceId: id,
					metadata: {
						source: "mcp.gateway",
						appSlug: input.appSlug,
						toolId: input.toolId,
					},
				},
			);
			return {
				approved: false,
				approvalRequestId: id,
				status: "pending",
				url: `${origin.replace(/\/+$/, "")}/work/approvals#${id}`,
			};
		},
	),
	resolveOwnerSkillStart: serviceOs.resolveOwnerSkillStart.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			if (
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					input.userId,
				))
			)
				return { approved: false };
			const skill = await skillForStart(context, input.organizationId, input);
			const files = (skill?.files ?? null) as Record<string, string> | null;
			// Drafts keep the certification path; effects inside keep their gates.
			if (
				!skill ||
				!RUNNABLE_SKILL_STATES.has(skill.lifecycleState ?? "") ||
				!files?.["scripts/workflow.ts"]
			)
				return { approved: false };
			return {
				approved: true,
				skillId: skill.id,
				...(skill.revision ? { revision: skill.revision } : {}),
			};
		},
	),
	resolveSkillManifestAuthorization:
		serviceOs.resolveSkillManifestAuthorization.handler(
			async ({ input, context }) => {
				const environment =
					context.env.ENVIRONMENT === "development"
						? "development"
						: "production";
				const run = await getSkillRun(
					context.db,
					input.runId,
					input.organizationId,
					environment,
				);
				if (
					!run ||
					run.skillId !== input.skillId ||
					run.tediId !== input.tediId ||
					run.executionEpoch !== input.executionEpoch ||
					run.workflowRetiredAt ||
					!["queued", "running"].includes(run.status) ||
					!run.skillRevision
				)
					return { approved: false };
				const skill = await getSkillEntry(
					context.db,
					input.skillId,
					input.organizationId,
				);
				if (
					!skill ||
					(!["active", "proven", "crystallized"].includes(
						skill.lifecycleState ?? "",
					) &&
						!(
							skill.lifecycleState === "draft" &&
							run.certification === true &&
							run.createdBy?.startsWith("user:") &&
							skill.revision === run.skillRevision
						))
				)
					return { approved: false };
				const manifest = readPinnedCapabilityManifest(run.capabilityManifest);
				if (!manifest) return { approved: false };
				const namespaces = Object.keys(manifest.mcp ?? {});
				const { namespaceToSlug } = await resolveSkillMcpNamespaceSlugs(
					context.db,
					{
						organizationId: input.organizationId,
						skillId: input.skillId,
						namespaces,
					},
				);
				const declaredNamespaces = namespaces.filter((namespace) =>
					isMethodAllowed(manifest, namespace, input.method),
				);
				// The target and namespace come from the gateway's resolved tool,
				// never call arguments.
				let declared: boolean;
				if (input.targetTediId) {
					// `tedi` is the run's own tedi. A named tedi namespace
					// (`ceo: [run_tedi_turn]`) declares that tedi of the same org.
					declared =
						(input.targetTediId === run.tediId &&
							declaredNamespaces.includes("tedi")) ||
						(declaredNamespaces.some(
							(namespace) =>
								namespace === input.namespace &&
								!RESERVED_SKILL_NAMESPACES.has(namespace) &&
								!namespaceToSlug[namespace],
						) &&
							Boolean(
								await getTediByIdForOrganization(
									context.db,
									input.targetTediId,
									input.organizationId,
								).then((tedi) => tedi && !tedi.retiredAt),
							));
				} else {
					declared = false;
					for (const namespace of declaredNamespaces) {
						if (namespace === "tedi") continue;
						const appSlug = namespaceToSlug[namespace];
						if (appSlug) {
							if (
								appSlug === input.sourceAppSlug ||
								(input.sourceAppSlug &&
									namespace !== "os" &&
									(await skillMcpProxyIncludesSource(context.db, {
										organizationId: input.organizationId,
										appSlug,
										sourceAppSlug: input.sourceAppSlug,
									})))
							)
								declared = true;
						} else if (namespace !== "os" && namespace === input.namespace)
							declared = true;
						if (declared) break;
					}
				}
				return declared
					? { approved: true, skillId: skill.id, revision: run.skillRevision }
					: { approved: false };
			},
		),
	resolveAgentLifecycleAuthorization:
		serviceOs.resolveAgentLifecycleAuthorization.handler(
			async ({ input, context }) => ({
				approved: await resolveAgentLifecycleAuthorization(context.db, input),
			}),
		),
	resolveAgentTransportPolicy: serviceOs.resolveAgentTransportPolicy.handler(
		async ({ input, context }) => {
			const tedi = input.tediId
				? await getTediByIdForOrganization(
						context.db,
						input.tediId,
						input.organizationId,
					)
				: null;
			if (input.tediId && !tedi)
				return {
					requireExplicitApprovalPolicy: false,
					platformAutonomy: false as const,
				};
			const organizationPolicy = await getActivePolicyPackDefinition(
				context.db,
				input.organizationId,
			);
			const organizationGovernance = parseKernelGovernancePolicy(
				organizationPolicy?.governancePolicy,
			);
			const autonomy = organizationGovernance.autonomy;
			const optOut =
				organizationGovernance.platformAutonomy === false
					? { platformAutonomy: false as const }
					: {};
			if (autonomy)
				autonomy.askForClasses = [
					...(autonomy.askForClasses ?? []),
					...(await readDelegationAutonomyLessons(
						context.db,
						input.organizationId,
					)),
				];
			if (!tedi?.policyPackId) {
				return {
					requireExplicitApprovalPolicy: false,
					...(autonomy ? { autonomy } : {}),
					...optOut,
				};
			}
			const policyPack = await getPolicyPackById(context.db, tedi.policyPackId);
			if (
				!policyPack ||
				policyPack.status !== "active" ||
				(policyPack.organizationId !== null &&
					policyPack.organizationId !== input.organizationId)
			) {
				return {
					requireExplicitApprovalPolicy: false,
					...(autonomy ? { autonomy } : {}),
					...optOut,
				};
			}
			const governance = parseKernelGovernancePolicy(
				policyPack.definition?.governancePolicy,
			);
			return {
				...(autonomy ? { autonomy } : {}),
				...optOut,
				requireExplicitApprovalPolicy:
					governance.requireExplicitThirdPartyApprovalPolicy === true,
			};
		},
	),
	resolveToolApprovalGrant: serviceOs.resolveToolApprovalGrant.handler(
		async ({ input, context }) => {
			const result = await resolveToolApprovalGrant(context.db, {
				organizationId: input.organizationId,
				subjectId: input.subjectId,
				appSlug: input.appSlug,
				toolId: input.toolId,
				grantKind: input.grantKind,
			});
			return result;
		},
	),
	resolveActionTypeOptIn: serviceOs.resolveActionTypeOptIn.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			// Re-checked here so a row written before a class became critical
			// can never approve it.
			if (isPlatformCriticalActionType(input.actionType))
				return { approved: false, grantId: null };
			const optIn = await findActionTypeOptIn(context.db, input);
			return { approved: Boolean(optIn), grantId: optIn?.grantId ?? null };
		},
	),
	listActionTypeOptIns: authOs.listActionTypeOptIns
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => ({
			data: await listActionTypeOptIns(context.db, {
				organizationId: requireOrgId(context),
			}),
		})),
	listLegacyActionTypeInventory: authOs.listLegacyActionTypeInventory
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => {
			const organizationId = requireOrgId(context);
			const [grants, tools] = await Promise.all([
				listActionTypeOptIns(context.db, { organizationId }),
				listDeclaredActionToolsForOrganization(context.db, organizationId),
			]);
			const classes = new Set(grants.map((grant) => grant.actionType));
			return {
				grants,
				tools: tools
					.slice(0, 500)
					.filter(
						(tool): tool is typeof tool & { actionType: string } =>
							!!tool.actionType && classes.has(tool.actionType),
					),
				truncated: tools.length > 500 || grants.length >= 200,
			};
		}),
	setActionTypeOptIn: authOs.setActionTypeOptIn
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			// A person decides; a tedi, agent or key holding apps:write cannot
			// widen its own approvals.
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can change which actions run without asking",
				);
			if (input.enabled && isPlatformCriticalActionType(input.actionType))
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`"${input.actionType}" is a platform-critical action and always asks for approval`,
				);
			const optIn = await setActionTypeOptIn(context.db, {
				organizationId,
				actionType: input.actionType,
				enabled: input.enabled,
				reason: `set by user:${context.userId}`,
			});
			return {
				actionType: input.actionType,
				enabled: input.enabled,
				optIn: optIn ?? null,
			};
		}),
	listDeletedTenantPolicyFences: authOs.listDeletedTenantPolicyFences
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => ({
			items: await listDeletedTenantPolicyFences(
				context.db,
				requireOrgId(context),
			),
		})),
	listTenantToolPolicies: authOs.listTenantToolPolicies
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => {
			const rows = await listTenantToolPolicies(
				context.db,
				requireOrgId(context),
			);
			return { items: rows.map((row) => TenantToolPolicySchema.parse(row)) };
		}),
	prepareTenantToolPolicy: authOs.prepareTenantToolPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can prepare tool policies",
				);
			if (
				!(await getAppByIdForOrganization(
					context.db,
					input.rootAppId,
					organizationId,
				))
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"App not found in this organization",
				);
			const response = await context.env.MCP_SERVICE.fetch(
				new Request(
					"https://mcp.internal/_internal/tenant-tool-policy/prepare",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify({
							organizationId,
							rootAppId: input.rootAppId,
							mountedToolId: input.mountedToolId,
						}),
					},
				),
			);
			if (!response.ok)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"The tool could not be prepared for policy review",
				);
			const result = (await response.json()) as {
				descriptor?: unknown;
				descriptorDigest?: unknown;
			};
			const parsed = TenantToolPolicyRawMountDescriptorSchema.safeParse(
				result.descriptor,
			);
			if (
				!parsed.success ||
				parsed.data.organizationId !== organizationId ||
				parsed.data.rootAppId !== input.rootAppId ||
				parsed.data.mountedToolId !== input.mountedToolId ||
				(await canonicalDigest(parsed.data)) !== result.descriptorDigest
			)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"The prepared tool identity could not be verified",
				);
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId,
				toolId: parsed.data.sourceToolRowId,
			});
			if (
				!tool ||
				!tool.enabled ||
				tool.appId !== parsed.data.sourceAppId ||
				tool.toolId !== parsed.data.sourceToolId
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Source tool not found in this organization",
				);
			const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
			const accountRevisionDigest = await ownerReviewedAccountDigest(
				context,
				parsed.data,
				input.exampleArgs,
			);
			const descriptor = { ...parsed.data, accountRevisionDigest };
			const descriptorDigest = await canonicalDigest(descriptor);
			const preparationId = crypto.randomUUID();
			await createTenantToolPolicyPreparation(context.db, {
				id: preparationId,
				organizationId,
				ownerId: context.userId,
				descriptor,
				descriptorDigest,
				sourceToolDigest: await canonicalDigest(tool),
				exampleArgsDigest: await canonicalDigest(input.exampleArgs),
				resourceGenerationDigest: await resourceGenerationDigest(
					context,
					descriptor,
				),
				expiresAt,
			});
			return {
				preparationId,
				descriptor,
				descriptorDigest,
				expiresAt,
			};
		}),
	prepareHybridTenantToolPolicy: authOs.prepareHybridTenantToolPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const actor = context.userId;
			if (
				context.authType !== "user" ||
				!actor ||
				context.user?.sub !== actor ||
				!Array.isArray(context.user.scopes) ||
				!context.user.scopes.includes("connections.execute") ||
				!(await isActiveOwnerOrAdmin(context, organizationId, actor))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"A verified owner connection grant is required",
				);
			const profile = await currentProbeProfile(
				context,
				organizationId,
				input.profileId,
			);
			if (
				!profile ||
				!(await isActiveOwnerOrAdmin(
					context,
					organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"The reviewed identity profile is unavailable",
				);
			const result = await consumeProviderProbeResult(context.db, {
				id: input.resultReceiptId,
				organizationId,
				actorUserId: actor,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				argsDigest: await canonicalDigest(input.exampleArgs),
				now: new Date().toISOString(),
			});
			if (!result)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Identity verification expired or was already used",
				);
			const fresh = await profileMount(
				context,
				organizationId,
				profile.mount.rootAppId,
				profile.mount.mountedToolId,
			);
			if (
				(await canonicalDigest(fresh)) !==
				(await canonicalDigest(profile.mount))
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"The tool changed since identity verification",
				);
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId,
				toolId: fresh.sourceToolRowId,
			});
			if (
				!tool ||
				!tool.enabled ||
				tool.appId !== fresh.sourceAppId ||
				tool.toolId !== fresh.sourceToolId
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Source tool not found in this organization",
				);
			const descriptor = {
				kind: "profile" as const,
				mount: fresh,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				actorUserId: actor,
				accountRevisionDigest: result.accountRevisionDigest,
			};
			const descriptorDigest = await canonicalDigest(descriptor);
			const preparationId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
			await createTenantToolPolicyPreparation(context.db, {
				id: preparationId,
				organizationId,
				ownerId: actor,
				descriptor,
				descriptorDigest,
				sourceToolDigest: await canonicalDigest(tool),
				exampleArgsDigest: await canonicalDigest(input.exampleArgs),
				resourceGenerationDigest: await resourceGenerationDigest(
					context,
					fresh,
				),
				expiresAt,
			});
			return { preparationId, descriptor, descriptorDigest, expiresAt };
		}),
	prepareNativeRpcPolicy: authOs.prepareNativeRpcPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context),
				owner = context.userId;
			if (
				context.authType !== "user" ||
				!owner ||
				context.user?.sub !== owner ||
				!(await isActiveOwnerOrAdmin(context, organizationId, owner))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an active owner or admin can review a machine rule",
				);
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					clientRecordId: input.clientRecordId,
					now: new Date().toISOString(),
				},
			);
			if (!active)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine session is no longer active",
				);
			const mount = await nativeRpcMount(
				context,
				organizationId,
				input.rootAppId,
				input.mountedToolId,
			);
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId,
				toolId: mount.sourceToolRowId,
			});
			if (
				!tool ||
				!tool.enabled ||
				tool.appId !== mount.sourceAppId ||
				tool.toolId !== mount.sourceToolId
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Enabled source tool not found",
				);
			const descriptor = {
				kind: "native_rpc" as const,
				mount,
				ownerUserId: owner,
				subject: {
					scope: "principal" as const,
					principalId: active.principal.id,
					mcpServerId: active.credential.mcpServerId,
				},
				reviewSessionId: input.sessionId,
				reviewClientRecordId: input.clientRecordId,
			};
			const descriptorDigest = await canonicalDigest(descriptor),
				preparationId = crypto.randomUUID(),
				expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
			await createTenantToolPolicyPreparation(context.db, {
				id: preparationId,
				organizationId,
				ownerId: owner,
				descriptor: toJsonValue(descriptor),
				descriptorDigest,
				sourceToolDigest: await canonicalDigest(tool),
				exampleArgsDigest: await canonicalDigest(input.exampleArgs),
				resourceGenerationDigest: await resourceGenerationDigest(
					context,
					mount,
				),
				expiresAt,
			});
			return { preparationId, descriptor, descriptorDigest, expiresAt };
		}),
	prepareMachineTenantToolPolicy: authOs.prepareMachineTenantToolPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const owner = context.userId;
			if (
				context.authType !== "user" ||
				!owner ||
				context.user?.sub !== owner ||
				!(await isActiveOwnerOrAdmin(context, organizationId, owner))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an active owner or admin can review a machine rule",
				);
			const profile = await currentProbeProfile(
				context,
				organizationId,
				input.profileId,
			);
			if (
				!profile ||
				!(await isActiveOwnerOrAdmin(
					context,
					organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"The reviewed identity profile is unavailable",
				);
			const result = await consumeMachineProviderProbeResult(context.db, {
				id: input.resultReceiptId,
				organizationId,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				argsDigest: await canonicalDigest(input.exampleArgs),
				now: new Date().toISOString(),
			});
			if (!result)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Machine verification expired or was already used",
				);
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId,
					principalId: result.principalId,
					sessionId: result.sessionId,
					clientRecordId: result.clientRecordId,
					now: new Date().toISOString(),
				},
			);
			if (!active || active.credential.mcpServerId !== result.mcpServerId)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine session is no longer active",
				);
			const fresh = await profileMount(
				context,
				organizationId,
				profile.mount.rootAppId,
				profile.mount.mountedToolId,
			);
			if (
				(await canonicalDigest(fresh)) !==
				(await canonicalDigest(profile.mount))
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"The tool changed since machine verification",
				);
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId,
				toolId: fresh.sourceToolRowId,
			});
			if (
				!tool ||
				!tool.enabled ||
				tool.appId !== fresh.sourceAppId ||
				tool.toolId !== fresh.sourceToolId
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Source tool not found in this organization",
				);
			const subject =
				input.subjectScope === "principal"
					? {
							scope: "principal" as const,
							principalId: result.principalId,
							mcpServerId: result.mcpServerId,
						}
					: {
							scope: "session" as const,
							principalId: result.principalId,
							sessionId: result.sessionId,
							clientRecordId: result.clientRecordId,
							clientId: result.clientId,
							mcpServerId: result.mcpServerId,
						};
			const descriptor = {
				kind: "machine" as const,
				mount: fresh,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				ownerUserId: owner,
				subject,
				credentialScope: "tenant" as const,
				accountRevisionDigest: result.accountRevisionDigest,
			};
			const descriptorDigest = await canonicalDigest(descriptor),
				preparationId = crypto.randomUUID(),
				expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
			await createTenantToolPolicyPreparation(context.db, {
				id: preparationId,
				organizationId,
				ownerId: owner,
				descriptor: toJsonValue(descriptor),
				descriptorDigest,
				sourceToolDigest: await canonicalDigest(tool),
				exampleArgsDigest: await canonicalDigest(input.exampleArgs),
				resourceGenerationDigest: await resourceGenerationDigest(
					context,
					fresh,
				),
				expiresAt,
			});
			return { preparationId, descriptor, descriptorDigest, expiresAt };
		}),
	createTenantToolPolicy: authOs.createTenantToolPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can change tool policies",
				);
			const preparation = await consumeTenantToolPolicyPreparation(context.db, {
				id: input.preparationId,
				organizationId,
				ownerId: context.userId,
				descriptorDigest: input.expectedDescriptorDigest,
				now: new Date().toISOString(),
			});
			if (!preparation)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tool review expired or was already used; prepare it again",
				);
			if (
				!preparation.exampleArgsDigest ||
				(await canonicalDigest(input.exampleArgs)) !==
					preparation.exampleArgsDigest
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Example arguments changed; prepare the rule again",
				);
			const descriptor = TenantToolPolicyBoundDescriptorSchema.parse(
				preparation.descriptor,
			);
			if (!tenantPolicySubjectKey(descriptor))
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Review a user or machine identity before saving this rule",
				);
			const isProfile = "kind" in descriptor;
			const mount = isProfile ? descriptor.mount : descriptor;
			if (
				mount.organizationId !== organizationId ||
				(await canonicalDigest(descriptor)) !== preparation.descriptorDigest
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Prepared tool identity is invalid",
				);
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId,
				toolId: mount.sourceToolRowId,
			});
			if (!tool || tool.appId !== mount.sourceAppId || !tool.enabled)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Enabled tool not found in this organization",
				);
			const toolDigest = await canonicalDigest(tool);
			if (
				!preparation.sourceToolDigest ||
				toolDigest !== preparation.sourceToolDigest
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tool changed since review; prepare it again",
				);
			if (isProfile && descriptor.kind === "native_rpc") {
				if (
					descriptor.ownerUserId !== context.userId ||
					(await canonicalDigest(
						await nativeRpcMount(
							context,
							organizationId,
							mount.rootAppId,
							mount.mountedToolId,
						),
					)) !== (await canonicalDigest(mount))
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Native tool changed since review; prepare it again",
					);
				const active = await resolveAuthorizedExternalAgentMcpSession(
					context.db,
					{
						organizationId,
						principalId: descriptor.subject.principalId,
						sessionId: descriptor.reviewSessionId,
						clientRecordId: descriptor.reviewClientRecordId,
						now: new Date().toISOString(),
					},
				);
				if (
					!active ||
					active.credential.mcpServerId !== descriptor.subject.mcpServerId
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Reviewed machine session is no longer active",
					);
			} else if (isProfile && descriptor.kind === "machine") {
				if (
					descriptor.ownerUserId !== context.userId ||
					!input.machineConfirmationReceiptId
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"A fresh machine confirmation and the reviewing owner are required",
					);
				const currentProfile = await currentProbeProfile(
					context,
					organizationId,
					descriptor.profileId,
				);
				if (
					!currentProfile ||
					currentProfile.profileDigest !== descriptor.profileDigest ||
					!(await isActiveOwnerOrAdmin(
						context,
						organizationId,
						currentProfile.createdBy,
					))
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"The reviewed identity profile is unavailable",
					);
				const confirmation = await consumeMachineProviderProbeResult(
					context.db,
					{
						id: input.machineConfirmationReceiptId,
						organizationId,
						profileId: descriptor.profileId,
						profileDigest: descriptor.profileDigest,
						argsDigest: await canonicalDigest(input.exampleArgs),
						now: new Date().toISOString(),
					},
				);
				if (
					!confirmation ||
					confirmation.principalId !== descriptor.subject.principalId ||
					confirmation.mcpServerId !== descriptor.subject.mcpServerId ||
					confirmation.accountRevisionDigest !==
						descriptor.accountRevisionDigest ||
					(descriptor.subject.scope === "session" &&
						(confirmation.sessionId !== descriptor.subject.sessionId ||
							confirmation.clientRecordId !==
								descriptor.subject.clientRecordId ||
							confirmation.clientId !== descriptor.subject.clientId))
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Machine identity or account changed; verify it again",
					);
				const active = await resolveAuthorizedExternalAgentMcpSession(
					context.db,
					{
						organizationId,
						principalId: confirmation.principalId,
						sessionId: confirmation.sessionId,
						clientRecordId: confirmation.clientRecordId,
						now: new Date().toISOString(),
					},
				);
				if (
					!active ||
					active.credential.mcpServerId !== confirmation.mcpServerId
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Machine session is no longer active",
					);
				const fresh = await profileMount(
					context,
					organizationId,
					mount.rootAppId,
					mount.mountedToolId,
				);
				if (
					(await canonicalDigest(fresh)) !== (await canonicalDigest(mount)) ||
					(await canonicalDigest(currentProfile.mount)) !==
						(await canonicalDigest(mount))
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Tool connection changed since review; prepare it again",
					);
			} else if (isProfile && descriptor.kind === "profile") {
				if (descriptor.actorUserId !== context.userId)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"The identity verification belongs to another requester",
					);
				const fresh = await profileMount(
					context,
					organizationId,
					mount.rootAppId,
					mount.mountedToolId,
				);
				if ((await canonicalDigest(fresh)) !== (await canonicalDigest(mount)))
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Tool connection changed since review; prepare it again",
					);
				const rechecked = await probeReviewedProviderIdentity(context, {
					organizationId,
					profileId: descriptor.profileId,
					exampleArgs: input.exampleArgs,
				});
				if (
					rechecked.profile.profileDigest !== descriptor.profileDigest ||
					rechecked.accountRevisionDigest !== descriptor.accountRevisionDigest
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Connection account changed since review; prepare it again",
					);
			} else {
				const freshResponse = await context.env.MCP_SERVICE.fetch(
					new Request(
						"https://mcp.internal/_internal/tenant-tool-policy/prepare",
						{
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"X-Service-Binding": "true",
							},
							body: JSON.stringify({
								organizationId,
								rootAppId: descriptor.rootAppId,
								mountedToolId: descriptor.mountedToolId,
							}),
						},
					),
				);
				if (!freshResponse.ok)
					throw createError(
						ErrorCodes.SERVICE_UNAVAILABLE,
						"Tool could not be rechecked; prepare it again",
					);
				const fresh = (await freshResponse.json()) as {
					descriptor?: unknown;
					descriptorDigest?: unknown;
				};
				const verified = TenantToolPolicyRawMountDescriptorSchema.safeParse(
					fresh.descriptor,
				);
				const { accountRevisionDigest, ...reviewedMount } = descriptor;
				if (
					!verified.success ||
					(await canonicalDigest(verified.data)) !==
						(await canonicalDigest(reviewedMount)) ||
					fresh.descriptorDigest !== (await canonicalDigest(reviewedMount))
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Tool connection changed since review; prepare it again",
					);
				if (
					(await ownerReviewedAccountDigest(
						context,
						verified.data,
						input.exampleArgs,
					)) !== accountRevisionDigest
				)
					throw createError(
						ErrorCodes.BAD_REQUEST,
						"Connection account changed since review; prepare it again",
					);
			}
			const generations = await resourceGenerationDigest(context, mount);
			if (
				!preparation.resourceGenerationDigest ||
				generations !== preparation.resourceGenerationDigest
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tool dependencies changed since review; prepare it again",
				);
			const ruleDigest = await canonicalDigest({
				organizationId,
				appId: tool.appId,
				rootAppId: mount.rootAppId,
				mountedToolId: mount.mountedToolId,
				toolRowId: tool.id,
				toolDigest,
				mountDigest: preparation.descriptorDigest,
				resourceGenerationDigest: generations,
				policySet: input.policySet,
			});
			const newRow = {
				id: crypto.randomUUID(),
				organizationId,
				appId: tool.appId,
				rootAppId: mount.rootAppId,
				mountedToolId: mount.mountedToolId,
				toolRowId: tool.id,
				toolDigest,
				mountDescriptor: descriptor,
				mountDigest: preparation.descriptorDigest,
				resourceGenerationDigest: generations,
				ruleDigest,
				predicate: input.policySet.rules[0]!.predicate,
				effect: input.policySet.rules[0]!.effect,
				policySet: input.policySet,
				createdBy: context.userId,
				createdAt: new Date().toISOString(),
			};
			const row = await replaceTenantToolPolicy(
				context.db,
				newRow,
				input.expectedRevisionId ?? null,
				input.regrantRevoked === true,
				input.recoverDeleted === true,
				input.recoverUnknownRevisionId ?? null,
				input.subjectRecoveryMode ?? null,
			);
			if (!row)
				throw createError(
					ErrorCodes.CONFLICT,
					"This rule changed or was revoked. Review the current revision before replacing it.",
				);
			return { policy: TenantToolPolicySchema.parse(row) };
		}),
	revokeTenantToolPolicy: authOs.revokeTenantToolPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can change tool policies",
				);
			const row = await revokeTenantToolPolicy(
				context.db,
				{ organizationId, id: input.id },
				new Date().toISOString(),
			);
			if (!row)
				throw createError(ErrorCodes.NOT_FOUND, "Active tool policy not found");
			return { policy: TenantToolPolicySchema.parse(row) };
		}),
	resolveTenantToolPolicy: serviceOs.resolveTenantToolPolicy.handler(
		async ({ input, context }) =>
			resolveTenantToolPolicyForGateway(context, input),
	),
	resolveTenantPolicyCandidate: serviceOs.resolveTenantPolicyCandidate.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const [row] = await findTenantToolPolicyRevisions(context.db, {
				organizationId: input.organizationId,
				rootAppId: input.rootAppId,
				mountedToolId: input.mountedToolId,
				subjectKey: JSON.stringify(["user", input.actorUserId]),
			});
			if (!row || row.revokedAt || !row.mountDigest) return { candidate: null };
			const parsed = TenantToolPolicyProfileDescriptorSchema.safeParse(
				row.mountDescriptor,
			);
			if (
				!parsed.success ||
				parsed.data.actorUserId !== input.actorUserId ||
				parsed.data.mount.rootAppId !== input.rootAppId ||
				parsed.data.mount.mountedToolId !== input.mountedToolId
			)
				return { candidate: null };
			const decision = await resolveTenantToolPolicyForGateway(context, {
				organizationId: input.organizationId,
				descriptor: parsed.data,
				descriptorDigest: row.mountDigest,
				args: input.args,
			});
			if (
				!decision.matched ||
				!decision.revisionId ||
				!decision.ruleDigest ||
				(!decision.effect && !decision.defaultAsk)
			)
				return { candidate: null };
			return {
				candidate: {
					descriptor: parsed.data,
					descriptorDigest: row.mountDigest,
					revisionId: decision.revisionId,
					ruleDigest: decision.ruleDigest,
					...(decision.effect
						? { effect: decision.effect }
						: { defaultAsk: true as const }),
				},
			};
		},
	),
	resolveTenantPolicySourceCandidate:
		serviceOs.resolveTenantPolicySourceCandidate.handler(
			async ({ input, context }) => {
				await assertGatewayOrganization(context, input.organizationId);
				const subjectKeys = [JSON.stringify(["user", input.actorUserId])];
				const rows = await findTenantToolPolicyCandidatesBySource(context.db, {
					...input,
					subjectKeys,
				});
				const row = uniqueSubjectMount(rows, subjectKeys);
				if (!row || row.revokedAt || !row.mountDigest)
					return { candidate: null };
				const parsed = TenantToolPolicyProfileDescriptorSchema.safeParse(
					row.mountDescriptor,
				);
				if (
					!parsed.success ||
					parsed.data.actorUserId !== input.actorUserId ||
					parsed.data.mount.rootAppId !== input.rootAppId ||
					parsed.data.mount.sourceAppId !== input.sourceAppId ||
					parsed.data.mount.sourceToolRowId !== input.sourceToolRowId
				)
					return { candidate: null };
				const decision = await resolveTenantToolPolicyForGateway(context, {
					organizationId: input.organizationId,
					descriptor: parsed.data,
					descriptorDigest: row.mountDigest,
					args: input.args,
				});
				if (
					!decision.matched ||
					!decision.revisionId ||
					!decision.ruleDigest ||
					(!decision.effect && !decision.defaultAsk)
				)
					return { candidate: null };
				return {
					candidate: {
						descriptor: parsed.data,
						descriptorDigest: row.mountDigest,
						revisionId: decision.revisionId,
						ruleDigest: decision.ruleDigest,
						...(decision.effect
							? { effect: decision.effect }
							: { defaultAsk: true as const }),
					},
				};
			},
		),
	resolveTenantPolicyPresence: serviceOs.resolveTenantPolicyPresence.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			return {
				fenced: await hasTenantToolPolicyFenceForSource(context.db, input),
			};
		},
	),
	resolveMachinePolicyAnyRoot: serviceOs.resolveMachinePolicyAnyRoot.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const subjectKeys = await machinePolicySubjectKeys(
				context,
				input.organizationId,
			);
			if (!subjectKeys.length) return { candidate: null };
			const rows = await findTenantToolPolicyCandidatesBySource(context.db, {
				...input,
				subjectKeys,
			});
			const row = uniqueSubjectMount(rows, subjectKeys);
			if (!row) return { candidate: null };
			const parsed = TenantToolPolicyMachineDescriptorSchema.safeParse(
				row.mountDescriptor,
			);
			if (
				!parsed.success ||
				!row.mountDigest ||
				row.revokedAt ||
				parsed.data.mount.sourceAppId !== input.sourceAppId ||
				parsed.data.mount.sourceToolRowId !== input.sourceToolRowId
			)
				return { candidate: null };
			const decision = await resolveTenantToolPolicyForGateway(context, {
				organizationId: input.organizationId,
				descriptor: parsed.data,
				descriptorDigest: row.mountDigest,
				args: input.args,
			});
			if (
				!decision.matched ||
				!decision.revisionId ||
				!decision.ruleDigest ||
				(!decision.effect && !decision.defaultAsk)
			)
				return { candidate: null };
			return {
				candidate: {
					descriptor: parsed.data,
					descriptorDigest: row.mountDigest,
					revisionId: decision.revisionId,
					ruleDigest: decision.ruleDigest,
					...(decision.effect
						? { effect: decision.effect }
						: { defaultAsk: true as const }),
				},
			};
		},
	),
	resolveNativeRpcPolicyCandidate:
		serviceOs.resolveNativeRpcPolicyCandidate.handler(
			async ({ input, context }) => {
				await assertGatewayOrganization(context, input.organizationId);
				const subjectKeys = await machinePolicySubjectKeys(
					context,
					input.organizationId,
				);
				if (!subjectKeys.length) return { candidate: null };
				const rows = await findTenantToolPolicyCandidatesBySource(context.db, {
					...input,
					subjectKeys,
				});
				const row = uniqueSubjectMount(rows, subjectKeys);
				if (!row) return { candidate: null };
				const parsed = TenantNativeRpcPolicyDescriptorSchema.safeParse(
					row.mountDescriptor,
				);
				if (
					!parsed.success ||
					!row.mountDigest ||
					row.revokedAt ||
					parsed.data.mount.rootAppId !== input.rootAppId ||
					parsed.data.mount.sourceAppId !== input.sourceAppId ||
					parsed.data.mount.sourceToolRowId !== input.sourceToolRowId
				)
					return { candidate: null };
				const decision = await resolveTenantToolPolicyForGateway(context, {
					organizationId: input.organizationId,
					descriptor: parsed.data,
					descriptorDigest: row.mountDigest,
					args: input.args,
				});
				if (
					!decision.matched ||
					!decision.revisionId ||
					!decision.ruleDigest ||
					(!decision.effect && !decision.defaultAsk)
				)
					return { candidate: null };
				return {
					candidate: {
						descriptor: parsed.data,
						descriptorDigest: row.mountDigest,
						revisionId: decision.revisionId,
						ruleDigest: decision.ruleDigest,
						...(decision.effect
							? { effect: decision.effect }
							: { defaultAsk: true as const }),
					},
				};
			},
		),
	resolveMachinePolicyCandidate:
		serviceOs.resolveMachinePolicyCandidate.handler(
			async ({ input, context }) => {
				await assertGatewayOrganization(context, input.organizationId);
				const subjectKeys = await machinePolicySubjectKeys(
					context,
					input.organizationId,
				);
				if (!subjectKeys.length) return { candidate: null };
				const rows = await findTenantToolPolicyCandidatesBySource(context.db, {
					...input,
					subjectKeys,
				});
				const row = uniqueSubjectMount(rows, subjectKeys);
				if (!row) return { candidate: null };
				if (row.revokedAt || !row.mountDigest) return { candidate: null };
				const parsed = TenantToolPolicyMachineDescriptorSchema.safeParse(
					row.mountDescriptor,
				);
				if (
					!parsed.success ||
					parsed.data.mount.rootAppId !== input.rootAppId ||
					parsed.data.mount.sourceAppId !== input.sourceAppId ||
					parsed.data.mount.sourceToolRowId !== input.sourceToolRowId
				)
					return { candidate: null };
				const decision = await resolveTenantToolPolicyForGateway(context, {
					organizationId: input.organizationId,
					descriptor: parsed.data,
					descriptorDigest: row.mountDigest,
					args: input.args,
				});
				if (
					!decision.matched ||
					!decision.revisionId ||
					!decision.ruleDigest ||
					(!decision.effect && !decision.defaultAsk)
				)
					return { candidate: null };
				return {
					candidate: {
						descriptor: parsed.data,
						descriptorDigest: row.mountDigest,
						revisionId: decision.revisionId,
						ruleDigest: decision.ruleDigest,
						...(decision.effect
							? { effect: decision.effect }
							: { defaultAsk: true as const }),
					},
				};
			},
		),
	resolveMachinePolicyDiscovery:
		serviceOs.resolveMachinePolicyDiscovery.handler(
			async ({ input, context }) => {
				await assertGatewayOrganization(context, input.organizationId);
				const subjectKeys = await machinePolicySubjectKeys(
					context,
					input.organizationId,
				);
				if (!subjectKeys.length) return { potential: false };
				const rows = await findTenantToolPolicyCandidatesBySource(context.db, {
					...input,
					subjectKeys,
				});
				const row = uniqueSubjectMount(rows, subjectKeys);
				if (!row) return { potential: false };
				const descriptor = TenantToolPolicyMachineDescriptorSchema.safeParse(
					row.mountDescriptor,
				);
				const set = TenantToolPolicySetSchema.safeParse(row.policySet);
				if (
					!descriptor.success ||
					!set.success ||
					!row.mountDigest ||
					row.revokedAt ||
					descriptor.data.mount.rootAppId !== input.rootAppId ||
					descriptor.data.mount.sourceAppId !== input.sourceAppId ||
					descriptor.data.mount.sourceToolRowId !== input.sourceToolRowId
				)
					return { potential: false };
				const decision = await resolveTenantToolPolicyForGateway(context, {
					organizationId: input.organizationId,
					descriptor: descriptor.data,
					descriptorDigest: row.mountDigest,
					args: {},
				});
				return {
					potential:
						decision.matched &&
						set.data.rules.some(
							({ effect }) =>
								effect.disposition !== "deny" &&
								effect.riskTier === "bounded_write" &&
								effect.blastRadius === "single_resource",
						),
				};
			},
		),
	resolveTenantPolicyDiscovery: serviceOs.resolveTenantPolicyDiscovery.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const fences = await findTenantToolPolicySubjectFences(context.db, {
				organizationId: input.organizationId,
				rootAppId: input.rootAppId,
				mountedToolId: input.mountedToolId,
			});
			if (fences.some((fence) => !fence.subjectKey))
				return { potential: false };
			const [row] = await findTenantToolPolicyRevisions(context.db, {
				organizationId: input.organizationId,
				rootAppId: input.rootAppId,
				mountedToolId: input.mountedToolId,
				subjectKey: JSON.stringify(["user", input.actorUserId]),
			});
			if (
				!row ||
				row.revokedAt ||
				!row.mountDigest ||
				!row.resourceGenerationDigest
			)
				return { potential: false };
			const parsed = TenantToolPolicyProfileDescriptorSchema.safeParse(
				row.mountDescriptor,
			);
			const set = TenantToolPolicySetSchema.safeParse(row.policySet);
			if (
				!parsed.success ||
				!set.success ||
				parsed.data.actorUserId !== input.actorUserId ||
				parsed.data.mount.organizationId !== input.organizationId ||
				parsed.data.mount.rootAppId !== input.rootAppId ||
				parsed.data.mount.mountedToolId !== input.mountedToolId ||
				(await canonicalDigest(parsed.data)) !== row.mountDigest
			)
				return { potential: false };
			const profile = await currentProbeProfile(
				context,
				input.organizationId,
				parsed.data.profileId,
			);
			if (
				!profile ||
				profile.profileDigest !== parsed.data.profileDigest ||
				(await canonicalDigest(profile.mount)) !==
					(await canonicalDigest(parsed.data.mount)) ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					input.actorUserId,
				)) ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					profile.createdBy,
				))
			)
				return { potential: false };
			const tool = await getToolByIdForOrganization(context.db, {
				organizationId: input.organizationId,
				toolId: parsed.data.mount.sourceToolRowId,
			});
			if (
				!tool ||
				!tool.enabled ||
				row.toolRowId !== tool.id ||
				row.appId !== tool.appId ||
				tool.appId !== parsed.data.mount.sourceAppId ||
				(await canonicalDigest(tool)) !== row.toolDigest ||
				(await resourceGenerationDigest(context, parsed.data.mount)) !==
					row.resourceGenerationDigest
			)
				return { potential: false };
			const digest = await canonicalDigest({
				organizationId: row.organizationId,
				appId: row.appId,
				rootAppId: row.rootAppId,
				mountedToolId: row.mountedToolId,
				toolRowId: row.toolRowId,
				toolDigest: row.toolDigest,
				mountDigest: row.mountDigest,
				resourceGenerationDigest: row.resourceGenerationDigest,
				policySet: row.policySet,
			});
			if (digest !== row.ruleDigest) return { potential: false };
			return {
				potential: set.data.rules.some(
					({ effect }) =>
						effect.disposition !== "deny" &&
						effect.riskTier === "bounded_write" &&
						effect.blastRadius === "single_resource",
				),
			};
		},
	),
	prepareProviderIdentityProfile: authOs.prepareProviderIdentityProfile
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can review identity profiles",
				);
			if (
				!(await getAppByIdForOrganization(
					context.db,
					input.rootAppId,
					organizationId,
				))
			)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"App not found in this organization",
				);
			const mount = await profileMount(
				context,
				organizationId,
				input.rootAppId,
				input.mountedToolId,
			);
			const probeMount = await profileMount(
				context,
				organizationId,
				input.rootAppId,
				input.probeMountedToolId,
			);
			if (!sameProfileConnection(mount, probeMount))
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Probe and target do not use the same server and connection",
				);
			const profile = ProviderIdentityProbeProfileSchema.parse({
				version: 1,
				operation: probeMount.upstreamOperation,
				selectors: input.selectors,
			});
			const resourceGenerationDigest = await profileGenerations(
				context,
				mount,
				probeMount,
			);
			const profileDigest = await canonicalDigest({
				organizationId,
				mount,
				probeMount,
				profile,
				safetyAttestation: "safe_empty_probe",
				resourceGenerationDigest,
			});
			const preparationId = crypto.randomUUID();
			const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
			await createProviderIdentityPreparation(context.db, {
				id: preparationId,
				organizationId,
				ownerId: context.userId,
				mount,
				probeMount,
				profile,
				profileDigest,
				resourceGenerationDigest,
				expiresAt,
			});
			return {
				preparationId,
				mount,
				probeMount,
				profile,
				profileDigest,
				expiresAt,
			};
		}),
	createProviderIdentityProfile: authOs.createProviderIdentityProfile
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can review identity profiles",
				);
			const prepared = await consumeProviderIdentityPreparation(context.db, {
				id: input.preparationId,
				organizationId,
				ownerId: context.userId,
				profileDigest: input.expectedProfileDigest,
				now: new Date().toISOString(),
			});
			if (!prepared)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Profile review expired or was already used",
				);
			const mount = ProviderIdentityMountSchema.parse(prepared.mount);
			const probeMount = ProviderIdentityMountSchema.parse(prepared.probeMount);
			const profile = ProviderIdentityProbeProfileSchema.parse(
				prepared.profile,
			);
			const freshMount = await profileMount(
				context,
				organizationId,
				mount.rootAppId,
				mount.mountedToolId,
			);
			const freshProbe = await profileMount(
				context,
				organizationId,
				probeMount.rootAppId,
				probeMount.mountedToolId,
			);
			const generations = await profileGenerations(
				context,
				freshMount,
				freshProbe,
			);
			const digest = await canonicalDigest({
				organizationId,
				mount: freshMount,
				probeMount: freshProbe,
				profile,
				safetyAttestation: input.safetyAttestation,
				resourceGenerationDigest: generations,
			});
			if (
				!sameProfileConnection(freshMount, freshProbe) ||
				profile.operation !== freshProbe.upstreamOperation ||
				digest !== prepared.profileDigest ||
				generations !== prepared.resourceGenerationDigest
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Profile or connection changed since review",
				);
			const row = await createProviderIdentityProfile(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				mount: freshMount,
				probeMount: freshProbe,
				profile,
				safetyAttestation: input.safetyAttestation,
				profileDigest: digest,
				resourceGenerationDigest: generations,
				createdBy: context.userId,
				createdAt: new Date().toISOString(),
			});
			return { profile: ProviderIdentityProfileSchema.parse(row) };
		}),
	listProviderIdentityProfiles: authOs.listProviderIdentityProfiles
		.use(AUTHZ.settingsRead)
		.handler(async ({ context }) => ({
			items: (
				await listProviderIdentityProfiles(context.db, requireOrgId(context))
			).map((row) => ProviderIdentityProfileSchema.parse(row)),
		})),
	revokeProviderIdentityProfile: authOs.revokeProviderIdentityProfile
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can revoke identity profiles",
				);
			const row = await revokeProviderIdentityProfile(context.db, {
				organizationId,
				id: input.id,
				now: new Date().toISOString(),
			});
			if (!row)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Active identity profile not found",
				);
			return { profile: ProviderIdentityProfileSchema.parse(row) };
		}),
	resolveProviderIdentityProfile:
		serviceOs.resolveProviderIdentityProfile.handler(
			async ({ input, context }) => {
				await assertGatewayOrganization(context, input.organizationId);
				const row = await getProviderIdentityProfile(context.db, input);
				if (!row || row.revokedAt) return { profile: null };
				const parsed = ProviderIdentityProfileSchema.safeParse(row);
				if (!parsed.success) return { profile: null };
				const {
					mount,
					probeMount,
					profile,
					safetyAttestation,
					resourceGenerationDigest,
				} = parsed.data;
				const current = await profileGenerations(context, mount, probeMount);
				if (
					!sameProfileConnection(mount, probeMount) ||
					profile.operation !== probeMount.upstreamOperation ||
					current !== resourceGenerationDigest ||
					(await canonicalDigest({
						organizationId: input.organizationId,
						mount,
						probeMount,
						profile,
						safetyAttestation,
						resourceGenerationDigest,
					})) !== row.profileDigest
				)
					return { profile: null };
				return { profile: parsed.data };
			},
		),
	probeProviderIdentityProfile: authOs.probeProviderIdentityProfile
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const result = await probeReviewedProviderIdentity(context, {
				organizationId,
				profileId: input.profileId,
				exampleArgs: input.exampleArgs,
			});
			const resultReceiptId = crypto.randomUUID();
			await createProviderProbeResult(context.db, {
				id: resultReceiptId,
				organizationId,
				actorUserId: context.userId!,
				profileId: result.profile.id,
				profileDigest: result.profile.profileDigest,
				argsDigest: await canonicalDigest(input.exampleArgs),
				accountRevisionDigest: result.accountRevisionDigest,
				expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			});
			return {
				resultReceiptId,
				...(result.credentialSummary
					? { credentialSummary: result.credentialSummary }
					: {}),
			};
		}),
	redeemProviderIdentityProbe: serviceOs.redeemProviderIdentityProbe.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const receipt = await consumeProviderProbeReceipt(context.db, {
				id: input.receiptId,
				organizationId: input.organizationId,
				argsDigest: await canonicalDigest(input.exampleArgs),
				now: new Date().toISOString(),
			});
			if (
				!receipt ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					receipt.actorUserId,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Provider probe authorization expired or was already used",
				);
			const profile = await currentProbeProfile(
				context,
				input.organizationId,
				receipt.profileId,
			);
			if (
				!profile ||
				profile.profileDigest !== receipt.profileDigest ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"The reviewed provider profile changed or was revoked",
				);
			return {
				actorUserId: receipt.actorUserId,
				profileId: profile.id,
				exampleArgs: input.exampleArgs,
				verifiedScopes: ["connections.execute"] as ["connections.execute"],
			};
		},
	),
	recordMachineProviderProbe: serviceOs.recordMachineProviderProbe.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			if (
				context.authType !== "service-binding" ||
				context.externalAgentPrincipalId !== input.principalId ||
				context.externalAgentSessionId !== input.sessionId ||
				context.externalAgentClientRecordId !== input.clientRecordId
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine proof must match the gateway-verified caller",
				);
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId: input.organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					clientRecordId: input.clientRecordId,
					now: new Date().toISOString(),
				},
			);
			const profile = await currentProbeProfile(
				context,
				input.organizationId,
				input.profileId,
			);
			if (
				!active ||
				active.credential.mcpServerId !== input.mcpServerId ||
				!profile ||
				profile.profileDigest !== input.profileDigest ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine session or reviewed profile is unavailable",
				);
			const receiptId = crypto.randomUUID();
			await createMachineProviderProbeResult(context.db, {
				id: receiptId,
				organizationId: input.organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				clientRecordId: input.clientRecordId,
				clientId: input.clientId,
				mcpServerId: input.mcpServerId,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				argsDigest: await canonicalDigest(input.exampleArgs),
				accountRevisionDigest: input.accountRevisionDigest,
				expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			});
			return { receiptId };
		},
	),
	listMachinePolicyInventory: authOs.listMachinePolicyInventory
		.use(AUTHZ.settingsWrite)
		.handler(async ({ context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				context.user?.sub !== context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an active owner or admin can review machine sessions",
				);
			const now = new Date().toISOString();
			const candidates = await listMachinePolicyInventoryCandidates(
				context.db,
				{ organizationId, now },
			);
			const checked = await Promise.all(
				candidates.map(async (candidate) =>
					resolveAuthorizedExternalAgentMcpSession(context.db, {
						organizationId,
						...candidate,
						now,
					}),
				),
			);
			return {
				items: checked.flatMap((entry) =>
					entry
						? [
								{
									principalId: entry.principal.id,
									principalName:
										entry.principal.displayName || entry.principal.id,
									sessionId: entry.session.id,
									clientRecordId: entry.credential.clientRecordId,
									mcpServerId: entry.credential.mcpServerId,
								},
							]
						: [],
				),
			};
		}),
	listMachineProviderProbes: authOs.listMachineProviderProbes
		.use(AUTHZ.settingsWrite)
		.handler(async ({ context }) => {
			const organizationId = requireOrgId(context);
			if (
				context.authType !== "user" ||
				!context.userId ||
				context.user?.sub !== context.userId ||
				!(await isActiveOwnerOrAdmin(context, organizationId, context.userId))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an organization owner or admin can review machine proofs",
				);
			const rows = await listMachineProviderProbeResults(context.db, {
				organizationId,
				now: new Date().toISOString(),
			});
			return {
				items: rows.map(
					({
						id,
						profileId,
						principalId,
						sessionId,
						clientRecordId,
						expiresAt,
					}) => ({
						id,
						profileId,
						principalId,
						sessionId,
						clientRecordId,
						expiresAt,
					}),
				),
			};
		}),
	prepareMachineIdentityProbe: serviceOs.prepareMachineIdentityProbe.handler(
		async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const principalId = context.externalAgentPrincipalId,
				sessionId = context.externalAgentSessionId,
				clientRecordId = context.externalAgentClientRecordId;
			const clientId = context.headers.get(
					"X-Tedix-External-Agent-OAuth-Client-Id",
				),
				mcpServerId = context.headers.get(
					"X-Tedix-External-Agent-Mcp-Server-Id",
				);
			if (
				context.authType !== "service-binding" ||
				context.serviceBindingAuthorization?.source !== "mcp-tool" ||
				!principalId ||
				!sessionId ||
				!clientRecordId ||
				!clientId ||
				!mcpServerId ||
				clientId.length > 300 ||
				mcpServerId.length > 300 ||
				!context.tediScopes?.includes("connections.execute")
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"A verified machine tool caller with connections.execute is required",
				);
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId,
					principalId,
					sessionId,
					clientRecordId,
					now: new Date().toISOString(),
				},
			);
			const profile = await currentProbeProfile(
				context,
				organizationId,
				input.profileId,
			);
			if (
				!active ||
				active.credential.mcpServerId !== mcpServerId ||
				!profile ||
				!(await isActiveOwnerOrAdmin(
					context,
					organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine session or reviewed profile is unavailable",
				);
			const receiptId = crypto.randomUUID();
			await createMachineProviderProbeAuthorization(context.db, {
				id: receiptId,
				organizationId,
				principalId,
				sessionId,
				clientRecordId,
				clientId,
				mcpServerId,
				profileId: profile.id,
				profileDigest: profile.profileDigest,
				argsDigest: await canonicalDigest(input.exampleArgs),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			});
			const response = await context.env.MCP_SERVICE.fetch(
				new Request(
					"https://mcp.internal/_internal/tenant-tool-policy/probe-machine",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify({
							organizationId,
							receiptId,
							exampleArgs: input.exampleArgs,
						}),
					},
				),
			);
			if (!response.ok)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"The machine identity could not be verified",
				);
			const result = (await response.json()) as { receiptId?: unknown };
			if (
				typeof result.receiptId !== "string" ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					result.receiptId,
				)
			)
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"The machine identity could not be verified",
				);
			return { receiptId: result.receiptId };
		},
	),
	redeemMachineIdentityProbe: serviceOs.redeemMachineIdentityProbe.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const receipt = await consumeMachineProviderProbeAuthorization(
				context.db,
				{
					id: input.receiptId,
					organizationId: input.organizationId,
					argsDigest: await canonicalDigest(input.exampleArgs),
					now: new Date().toISOString(),
				},
			);
			if (!receipt)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine probe authorization expired or was already used",
				);
			const active = await resolveAuthorizedExternalAgentMcpSession(
				context.db,
				{
					organizationId: input.organizationId,
					principalId: receipt.principalId,
					sessionId: receipt.sessionId,
					clientRecordId: receipt.clientRecordId,
					now: new Date().toISOString(),
				},
			);
			const profile = await currentProbeProfile(
				context,
				input.organizationId,
				receipt.profileId,
			);
			if (
				!active ||
				active.credential.mcpServerId !== receipt.mcpServerId ||
				!profile ||
				profile.profileDigest !== receipt.profileDigest ||
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					profile.createdBy,
				))
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Machine session or reviewed profile changed",
				);
			return {
				principalId: receipt.principalId,
				sessionId: receipt.sessionId,
				clientRecordId: receipt.clientRecordId,
				clientId: receipt.clientId,
				mcpServerId: receipt.mcpServerId,
				profileId: receipt.profileId,
				exampleArgs: input.exampleArgs,
			};
		},
	),
	resolveWorkItemAuthorization: serviceOs.resolveWorkItemAuthorization.handler(
		async ({ input, context }) => {
			return resolveWorkItemAuthorization(context.db, {
				...input,
				authorizationSigningSecret: context.env.SECRETS_MASTER_KEY,
			});
		},
	),
	latchRunSensitiveData: serviceOs.latchRunSensitiveData.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			const db = context.db;
			const reason = input.source.toolDeclaredSensitive
				? "tool_declared_sensitive"
				: input.source.connectionProviderId &&
					  (await isConnectionProviderRestricted(db, {
							organizationId: input.organizationId,
							providerId: input.source.connectionProviderId,
					  }))
					? "connection_restricted"
					: null;
			if (!reason)
				return getRunSensitiveDataLatch(db, {
					organizationId: input.organizationId,
					runRef: input.runRef,
				});
			return latchRunSensitiveData(db, {
				organizationId: input.organizationId,
				runRef: input.runRef,
				latch: {
					version: 1,
					latchedAt: new Date().toISOString(),
					source: {
						appSlug: input.source.appSlug,
						toolId: input.source.toolId,
						connectionProviderId: input.source.connectionProviderId,
						reason,
					},
				},
			});
		},
	),
	resolveRunSensitiveDataLatch: serviceOs.resolveRunSensitiveDataLatch.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			return getRunSensitiveDataLatch(context.db, {
				organizationId: input.organizationId,
				runRef: input.runRef,
			});
		},
	),
	resolveConnectionSensitivity: serviceOs.resolveConnectionSensitivity.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			return {
				restricted: await isConnectionProviderRestricted(context.db, {
					organizationId: input.organizationId,
					providerId: input.connectionProviderId,
				}),
			};
		},
	),
});
