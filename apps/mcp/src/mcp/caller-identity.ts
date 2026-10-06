export type CallerAuthType =
	| "user"
	| "m2m"
	| "tedi"
	| "service"
	| "apiKey"
	| "oauth"
	| "external_agent"
	| "anonymous";

export type DelegationMode =
	| "agent"
	| "human_to_tedi"
	| "machine_to_machine"
	| "kernel"
	| CallerAuthType;

export interface CallerIdentity {
	authType: CallerAuthType;
	userId?: string;
	organizationId?: string;
	email?: string;
	clientId?: string;
	tediId?: string;
	externalAgentPrincipalId?: string;
	externalAgentSessionId?: string;
	externalAgentClientRecordId?: string;
	externalAgentHarness?: string;
	externalAgentModel?: string;
	credentialMode?: string;
	scopes?: string[];
	skillRunId?: string;
	skillRunCreatedBy?: string;
	skillId?: string;
	/** Trusted skill-workflow execution provenance. These fields are accepted
	 * only from the post-auth service-binding rewrite in apps/mcp/src/index.ts. */
	workflowStepId?: string;
	workflowStepName?: string;
	workflowStepCount?: number;
	workflowStepAttempt?: number;
	workflowExecutionEpoch?: number;
	workflowCallId?: string;
	workflowIdempotencyKey?: string;
	forceCodeMode?: boolean;
	/** Server-verified current grant; never parsed from client-provided headers. */
	verifiedMultiOrgOrganizations?: Array<{
		organizationId: string;
		descopeTenantId: string;
		gatewaySlug: string;
	}>;
	/**
	 * Kernel marker (docs/product/tedix-os.md Phase 2 audit contract): the call is a tenant
	 * control-plane action ("Home used a tool for this turn"), not a generic
	 * internal worker. Set only from the trusted service-binding auth path
	 * (apps/api kernel sends X-Tedix-Kernel; apps/mcp re-emits it as
	 * x-tedix-auth-kernel after validateAuth). `userId` stays the
	 * initiating human (acting user); `tediId` stays absent — no fake tedi
	 * identity.
	 */
	kernel?: boolean;
}

export function shouldBypassCodeModeForCaller(
	caller:
		| Pick<CallerIdentity, "authType" | "credentialMode" | "forceCodeMode">
		| undefined,
	requestedToolName?: string,
): boolean {
	if (caller?.forceCodeMode) return false;
	const isProgrammaticCaller =
		caller?.authType === "service" || caller?.credentialMode === "aih-m2m";
	if (!isProgrammaticCaller) return false;

	// Programmatic callers should only bypass the compact Code Mode surface when
	// they are making a known direct tool call. Session init/tools/list on large
	// aggregate apps must stay compact, and outer Code Mode tools must stay
	// routable even when the caller arrived through a service-binding bridge.
	if (!requestedToolName) return false;
	return requestedToolName !== "code";
}

export interface NormalizedCallerIdentity {
	authType: CallerAuthType;
	actorId: string;
	actorType:
		| "user"
		| "service"
		| "tedi"
		| "m2m"
		| "external_agent"
		| "anonymous"
		| "kernel";
	delegationMode: DelegationMode;
	subjectUserId?: string;
	agentTediId?: string;
	externalAgentPrincipalId?: string;
	externalAgentSessionId?: string;
	externalAgentClientRecordId?: string;
	externalAgentHarness?: string;
	externalAgentModel?: string;
	oauthClientId?: string;
	organizationId?: string;
	email?: string;
	grantedScopeCount: number;
	scopes: string[];
	skillRunId?: string;
	skillRunCreatedBy?: string;
	skillId?: string;
	workflowStepId?: string;
	workflowStepName?: string;
	workflowStepCount?: number;
	workflowStepAttempt?: number;
	workflowExecutionEpoch?: number;
	workflowCallId?: string;
	workflowIdempotencyKey?: string;
	forceCodeMode?: boolean;
}

function resolveDelegationMode(caller: CallerIdentity): DelegationMode {
	if (caller.authType === "tedi") return "agent";
	if (caller.authType === "oauth" && caller.tediId) return "human_to_tedi";
	if (caller.authType === "m2m") return "machine_to_machine";
	if (caller.authType === "external_agent") return "machine_to_machine";
	if (caller.authType === "service" && caller.kernel) {
		return "kernel";
	}
	return caller.authType;
}

