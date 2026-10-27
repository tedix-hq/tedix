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
	SetActionTypeOptInInputSchema,
	SetActionTypeOptInResponseSchema,
} from "../schemas/mcp-governance";
import {
	LatchRunSensitiveDataInputSchema,
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
	});

export type McpGovernanceContract = typeof mcpGovernanceContract;
