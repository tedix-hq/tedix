import "@orpc/openapi/extensions/route";
/**
 * MCP Governance Contract
 *
 * Internal, service-binding-only surface for the MCP tool-approval grant
 * layer. `apps/mcp` has no general `@tedix/db` access (root `AGENTS.md`'s MCP
 * Platform invariant), so this is how the destructive-tool approval gate
 * resolves a durable grant in one round trip instead of querying D1 directly
 * — mirrors `tedis.listRuntimeMetaBySlugs`.
 */

import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import * as z from "zod";
import {
	CreateProviderIdentityProfileInputSchema,
	PrepareProviderIdentityProfileInputSchema,
	PrepareProviderIdentityProfileResponseSchema,
	ProviderIdentityProfileSchema,
} from "../schemas/provider-identity-profile";
import {
	ProbeProviderIdentityProfileInputSchema,
	ProbeProviderIdentityProfileResponseSchema,
	RedeemProviderIdentityProbeInputSchema,
	RedeemProviderIdentityProbeResponseSchema,
	RecordMachineProviderProbeInputSchema,
	MachineProviderProbeListSchema,
	PrepareMachineIdentityProbeInputSchema,
	RedeemMachineIdentityProbeResponseSchema,
} from "../schemas/provider-probe-receipt";
import {
	CreateTenantToolPolicyInputSchema,
	PrepareTenantToolPolicyInputSchema,
	PrepareTenantToolPolicyResponseSchema,
	PrepareHybridTenantToolPolicyInputSchema,
	PrepareHybridTenantToolPolicyResponseSchema,
	PrepareMachineTenantToolPolicyInputSchema,
	PrepareMachineTenantToolPolicyResponseSchema,
	PrepareNativeRpcPolicyInputSchema,
	PrepareNativeRpcPolicyResponseSchema,
	MachinePolicyInventorySchema,
	ResolveTenantToolPolicyInputSchema,
	ResolveTenantToolPolicyResponseSchema,
	ResolveTenantPolicyCandidateInputSchema,
	ResolveTenantPolicySourceCandidateInputSchema,
	ResolveTenantPolicyDiscoveryInputSchema,
	ResolveTenantPolicyDiscoveryResponseSchema,
	ResolveMachinePolicyCandidateInputSchema,
	ResolveMachinePolicyDiscoveryInputSchema,
	ResolveMachinePolicyCandidateResponseSchema,
	ResolveNativeRpcPolicyCandidateResponseSchema,
	ResolveMachinePolicyAnyRootInputSchema,
	ResolveTenantPolicyPresenceInputSchema,
	RequestMachineToolApprovalInputSchema,
	RequestNativeMachineToolApprovalInputSchema,
	PrepareOwnerPolicyReplayInputSchema,
	PrepareOwnerPolicyReplayResponseSchema,
	ResolveTenantPolicyCandidateResponseSchema,
	TenantToolPolicySchema,
	DeletedTenantPolicyFencesSchema,
} from "../schemas/tenant-tool-policy";
import {
	ResolveHomeToolApprovalInputSchema,
	ResolveHomeToolApprovalResponseSchema,
	RequestOwnerToolApprovalInputSchema,
	RequestOwnerToolApprovalResponseSchema,
	RecordPolicyToolApprovalInputSchema,
	RecordPolicyToolApprovalResponseSchema,
	ResolveOwnerSkillStartInputSchema,
	ResolveOwnerSkillStartResponseSchema,
	ResolveSkillManifestAuthorizationInputSchema,
	ResolveSkillManifestAuthorizationResponseSchema,
	ResolveAgentLifecycleAuthorizationInputSchema,
	ResolveAgentLifecycleAuthorizationResponseSchema,
	ResolveAgentTransportPolicyInputSchema,
	ResolveAgentTransportPolicyResponseSchema,
	ResolveMcpToolApprovalGrantInputSchema,
	ResolveMcpToolApprovalGrantResponseSchema,
	ResolveWorkItemAuthorizationInputSchema,
	ResolveWorkItemAuthorizationResponseSchema,
	ResolveActionTypeOptInInputSchema,
	ResolveActionTypeOptInResponseSchema,
	ListActionTypeOptInsResponseSchema,
	LegacyActionTypeInventorySchema,
	SetActionTypeOptInInputSchema,
	SetActionTypeOptInResponseSchema,
} from "../schemas/mcp-governance";
import {
	ConnectionSensitivitySchema,
	LatchRunSensitiveDataInputSchema,
	ResolveConnectionSensitivityInputSchema,
	ResolveRunSensitiveDataLatchInputSchema,
	RunSensitiveDataLatchStateSchema,
} from "../schemas/sensitive-data-latch";

