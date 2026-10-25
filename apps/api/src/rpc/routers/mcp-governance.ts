/**
 * MCP Governance Router
 *
 * Internal, service-binding-only surface for the MCP tool-approval grant
 * layer. See `packages/api-contract/src/contracts/mcp-governance.ts` for the
 * "why not a direct D1 query from apps/mcp" rationale.
 */

import {
	createApprovalRequestWithAudit,
	getApprovalRequestById,
	consumeOwnerToolApproval,
	findPendingOwnerToolApproval,
	getApprovalAnchor,
} from "@tedix/db/queries/approvals";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getKernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import { parseHomeToolWritePayload } from "./kernel/write-executor";
import { canonicalDigest } from "../../lib/blueprint-digest";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { createError, ErrorCodes } from "../orpc";
import { resolveAgentLifecycleAuthorization } from "@tedix/db/queries/mcp-agent-lifecycle";
import { implement } from "@orpc/server";
import { mcpGovernanceContract } from "@tedix/api-contract/contracts/mcp-governance";
import { parseKernelGovernancePolicy } from "@tedix/api-contract/utils/approval-policy";
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
	resolveToolApprovalGrant,
	resolveWorkItemAuthorization,
} from "@tedix/db/queries/mcp-governance";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { readDelegationAutonomyLessons } from "@tedix/db/queries/work-items/delegation-autonomy";
import {
	type BaseContext,
	resolveServiceBindingOrganizationId,
	withServiceAuth,
} from "../orpc";

const mcpGovernanceOs = implement(
	mcpGovernanceContract,
).$context<BaseContext>();
const serviceOs = mcpGovernanceOs.use(withServiceAuth);
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

/** Plain-language card title; the tool slug stays in the payload. */
function ownerToolApprovalTitle(
	toolId: string,
	skillTitle: string | undefined,
): string {
	if (skillTitle) return `Run skill: ${skillTitle}`;
	const action = (toolId.split("__").at(-1) ?? toolId)
		.replace(/[_-]+/g, " ")
		.trim();
	return action ? action[0]!.toUpperCase() + action.slice(1) : toolId;
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
			if (
				approval?.orgId !== input.organizationId ||
				approval.actionType !== "home.tool_write" ||
				approval.status !== "approved" ||
				!payload ||
				payload.organizationId !== input.organizationId ||
				payload.initiatedByUserId !== input.userId ||
				payload.appSlug !== input.appSlug ||
				payload.toolName !== input.toolName ||
				(await canonicalDigest(payload.args)) !==
					(await canonicalDigest(input.args))
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
			return {
				approved: Boolean(
					run?.status === "running" &&
					run.conversationId === payload.conversationId &&
					run.metadata?.approvalStatus === "approved" &&
					run.metadata.kernelWriteExecutedAt,
				),
			};
		},
	),
	requestOwnerToolApproval: serviceOs.requestOwnerToolApproval.handler(
		async ({ input, context }) => {
			await assertGatewayOrganization(context, input.organizationId);
			if (
				!(await isActiveOwnerOrAdmin(
					context,
					input.organizationId,
					input.userId,
				))
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
					approval.payload.fingerprint !== fingerprint
				)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"Approval does not match this caller, target and arguments",
					);
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
						fingerprint,
						now,
					}));
				return {
					approved: Boolean(approved),
					approvalRequestId: approval.id,
					status: approved ? "consumed" : approval.status,
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
			const title = ownerToolApprovalTitle(input.toolId, skill?.title);
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
					description: `${title}. Nothing has run yet; approving allows one identical retry of this call.`,
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
	resolveWorkItemAuthorization: serviceOs.resolveWorkItemAuthorization.handler(
		async ({ input, context }) => {
			return resolveWorkItemAuthorization(context.db, {
				...input,
				authorizationSigningSecret: context.env.SECRETS_MASTER_KEY,
			});
		},
	),
});
