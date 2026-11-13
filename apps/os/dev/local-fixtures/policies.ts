/** Sample cases and offline tenant tool policy rows. */

import organizationAutonomy from "@tedix/api-contract/assets/organization-autonomy.v1.json";
import { fid, ORG_ID, RpcError, T0 } from "./core";
import { SCHEDULES, SKILLS } from "./tedis";

// ---------------------------------------------------------------------------
// Per-procedure handlers
// ---------------------------------------------------------------------------

/** Fictional work streams (cases) on the first project. */
export function localCases() {
	return [
		{
			n: 1,
			title: "Maple Books delivery investigation",
			stage: "investigating",
		},
		{ n: 2, title: "Willow Studio workshop preparation", stage: "planning" },
	].map(({ n, title, stage }) => ({
		id: fid("b1", n),
		orgId: ORG_ID,
		projectId: fid("76", 1),
		objectiveId: null,
		kind: "other",
		title,
		description: "A fictional customer matter for local review.",
		stage,
		accountableOwnerType: "user",
		accountableOwnerId: "dev-operator",
		openedAt: T0,
		targetResolutionAt: null,
		closedAt: null,
		createdAt: T0,
		updatedAt: null,
		version: 1,
	}));
}

/** Tasks attached to, and dependencies between, the local work streams. */
export const LOCAL_CASE_ITEMS: Array<{
	id: string;
	orgId: string;
	caseId: string;
	workItemId: string;
	rationale: string | null;
	discoveredAt: string;
}> = [];
export const LOCAL_CASE_EDGES: Array<{
	id: string;
	orgId: string;
	fromCaseId: string;
	toCaseId: string;
	createdAt: string;
}> = [];

// Offline examples only: these rows do not authorize or contact a provider.
export const LOCAL_POLICY_UUID = "00000000-0000-4000-8000-000000000001";
export const LOCAL_POLICY_DIGEST = "a".repeat(64);
export const localPolicyExpiry = "2099-01-01T00:00:00.000Z";
export const localRawMount = {
	version: 1 as const,
	organizationId: "local-org",
	rootAppId: "local-app",
	mountAppIds: ["local-app"],
	sourceAppId: "local-app",
	sourceToolRowId: "local-tool",
	sourceToolId: "edit",
	mountedToolId: "edit",
	transport: "mcp" as const,
	upstreamOperation: "edit",
	providerId: "sample",
	connectionInstanceId: "local-account",
	credentialScope: "tenant" as const,
	requestedScopes: [],
	effectiveToolDigest: LOCAL_POLICY_DIGEST,
};
export const localProfileMount = {
	version: 1 as const,
	organizationId: "local-org",
	rootAppId: "local-app",
	mountAppIds: ["local-app"],
	sourceAppId: "local-app",
	sourceToolRowId: "local-tool",
	sourceToolId: "edit",
	mountedToolId: "edit",
	transport: "mcp" as const,
	upstreamOperation: "edit",
	endpointDigest: LOCAL_POLICY_DIGEST,
	effectiveToolDigest: LOCAL_POLICY_DIGEST,
	authBindingDigest: LOCAL_POLICY_DIGEST,
	acceptsEmptyArguments: true,
	providerId: "sample",
	connectionScope: "tenant" as const,
	requestedScopes: [],
};
export const localProbe = {
	version: 1 as const,
	operation: "identity",
	selectors: [["id"]],
};
export const localProfile = {
	id: LOCAL_POLICY_UUID,
	organizationId: "local-org",
	mount: localProfileMount,
	probeMount: {
		...localProfileMount,
		mountedToolId: "identity",
		sourceToolId: "identity",
		upstreamOperation: "identity",
	},
	profile: localProbe,
	safetyAttestation: "safe_empty_probe" as const,
	profileDigest: LOCAL_POLICY_DIGEST,
	resourceGenerationDigest: LOCAL_POLICY_DIGEST,
	createdBy: "local-owner",
	createdAt: T0,
	revokedAt: null as string | null,
};
const localPredicate = {
	version: 1 as const,
	schema: {
		type: "object",
		properties: {},
		required: [],
		additionalProperties: false,
	},
};
const localEffect = {
	disposition: "ask",
	riskTier: "bounded_write",
	blastRadius: "single_resource",
};
export const localPolicySet = {
	evaluatorVersion: 1,
	defaultDisposition: "ask",
	rules: [{ id: "local", predicate: localPredicate, effect: localEffect }],
};
export const localPolicy = {
	id: LOCAL_POLICY_UUID,
	organizationId: "local-org",
	appId: "local-app",
	toolRowId: "local-tool",
	toolDigest: LOCAL_POLICY_DIGEST,
	ruleDigest: LOCAL_POLICY_DIGEST,
	mountDescriptor: {
		...localRawMount,
		accountRevisionDigest: LOCAL_POLICY_DIGEST,
	},
	mountDigest: LOCAL_POLICY_DIGEST,
	predicate: localPredicate,
	effect: localEffect,
	policySet: localPolicySet,
	createdBy: "local-owner",
	createdAt: T0,
	revokedAt: null as string | null,
};
export let localPolicyRows: (typeof localPolicy)[] = [];

export function setLocalPolicyRows(value: typeof localPolicyRows): void {
	localPolicyRows = value;
}

export let localProfileRows: (typeof localProfile)[] = [];

export function setLocalProfileRows(value: typeof localProfileRows): void {
	localProfileRows = value;
}

export const localPreparation = (descriptor: unknown) => ({
	preparationId: LOCAL_POLICY_UUID,
	descriptor,
	descriptorDigest: LOCAL_POLICY_DIGEST,
	expiresAt: localPolicyExpiry,
});
export function fixtureScheduleControl(
	input: { id: string },
	action: "paused" | "resumed",
) {
	const row = SCHEDULES.find((schedule) => schedule.skillId === input.id);
	if (!row) throw new RpcError("NOT_FOUND", "Skill has no schedule");
	const enabled = action === "resumed";
	const changed = row.enabled !== enabled;
	row.enabled = enabled;
	return {
		skillId: row.skillId,
		slug: SKILLS.find((skill) => skill.id === row.skillId)?.slug ?? null,
		action,
		changed,
		scheduleEnabled: row.enabled,
		nextFireAt: row.enabled ? row.nextFireAt : null,
	};
}

export function localAutoApproval() {
	return {
		groups: organizationAutonomy.operations.map(({ id, label }) => ({
			id,
			label,
			enabled: true,
		})),
		addedTools: [],
		removedTools: [],
	};
}