export const mcpGovernanceContract = oc
	.route({ tags: ["mcp-governance"], prefix: "/mcpGovernance" })
	.errors(baseErrors)
	.router({
		resolveHomeToolApproval: oc
			.route({
				method: "POST",
				path: "/resolve-home-tool-approval",
				summary: "Verify an executing Home write's exact approval",
				tags: ["internal"],
			})
			.input(ResolveHomeToolApprovalInputSchema)
			.output(ResolveHomeToolApprovalResponseSchema),
		requestOwnerToolApproval: oc
			.route({
				method: "POST",
				path: "/request-owner-tool-approval",
				summary: "Park or consume an exact owner tool approval",
				tags: ["internal"],
			})
			.input(RequestOwnerToolApprovalInputSchema)
			.output(RequestOwnerToolApprovalResponseSchema),
		recordPolicyToolApproval: oc
			.route({
				method: "POST",
				path: "/record-policy-tool-approval",
				summary: "Record a gateway call approved by the platform default",
				tags: ["internal"],
			})
			.input(RecordPolicyToolApprovalInputSchema)
			.output(RecordPolicyToolApprovalResponseSchema),
		resolveOwnerSkillStart: oc
			.route({
				method: "POST",
				path: "/resolve-owner-skill-start",
				summary: "Verify an owner's start of an active skill",
				description:
					"Internal service-binding check used by the MCP gateway. Approves only when the caller is an active owner or admin of the gateway organization and the skill is active there with an executable workflow. Effects inside the run keep their own gates.",
				tags: ["internal"],
			})
			.input(ResolveOwnerSkillStartInputSchema)
			.output(ResolveOwnerSkillStartResponseSchema),
		resolveSkillManifestAuthorization: oc
			.route({
				method: "POST",
				path: "/resolve-skill-manifest-authorization",
				summary: "Verify a workflow's pinned skill capability",
				tags: ["internal"],
			})
			.input(ResolveSkillManifestAuthorizationInputSchema)
			.output(ResolveSkillManifestAuthorizationResponseSchema),
		resolveAgentLifecycleAuthorization: oc
			.route({
				method: "POST",
				path: "/resolve-agent-lifecycle-authorization",
				summary: "Verify a coding session's admitted lifecycle write",
				tags: ["internal"],
			})
			.input(ResolveAgentLifecycleAuthorizationInputSchema)
			.output(ResolveAgentLifecycleAuthorizationResponseSchema),
		resolveAgentTransportPolicy: oc
			.route({
				method: "POST",
				path: "/resolve-agent-transport-policy",
				summary: "Resolve autonomous third-party transport policy",
				description:
					"Internal service-binding lookup used by the MCP gateway. Resolves the calling tedi's policy-pack rollout switch for explicit destructive external/MCP tool policy; absence preserves the current behavior.",
				tags: ["internal"],
			})
			.input(ResolveAgentTransportPolicyInputSchema)
			.output(ResolveAgentTransportPolicyResponseSchema),
		resolveToolApprovalGrant: oc
			.route({
				method: "POST",
				path: "/resolve-tool-approval-grant",
				summary: "Resolve an MCP tool-approval grant",
				description:
					"Internal service-binding lookup used by the MCP gateway's destructive-tool approval gate. Finds an active grant for the subject/tool scope and, for a 'once' grant, atomically consumes it in the same call. Returns approved:false on any absence/expiry/race-loss — callers must treat that as 'fall through to normal elicitation', never as approval.",
				tags: ["internal"],
			})
			.input(ResolveMcpToolApprovalGrantInputSchema)
			.output(ResolveMcpToolApprovalGrantResponseSchema),
		resolveWorkItemAuthorization: oc
			.route({
				method: "POST",
				path: "/resolve-work-item-authorization",
				summary: "Resolve a Work Item authorization receipt",
				description:
					"Internal service-binding gate for bounded autonomous owned-channel publishing. Approves only when the calling tedi owns exactly one active leaf carrying a current, user-authored, structurally valid authorization receipt whose scope matches the tool arguments.",
				tags: ["internal"],
			})
			.input(ResolveWorkItemAuthorizationInputSchema)
			.output(ResolveWorkItemAuthorizationResponseSchema),
		resolveActionTypeOptIn: oc
			.route({
				method: "POST",
				path: "/resolve-action-type-opt-in",
				summary: "Resolve an organization's opt-in for a tool action type",
				description:
					"Internal service-binding lookup used by the MCP gateway. Approves only when an organization admin let this declared action type run without asking and the type is not platform-critical.",
				tags: ["internal"],
			})
			.input(ResolveActionTypeOptInInputSchema)
			.output(ResolveActionTypeOptInResponseSchema),
		listActionTypeOptIns: oc
			.route({
				method: "GET",
				path: "/action-type-opt-ins",
				summary: "List actions that run without asking",
				description:
					"Lists the declared tool action types an organization admin let run without an approval card, for example comment_on_issue.",
			})
			.output(ListActionTypeOptInsResponseSchema),
		listLegacyActionTypeInventory: oc
			.route({
				method: "GET",
				path: "/action-type-opt-ins/inventory",
				summary: "Review legacy grants and declared source tools",
			})
			.output(LegacyActionTypeInventorySchema),
		setActionTypeOptIn: oc
			.route({
				method: "POST",
				path: "/action-type-opt-ins",
				summary: "Let an action run without asking, or ask again",
				description:
					"Organization owners and admins only. Lets every tool that declares this action type run without an approval card, or turns that off. Platform-critical types such as payments, sending messages, publishing, deletion and access changes always ask and are refused. Tools with no declared action type keep asking.",
			})
			.input(SetActionTypeOptInInputSchema)
			.output(SetActionTypeOptInResponseSchema),
		listTenantToolPolicies: oc
			.route({
				method: "GET",
				path: "/tenant-tool-policies",
				summary: "List tool policy revisions",
			})
			.output(z.object({ items: z.array(TenantToolPolicySchema) })),
		listDeletedTenantPolicyFences: oc
			.route({
				method: "GET",
				path: "/tenant-tool-policies/deleted",
				summary: "List deleted rule revisions requiring review",
			})
			.output(DeletedTenantPolicyFencesSchema),
		prepareTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies/prepare",
				summary: "Prepare a tool policy for owner review",
			})
			.input(PrepareTenantToolPolicyInputSchema)
			.output(PrepareTenantToolPolicyResponseSchema),
		prepareHybridTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies/prepare-profile",
				summary: "Prepare a profile-bound tool policy",
			})
			.input(PrepareHybridTenantToolPolicyInputSchema)
			.output(PrepareHybridTenantToolPolicyResponseSchema),
		prepareMachineTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies/prepare-machine",
				summary: "Prepare an owner-reviewed machine tool policy",
			})
			.input(PrepareMachineTenantToolPolicyInputSchema)
			.output(PrepareMachineTenantToolPolicyResponseSchema),
		createTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies",
				summary: "Create an owner-approved tool policy revision",
			})
			.input(CreateTenantToolPolicyInputSchema)
			.output(z.object({ policy: TenantToolPolicySchema })),
		revokeTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies/revoke",
				summary: "Revoke a tool policy revision",
			})
			.input(z.object({ id: z.string().min(1) }))
			.output(z.object({ policy: TenantToolPolicySchema })),
		resolveTenantToolPolicy: oc
			.route({
				method: "POST",
				path: "/resolve-tenant-tool-policy",
				summary: "Resolve an owner-approved tool policy revision",
				tags: ["internal"],
			})
			.input(ResolveTenantToolPolicyInputSchema)
			.output(ResolveTenantToolPolicyResponseSchema),
		resolveTenantPolicyCandidate: oc
			.route({
				method: "POST",
				path: "/resolve-tenant-policy-candidate",
				summary:
					"Find a profile-bound policy candidate without authorizing execution",
				tags: ["internal"],
			})
			.input(ResolveTenantPolicyCandidateInputSchema)
			.output(ResolveTenantPolicyCandidateResponseSchema),
		resolveTenantPolicySourceCandidate: oc
			.route({
				method: "POST",
				path: "/resolve-tenant-policy-source-candidate",
				summary:
					"Find one unambiguous source policy candidate without authorizing execution",
				tags: ["internal"],
			})
			.input(ResolveTenantPolicySourceCandidateInputSchema)
			.output(ResolveTenantPolicyCandidateResponseSchema),
		resolveTenantPolicyDiscovery: oc
			.route({
				method: "POST",
				path: "/resolve-tenant-policy-discovery",
				summary: "Describe whether a reviewed policy could apply",
				tags: ["internal"],
			})
			.input(ResolveTenantPolicyDiscoveryInputSchema)
			.output(ResolveTenantPolicyDiscoveryResponseSchema),
		resolveMachinePolicyCandidate: oc
			.route({
				method: "POST",
				path: "/resolve-machine-policy-candidate",
				summary:
					"Find a machine policy candidate without authorizing execution",
				tags: ["internal"],
			})
			.input(ResolveMachinePolicyCandidateInputSchema)
			.output(ResolveMachinePolicyCandidateResponseSchema),
		resolveMachinePolicyAnyRoot: oc
			.route({
				method: "POST",
				path: "/resolve-machine-policy-any-root",
				summary: "Find one unambiguous machine policy by source",
				tags: ["internal"],
			})
			.input(ResolveMachinePolicyAnyRootInputSchema)
			.output(ResolveMachinePolicyCandidateResponseSchema),
		resolveNativeRpcPolicyCandidate: oc
			.route({
				method: "POST",
				path: "/resolve-native-rpc-policy-candidate",
				summary: "Find a native RPC policy candidate",
				tags: ["internal"],
			})
			.input(ResolveMachinePolicyCandidateInputSchema)
			.output(ResolveNativeRpcPolicyCandidateResponseSchema),
		resolveTenantPolicyPresence: oc
			.route({
				method: "POST",
				path: "/resolve-tenant-policy-presence",
				summary: "Check whether a policy fence may apply",
				tags: ["internal"],
			})
			.input(ResolveTenantPolicyPresenceInputSchema)
			.output(z.object({ fenced: z.boolean() })),
		resolveMachinePolicyDiscovery: oc
			.route({
				method: "POST",
				path: "/resolve-machine-policy-discovery",
				summary: "Describe whether a reviewed machine policy could apply",
				tags: ["internal"],
			})
			.input(ResolveMachinePolicyDiscoveryInputSchema)
			.output(ResolveTenantPolicyDiscoveryResponseSchema),
		prepareOwnerPolicyReplay: oc
			.route({
				method: "POST",
				path: "/prepare-owner-policy-replay",
				summary: "Prepare an exact approved owner replay",
				tags: ["internal"],
			})
			.input(PrepareOwnerPolicyReplayInputSchema)
			.output(PrepareOwnerPolicyReplayResponseSchema),
		requestMachineToolApproval: oc
			.route({
				method: "POST",
				path: "/request-machine-tool-approval",
				summary: "Park or consume an exact machine tool approval",
				tags: ["internal"],
			})
			.input(RequestMachineToolApprovalInputSchema)
			.output(RequestOwnerToolApprovalResponseSchema),
		requestNativeMachineToolApproval: oc
			.route({
				method: "POST",
				path: "/request-native-machine-tool-approval",
				summary: "Park or consume an exact native machine tool approval",
				tags: ["internal"],
			})
			.input(RequestNativeMachineToolApprovalInputSchema)
			.output(RequestOwnerToolApprovalResponseSchema),
		prepareNativeRpcPolicy: oc
			.route({
				method: "POST",
				path: "/tenant-tool-policies/prepare-native",
				summary: "Prepare a native RPC policy for owner review",
			})
			.input(PrepareNativeRpcPolicyInputSchema)
			.output(PrepareNativeRpcPolicyResponseSchema),
		prepareProviderIdentityProfile: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/prepare",
				summary: "Prepare a provider identity profile for owner review",
			})
			.input(PrepareProviderIdentityProfileInputSchema)
			.output(PrepareProviderIdentityProfileResponseSchema),
		createProviderIdentityProfile: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles",
				summary: "Record an owner-reviewed provider identity profile",
			})
			.input(CreateProviderIdentityProfileInputSchema)
			.output(z.object({ profile: ProviderIdentityProfileSchema })),
		listProviderIdentityProfiles: oc
			.route({
				method: "GET",
				path: "/provider-identity-profiles",
				summary: "List provider identity profiles",
			})
			.output(z.object({ items: z.array(ProviderIdentityProfileSchema) })),
		revokeProviderIdentityProfile: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/revoke",
				summary: "Revoke a provider identity profile",
			})
			.input(z.object({ id: z.string().min(1) }))
			.output(z.object({ profile: ProviderIdentityProfileSchema })),
		resolveProviderIdentityProfile: oc
			.route({
				method: "POST",
				path: "/resolve-provider-identity-profile",
				summary: "Resolve an owner-reviewed provider identity profile",
				tags: ["internal"],
			})
			.input(
				z.object({ organizationId: z.string().min(1), id: z.string().min(1) }),
			)
			.output(z.object({ profile: ProviderIdentityProfileSchema.nullable() })),
		probeProviderIdentityProfile: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/probe",
				summary: "Verify an owner-reviewed provider identity",
			})
			.input(ProbeProviderIdentityProfileInputSchema)
			.output(ProbeProviderIdentityProfileResponseSchema),
		redeemProviderIdentityProbe: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/redeem-probe",
				summary: "Redeem verified provider probe authority",
				tags: ["internal"],
			})
			.input(RedeemProviderIdentityProbeInputSchema)
			.output(RedeemProviderIdentityProbeResponseSchema),
		recordMachineProviderProbe: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/record-machine-probe",
				summary: "Record verified machine probe",
				tags: ["internal"],
			})
			.input(RecordMachineProviderProbeInputSchema)
			.output(z.object({ receiptId: z.uuid() })),
		listMachinePolicyInventory: oc
			.route({
				method: "GET",
				path: "/tenant-tool-policies/machine-inventory",
				summary: "List active machine sessions for owner review",
			})
			.output(MachinePolicyInventorySchema),
		listMachineProviderProbes: oc
			.route({
				method: "GET",
				path: "/provider-identity-profiles/machine-probes",
				summary: "List machine proofs for owner review",
			})
			.output(MachineProviderProbeListSchema),
		prepareMachineIdentityProbe: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/prepare-machine-probe",
				summary: "Prepare a machine identity proof",
			})
			.input(PrepareMachineIdentityProbeInputSchema)
			.output(z.object({ receiptId: z.uuid() })),
		redeemMachineIdentityProbe: oc
			.route({
				method: "POST",
				path: "/provider-identity-profiles/redeem-machine-probe",
				summary: "Redeem machine probe authority",
				tags: ["internal"],
			})
			.input(RedeemProviderIdentityProbeInputSchema)
			.output(RedeemMachineIdentityProbeResponseSchema),
		latchRunSensitiveData: oc
			.route({
				method: "POST",
				path: "/latch-run-sensitive-data",
				summary: "Record that a run read a sensitive source",
				description:
					"Internal service-binding call from the MCP gateway after a successful read. Latches the run row when the tool is declared sensitive or the connection's classification is restricted; otherwise leaves it unchanged. Returns the run's current latch state.",
				tags: ["internal"],
			})
			.input(LatchRunSensitiveDataInputSchema)
			.output(RunSensitiveDataLatchStateSchema),
		resolveRunSensitiveDataLatch: oc
			.route({
				method: "POST",
				path: "/resolve-run-sensitive-data-latch",
				summary: "Read a run's sensitive-data latch",
				description:
					"Internal service-binding read used before public egress and before grant or policy auto-approval. `known: false` means no run row matched.",
				tags: ["internal"],
			})
			.input(ResolveRunSensitiveDataLatchInputSchema)
			.output(RunSensitiveDataLatchStateSchema),
		resolveConnectionSensitivity: oc
			.route({
				method: "POST",
				path: "/resolve-connection-sensitivity",
				summary: "Read whether a connection is classified restricted",
				description:
					"Internal service-binding read the MCP gateway makes before a connected read inside a run to decide whether that read must latch the run. A read on a connection that is not restricted never reaches the latch write.",
				tags: ["internal"],
			})
			.input(ResolveConnectionSensitivityInputSchema)
			.output(ConnectionSensitivitySchema),
	});

export type McpGovernanceContract = typeof mcpGovernanceContract;
