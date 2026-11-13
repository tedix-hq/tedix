/**
 * Local fixture handlers: Organization, member, user setting, web push and
 * MCP governance procedures.
 */

import type { Organization } from "@tedix/api-contract/schemas/organization";
import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import {
	localApiKeys,
	localSuspendedAgentSeats,
	ORG_MEMBERSHIP,
	TEAM_MEMBERS,
} from "./apps";
import {
	DEFAULT_LOCAL_PREFERENCES,
	fid,
	now,
	ORG_ID,
	RpcError,
	T0,
	T1,
	T3,
	T4,
} from "./core";
import { paginate, type Pagination } from "./lookups";
import {
	LOCAL_POLICY_DIGEST,
	LOCAL_POLICY_UUID,
	localAutoApproval,
	localPolicy,
	localPolicyExpiry,
	localPolicyRows,
	localPolicySet,
	localPreparation,
	localProbe,
	localProfile,
	localProfileMount,
	localProfileRows,
	localRawMount,
	setLocalPolicyRows,
	setLocalProfileRows,
} from "./policies";
import { localCustomDomain, setLocalCustomDomain } from "./sharing";
import { state } from "./state";

export const organizationHandlers: Record<string, (input: never) => unknown> = {
	"mcpGovernance/listTenantToolPolicies": () => ({ items: localPolicyRows }),
	"mcpGovernance/listDeletedTenantPolicyFences": () => ({ items: [] }),
	"mcpGovernance/listLegacyActionTypeInventory": () => ({
		grants: [],
		tools: [],
		truncated: false,
	}),
	"mcpGovernance/getOrganizationAutoApproval": () => localAutoApproval(),
	"mcpGovernance/setOrganizationAutoApproval": () => localAutoApproval(),
	"mcpGovernance/listMachinePolicyInventory": () => ({ items: [] }),
	"mcpGovernance/listMachineProviderProbes": () => ({ items: [] }),
	"mcpGovernance/listProviderIdentityProfiles": () => ({
		items: localProfileRows,
	}),
	"mcpGovernance/prepareTenantToolPolicy": () =>
		localPreparation({
			...localRawMount,
			accountRevisionDigest: LOCAL_POLICY_DIGEST,
		}),
	"mcpGovernance/prepareHybridTenantToolPolicy": () =>
		localPreparation({
			kind: "profile",
			mount: localProfileMount,
			profileId: LOCAL_POLICY_UUID,
			profileDigest: LOCAL_POLICY_DIGEST,
			actorUserId: "local-owner",
			accountRevisionDigest: LOCAL_POLICY_DIGEST,
		}),
	"mcpGovernance/prepareMachineTenantToolPolicy": () =>
		localPreparation({
			kind: "machine",
			mount: localProfileMount,
			profileId: LOCAL_POLICY_UUID,
			profileDigest: LOCAL_POLICY_DIGEST,
			ownerUserId: "local-owner",
			subject: {
				scope: "principal",
				principalId: "local-agent",
				mcpServerId: "local-server",
			},
			credentialScope: "tenant",
			accountRevisionDigest: LOCAL_POLICY_DIGEST,
		}),
	"mcpGovernance/prepareNativeRpcPolicy": () =>
		localPreparation({
			kind: "native_rpc",
			mount: {
				version: 1,
				organizationId: "local-org",
				rootAppId: "local-app",
				mountAppIds: ["local-app"],
				sourceAppId: "local-app",
				sourceToolRowId: "local-tool",
				sourceToolId: "edit",
				mountedToolId: "edit",
				transport: "rpc",
				endpoint: "local/edit",
				effectiveToolDigest: LOCAL_POLICY_DIGEST,
			},
			ownerUserId: "local-owner",
			subject: {
				scope: "principal",
				principalId: "local-agent",
				mcpServerId: "local-server",
			},
			reviewSessionId: "local-session",
			reviewClientRecordId: "local-client",
		}),
	"mcpGovernance/createTenantToolPolicy": (input: {
		policySet: typeof localPolicySet;
	}) => {
		const policy = {
			...localPolicy,
			policySet: input.policySet,
			predicate: input.policySet.rules[0]!.predicate,
			effect: input.policySet.rules[0]!.effect,
		};
		setLocalPolicyRows([policy]);
		return { policy };
	},
	"mcpGovernance/revokeTenantToolPolicy": () => {
		const policy = { ...localPolicy, revokedAt: T0 };
		setLocalPolicyRows([policy]);
		return { policy };
	},
	"mcpGovernance/prepareProviderIdentityProfile": () => ({
		preparationId: LOCAL_POLICY_UUID,
		mount: localProfile.mount,
		probeMount: localProfile.probeMount,
		profile: localProbe,
		profileDigest: LOCAL_POLICY_DIGEST,
		expiresAt: localPolicyExpiry,
	}),
	"mcpGovernance/createProviderIdentityProfile": () => {
		setLocalProfileRows([localProfile]);
		return { profile: localProfile };
	},
	"mcpGovernance/revokeProviderIdentityProfile": () => {
		const profile = { ...localProfile, revokedAt: T0 };
		setLocalProfileRows([profile]);
		return { profile };
	},
	"mcpGovernance/probeProviderIdentityProfile": () => ({
		resultReceiptId: LOCAL_POLICY_UUID,
	}),
	"mcpGovernance/setActionTypeOptIn": (input: {
		actionType: string;
		enabled: boolean;
	}) => ({ actionType: input.actionType, enabled: input.enabled, optIn: null }),
	"support/mine": () => ({ items: [], canReview: false }),

	// --- team ---
	"members/listMembers": (input: Pagination | undefined) =>
		paginate(
			TEAM_MEMBERS.map((member) =>
				localSuspendedAgentSeats.has(member.id)
					? { ...member, status: "deactivated" as const }
					: member,
			),
			input,
		),
	"members/suspendAgentSeat": (input: {
		organizationId: string;
		memberId: string;
	}) => {
		const member = TEAM_MEMBERS.find(
			(row) =>
				row.id === input.memberId &&
				row.organizationId === input.organizationId,
		);
		if (
			!member ||
			!("kind" in member) ||
			member.kind !== "browser_agent" ||
			member.role !== "member"
		)
			throw new RpcError(
				"FORBIDDEN",
				"No browser agent seat managed by this person",
			);
		localSuspendedAgentSeats.add(member.id);
		return { data: { ...member, status: "deactivated" as const } };
	},
	// The admission gate the budget-pause surface reads: an active entitlement
	// with a daily token/spend policy, which is exactly what makes a background
	// schedule's fire get denied without any run ever failing.
	"runtimeEntitlements/get": () => ({
		entitlement: {
			planKey: "growth",
			planName: "Growth",
			status: "active" as const,
			periodStart: "2026-08-01T00:00:00.000Z",
			periodEnd: "2026-09-01T00:00:00.000Z",
			active: true,
			settlementMode: "managed" as const,
			source: "managed-plan" as const,
			version: 4,
		},
		modelPolicy: {
			allowedModelTiers: ["economy" as const, "balanced" as const],
			dailyTokenLimit: 5_000_000,
			dailySpendLimitMicros: 25_000_000,
		},
	}),

	// --- launcher / apps ---
	// Fixture mode never provisions a real browser subscription.
	"webPush/getStatus": () => ({
		enabled: false,
		publicKey: null,
		preferences: {
			mutedProjectIds: state.pushMutedProjectIds,
			mutedWorkspaceIds: state.pushMutedWorkspaceIds,
		},
	}),
	"webPush/subscribe": () => ({ enabled: false }),
	"webPush/unsubscribe": () => ({ ok: true }),
	"webPush/setVisibility": () => ({ ok: true }),
	"webPush/setPreferences": (input: {
		mutedProjectIds: string[];
		mutedWorkspaceIds?: string[];
	}) => {
		state.pushMutedProjectIds = input.mutedProjectIds;
		if (input.mutedWorkspaceIds !== undefined)
			state.pushMutedWorkspaceIds = input.mutedWorkspaceIds;
		return {
			mutedProjectIds: state.pushMutedProjectIds,
			mutedWorkspaceIds: state.pushMutedWorkspaceIds,
		};
	},
	// --- per-user OS settings ---
	// Unset reads report the platform defaults at revision 0 so the surface can
	// tell "never saved" from "saved with default values"; the write is a real
	// compare-and-swap, so a stale revision 409s here exactly as it does in D1.
	"userSettings/getPreferences": () =>
		state.userPreferences
			? {
					preferences: state.userPreferences.value,
					source: "stored" as const,
					revision: state.userPreferences.revision,
					updatedAt: state.userPreferences.updatedAt,
				}
			: {
					preferences: DEFAULT_LOCAL_PREFERENCES,
					source: "default" as const,
					revision: 0,
					updatedAt: null,
				},
	"userSettings/updatePreferences": (input: {
		preferences: OsUserPreferences;
		expectedRevision: number;
	}) => {
		const current = state.userPreferences?.revision ?? 0;
		if (input.expectedRevision !== current) {
			throw new RpcError(
				"CONFLICT",
				"Preference revision compare-and-swap lost against a concurrent write",
				{
					expectedRevision: input.expectedRevision,
					currentRevision: state.userPreferences?.revision ?? null,
				},
			);
		}
		state.userPreferences = {
			value: input.preferences,
			revision: current + 1,
			updatedAt: now(),
		};
		return {
			preferences: state.userPreferences.value,
			source: "stored" as const,
			revision: state.userPreferences.revision,
			updatedAt: state.userPreferences.updatedAt,
		};
	},
	"userSettings/getContext": () => ({
		organization: {
			id: ORG_ID,
			name: ORG_MEMBERSHIP.organizationName,
			slug: ORG_MEMBERSHIP.organizationSlug,
			type: ORG_MEMBERSHIP.organizationType,
			descopeTenantId: state.organization.descopeTenantId,
			logoUrl: ORG_MEMBERSHIP.organizationLogoUrl,
			appearance: state.organization.metadata?.osTheme ?? null,
		},
		authority: {
			authType: "user" as const,
			role: ORG_MEMBERSHIP.member.role,
			// The owner grant from ROLE_PERMISSION_GRANTS, so the local lane shows
			// the same authority the real projection computes for an owner.
			permissions: [
				"apps:read",
				"tedis:read",
				"team:read",
				"analytics:read",
				"apps:create",
				"apps:update",
				"apps:delete",
				"tedis:create",
				"tedis:update",
				"tedis:delete",
				"secrets:manage",
				"integrations:manage",
				"api_keys:manage",
				"team:manage",
				"billing:read",
				"settings:manage",
				"os:read",
				"os:author",
				"os:run",
				"os:publish",
				"os:approve",
				"os:admin",
				"billing:manage",
			] as const,
			machineScopes: [],
			crossTenantOverrideActive: false,
		},
		purpose: {
			access: "granted" as const,
			charter: {
				id: fid("95", 1),
				version: 3,
				status: "active" as const,
				activatedAt: T1,
				reviewCadenceDays: 30,
				reviewDueAt: new Date(Date.parse(T1) + 30 * 86_400_000).toISOString(),
			},
		},
	}),
	"userSettings/getBrowserMcpAuthorization": () => ({
		policyVersion: 1 as const,
		scopes: [
			"mcp:tedis.read",
			"mcp:tedis.write",
			"mcp:apps.read",
			"mcp:apps.write",
			"mcp:memory.read",
			"mcp:memory.write",
			"mcp:memory.admin",
			"mcp:skills.read",
			"mcp:skills.write",
			"mcp:content.read",
			"mcp:content.write",
			"mcp:catalog.read",
			"mcp:catalog.write",
			"mcp:observe.read",
			"mcp:messaging.read",
			"mcp:messaging.write",
			"mcp:settings.read",
			"mcp:settings.write",
			"mcp:settings.admin",
			"mcp:work.read",
			"mcp:work.write",
			"mcp:work.admin",
		],
	}),
	"organizations/listAllMine": () => paginate([ORG_MEMBERSHIP]),
	"organizations/listOsMine": () =>
		paginate([
			{
				organizationId: ORG_MEMBERSHIP.organizationId,
				organizationName: ORG_MEMBERSHIP.organizationName,
				organizationSlug: ORG_MEMBERSHIP.organizationSlug,
				organizationLogoUrl: ORG_MEMBERSHIP.organizationLogoUrl,
			},
		]),
	"organizations/getMyOrganization": () => ({
		organization: state.organization,
		member: ORG_MEMBERSHIP.member,
		created: { organization: false, member: false },
	}),
	"organizations/getCustomDomain": () => localCustomDomain,
	// Sample data never checks DNS: a domain stays pending until it is removed.
	"organizations/beginCustomDomain": (input: { hostname: string }) => {
		const hostname = input.hostname.trim().toLowerCase();
		const txtName = `_tedix-challenge.${hostname}`;
		const txtValue = "tedix-verify-sample";
		const cnameTarget = "sites.tedix.example";
		setLocalCustomDomain({
			claimId: crypto.randomUUID(),
			hostname,
			status: "pending",
			txtName,
			txtValue,
			cnameTarget,
			expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
			validationRecords: [
				{ type: "TXT", name: txtName, value: txtValue },
				{ type: "CNAME", name: hostname, value: cnameTarget },
			],
		});
		return localCustomDomain;
	},
	"organizations/verifyCustomDomain": (input: { claimId: string }) => {
		if (localCustomDomain?.claimId !== input.claimId)
			throw new RpcError("NOT_FOUND", "Domain not found");
		return localCustomDomain;
	},
	"organizations/removeCustomDomain": (input: { claimId: string }) => {
		if (localCustomDomain?.claimId === input.claimId)
			setLocalCustomDomain(null);
		return { success: true };
	},
	"organizations/get": (input: { organizationId: string }) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return state.organization;
	},
	"organizations/getFeatures": (input: { organizationId: string }) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return state.organization.features ?? {};
	},
	// Two fictional outside apps: a CIMD client people connected and an
	// unlisted dynamically registered one the policy recorded.
	"organizations/listInboundClientInventory": (input: {
		organizationId: string;
	}) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		const policy = state.organization.metadata?.mcpInboundClientPolicy ?? null;
		const judge = (mcpServerId: string, clientId: string) => {
			const listed = (policy?.entries ?? []).some(
				(entry) =>
					entry.mcpServerId === mcpServerId &&
					entry.clientId === clientId &&
					(!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()),
			);
			return {
				listed,
				allowedNow: !policy || policy.mode === "audit" || listed,
			};
		};
		return {
			policy,
			policyInvalid: false,
			items: [
				{
					mcpServerId: "fixture-mcp-server",
					serverSlug: "solstice",
					clientId: "https://agent-host.example/oauth/client.json",
					clientName: "Agent Host",
					clientKind: "cimd" as const,
					connectedPeople: 3,
					lastGrantedAt: T4,
					lastAttempt: {
						stage: "consent" as const,
						mode: "none" as const,
						allowed: true,
						at: T4,
						attempts: 4,
						denied: 0,
					},
					...judge(
						"fixture-mcp-server",
						"https://agent-host.example/oauth/client.json",
					),
				},
				{
					mcpServerId: "fixture-mcp-server",
					serverSlug: "solstice",
					clientId: "dcr-fixture-client-7",
					clientName: "Notes Helper",
					clientKind: "opaque" as const,
					connectedPeople: 0,
					lastGrantedAt: null,
					lastAttempt: {
						stage: "grant" as const,
						mode: "audit" as const,
						allowed: true,
						at: T3,
						attempts: 2,
						denied: 0,
					},
					...judge("fixture-mcp-server", "dcr-fixture-client-7"),
				},
			],
		};
	},
	"organizations/update": (input: {
		organizationId: string;
		name?: string;
		slug?: string;
		logoUrl?: string | null;
		description?: string | null;
		metadata?: Organization["metadata"];
	}) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		state.organization = {
			...state.organization,
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.slug !== undefined ? { slug: input.slug } : {}),
			...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
			...(input.description !== undefined
				? { description: input.description }
				: {}),
			...(input.metadata !== undefined
				? {
						metadata: {
							...state.organization.metadata,
							...input.metadata,
						},
					}
				: {}),
			updatedAt: now(),
		};
		return state.organization;
	},
	"organizations/listApiKeys": (
		input: Pagination & { organizationId: string },
	) => paginate(localApiKeys, input),
	"organizations/deleteApiKey": (input: {
		organizationId: string;
		keyId: string;
	}) => {
		const index = localApiKeys.findIndex((key) => key.id === input.keyId);
		if (input.organizationId !== ORG_ID || index < 0)
			throw new RpcError("NOT_FOUND", "API key not found");
		localApiKeys.splice(index, 1);
		return { success: true as const };
	},
	// One key overdue for rotation so the admin banner has something to say.
	"organizations/getExpiringKeys": () => ({
		data:
			localApiKeys.length === 0
				? []
				: [
						{
							...localApiKeys[0]!,
							warningType: "rotation_overdue" as const,
						},
					],
	}),
};