function resolveActor(caller: CallerIdentity): {
	actorId: string;
	actorType: NormalizedCallerIdentity["actorType"];
} {
	if (caller.authType === "tedi") {
		return {
			actorId: caller.tediId ?? caller.userId ?? caller.clientId ?? "tedi",
			actorType: "tedi",
		};
	}

	if (caller.authType === "m2m") {
		return {
			actorId: caller.userId ?? caller.clientId ?? "m2m",
			actorType: "m2m",
		};
	}

	if (caller.authType === "external_agent") {
		return {
			actorId: caller.externalAgentPrincipalId ?? "external_agent",
			actorType: "external_agent",
		};
	}

	if (caller.authType === "service") {
		if (caller.kernel) {
			// Tenant control-plane actor (kernel). actorId stays the acting
			// human when present — "Home acted for this user" — and falls back to
			// the literal kernel actor when no human initiated the turn.
			return {
				actorId: caller.userId ?? "kernel",
				actorType: "kernel",
			};
		}
		return {
			actorId: caller.userId ?? caller.clientId ?? "service",
			actorType: "service",
		};
	}

	if (caller.authType === "anonymous") {
		return { actorId: "anonymous", actorType: "anonymous" };
	}

	return {
		actorId: caller.userId ?? caller.clientId ?? "user",
		actorType: "user",
	};
}

export function normalizeCallerIdentity(
	caller: CallerIdentity,
): NormalizedCallerIdentity {
	const actor = resolveActor(caller);
	const scopes = caller.scopes ?? [];
	return {
		authType: caller.authType,
		...actor,
		delegationMode: resolveDelegationMode(caller),
		subjectUserId: caller.authType === "tedi" ? undefined : caller.userId,
		agentTediId: caller.tediId,
		externalAgentPrincipalId: caller.externalAgentPrincipalId,
		externalAgentSessionId: caller.externalAgentSessionId,
		externalAgentClientRecordId: caller.externalAgentClientRecordId,
		externalAgentHarness: caller.externalAgentHarness,
		externalAgentModel: caller.externalAgentModel,
		oauthClientId: caller.clientId,
		organizationId: caller.organizationId,
		email: caller.email,
		grantedScopeCount: scopes.length,
		scopes,
		skillRunId: caller.skillRunId,
		skillRunCreatedBy: caller.skillRunCreatedBy,
		skillId: caller.skillId,
		workflowStepId: caller.workflowStepId,
		workflowStepName: caller.workflowStepName,
		workflowStepCount: caller.workflowStepCount,
		workflowStepAttempt: caller.workflowStepAttempt,
		workflowExecutionEpoch: caller.workflowExecutionEpoch,
		workflowCallId: caller.workflowCallId,
		workflowIdempotencyKey: caller.workflowIdempotencyKey,
		forceCodeMode: caller.forceCodeMode,
	};
}

export function buildCallerAuditMetadata(
	caller: CallerIdentity | undefined,
): Record<string, string | number | boolean> | undefined {
	if (!caller) return undefined;

	const normalized = normalizeCallerIdentity(caller);
	const metadata: Record<string, string | number | boolean> = {
		delegationMode: normalized.delegationMode,
		grantedScopeCount: normalized.grantedScopeCount,
	};
	if (normalized.agentTediId) metadata.agentTediId = normalized.agentTediId;
	if (normalized.externalAgentPrincipalId) {
		metadata.externalAgentPrincipalId = normalized.externalAgentPrincipalId;
	}
	if (normalized.externalAgentSessionId) {
		metadata.externalAgentSessionId = normalized.externalAgentSessionId;
	}
	if (normalized.externalAgentClientRecordId) {
		metadata.externalAgentClientRecordId =
			normalized.externalAgentClientRecordId;
	}
	if (normalized.externalAgentHarness) {
		metadata.externalAgentHarness = normalized.externalAgentHarness;
	}
	if (normalized.externalAgentModel) {
		metadata.externalAgentModel = normalized.externalAgentModel;
	}
	if (normalized.subjectUserId) {
		metadata.subjectUserId = normalized.subjectUserId;
	}
	if (normalized.oauthClientId) {
		metadata.oauthClientId = normalized.oauthClientId;
	}
	if (caller.credentialMode) metadata.credentialMode = caller.credentialMode;
	if (normalized.skillRunId) metadata.skillRunId = normalized.skillRunId;
	if (normalized.skillId) metadata.skillId = normalized.skillId;
	if (normalized.workflowStepId) {
		metadata.workflowStepId = normalized.workflowStepId;
	}
	if (normalized.workflowStepName) {
		metadata.workflowStepName = normalized.workflowStepName;
	}
	if (normalized.workflowStepCount !== undefined) {
		metadata.workflowStepCount = normalized.workflowStepCount;
	}
	if (normalized.workflowStepAttempt !== undefined) {
		metadata.workflowStepAttempt = normalized.workflowStepAttempt;
	}
	if (normalized.workflowExecutionEpoch !== undefined) {
		metadata.workflowExecutionEpoch = normalized.workflowExecutionEpoch;
	}
	if (normalized.workflowCallId) {
		metadata.workflowCallId = normalized.workflowCallId;
	}
	if (normalized.workflowIdempotencyKey) {
		metadata.workflowIdempotencyKey = normalized.workflowIdempotencyKey;
	}

	return metadata;
}
