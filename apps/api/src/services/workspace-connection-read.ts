import {
	WorkspaceConnectionActorSchema,
	WorkspaceConnectionDecisionInputSchema,
	type WorkspaceConnectionDecisionResult,
	WorkspaceConnectionReadInputSchema,
	WorkspaceConnectionReadResultSchema,
	type WorkspaceConnectionReadResult,
} from "@tedix/api-contract/schemas/workspace-connection-read";
import {
	resolveRuntimeApprovalTimeout,
	runtimeApprovalAuditAction,
} from "@tedix/api-contract/utils/approval-policy";
import {
	getApprovalRequestById,
	resolveApprovalRequest,
} from "@tedix/db/queries/approvals";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getMemberAccessByUserId } from "@tedix/db/queries/organization-members";
import {
	readWorkspaceRuntimeRole,
	readWorkspaceSessionRole,
} from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { findWorkspaceConnectionTool } from "@tedix/db/queries/tools";
import { createContext } from "../rpc/context";
import {
	callWorkspaceResourceConnection,
	mayDecideWorkspaceConnection,
	WorkspaceConnectionNotConnected,
} from "./os-app-connection";
import { workspaceDocumentRuntime } from "./workspace-document-owner";

/** Called only by the dedicated WorkerEntrypoint. Identities are assertions from
 * the workspace store; membership, role, resource and tool authority are live reads.
 */
export async function readLinkedWorkspaceAccount(
	env: CloudflareEnv,
	input: unknown,
): Promise<WorkspaceConnectionReadResult> {
	const parsed = WorkspaceConnectionReadInputSchema.safeParse(input);
	if (!parsed.success)
		return {
			status: "refused",
			message: "The connection read request is invalid.",
		};
	const request = parsed.data;
	const context = createContext(
		new Request("https://api.internal/workspace-connection-read"),
		env,
	);
	context.organizationId = request.organizationId;
	context.authType = "service-binding";
	const scope = {
		organizationId: request.organizationId,
		workspaceId: request.workspaceId,
	};
	try {
		const workspace = await getOsWorkspace(context.db, scope);
		if (!workspace || workspace.status !== "active")
			return { status: "refused", message: "This workspace is unavailable." };
		if (request.actor.kind === "user") {
			const member = await getMemberAccessByUserId(
				context.db,
				request.organizationId,
				request.actor.id,
			);
			if (member?.status !== "active")
				return {
					status: "refused",
					message: "An active organization membership is required.",
				};
			const role = await readWorkspaceSessionRole(
				context.db,
				request.workspaceId,
				request.actor.id,
			);
			if (!["build", "owner"].includes(role ?? ""))
				return {
					status: "refused",
					message:
						"You need build or owner access to read connected accounts in this workspace.",
				};
		} else if (request.actor.kind === "tedi") {
			const role = await readWorkspaceRuntimeRole(context.db, scope, {
				actorKind: "tedi",
				actorId: request.actor.tediId,
			});
			if (role !== "build")
				return {
					status: "refused",
					message:
						"This tedi needs build access to read connected accounts in this workspace.",
				};
		}
		const resource = await workspaceDocumentRuntime().outputQuery(scope, {
			op: "resources",
			query: {
				operation: "get",
				params: { ...scope, resourceId: request.resourceId },
			},
		});
		if (!resource)
			return {
				status: "refused",
				message: "The linked resource was not found in this workspace.",
			};
		if (request.actor.kind !== "user" && resource.connectionScope !== "tenant")
			return {
				status: "refused",
				message: "Only a signed-in person can read a personal account.",
			};
		const tool = await findWorkspaceConnectionTool(context.db, {
			organizationId: request.organizationId,
			toolName: request.toolName,
			providerId: resource.providerId,
			connectionInstanceId: resource.connectionInstanceId ?? "",
			connectionScope: resource.connectionScope,
		});
		if (!tool)
			return {
				status: "refused",
				message:
					"The requested read tool is unavailable or its name is ambiguous.",
			};
		try {
			const result = await callWorkspaceResourceConnection(
				context,
				{
					kind: "agent",
					workspaceId: request.workspaceId,
					conversationId: request.conversationId,
					actor: request.actor,
				},
				resource,
				{
					...tool,
					arguments: request.args,
					approvalRequestId: request.approvalRequestId,
				},
			);
			if (
				result &&
				typeof result === "object" &&
				!Array.isArray(result) &&
				"approval" in result
			) {
				const approval = result.approval;
				if (
					approval &&
					typeof approval === "object" &&
					!Array.isArray(approval) &&
					typeof approval.approvalRequestId === "string"
				) {
					if (approval.status === "pending")
						return WorkspaceConnectionReadResultSchema.parse({
							status: "approval_required",
							approvalId: approval.approvalRequestId,
						});
					return {
						status: "refused",
						message:
							approval.status === "rejected"
								? "The connection read was denied."
								: "This approval can no longer be used for the connection read.",
					};
				}
			}
			return { status: "ok", result };
		} catch (error) {
			if (error instanceof WorkspaceConnectionNotConnected)
				return {
					status: "not_connected",
					providerId: resource.providerId,
					scope: resource.connectionScope,
					connectPath:
						resource.connectionScope === "user"
							? `/account/connections?connect=${encodeURIComponent(resource.providerId)}`
							: "/admin/connections",
				};
			throw error;
		}
	} catch (error) {
		// Validation and policy refusals are readable; unexpected failures expose no internals.
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "FORBIDDEN" &&
			"message" in error &&
			typeof error.message === "string"
		)
			return { status: "refused", message: error.message };
		return {
			status: "refused",
			message:
				"The connection read could not be completed. Check the linked resource and try again.",
		};
	}
}

/** The workspace store supplies the authenticated person who clicked the tray decision. */
export async function decideLinkedWorkspaceAccountApproval(
	env: CloudflareEnv,
	input: unknown,
): Promise<WorkspaceConnectionDecisionResult> {
	const parsed = WorkspaceConnectionDecisionInputSchema.safeParse(input);
	if (!parsed.success)
		return {
			status: "refused",
			message: "The connection decision is invalid.",
		};
	const {
		organizationId,
		workspaceId,
		conversationId,
		approvalRequestId,
		by,
		decision,
	} = parsed.data;
	const context = createContext(
		new Request("https://api.internal/workspace-connection-decision"),
		env,
	);
	try {
		const { db } = context;
		const workspace = await getOsWorkspace(db, { organizationId, workspaceId });
		if (workspace?.status !== "active")
			return { status: "refused", message: "This workspace is unavailable." };
		const member = await getMemberAccessByUserId(db, organizationId, by);
		if (member?.status !== "active")
			return {
				status: "refused",
				message: "An active organization membership is required.",
			};

		const approval = await getApprovalRequestById(
			db,
			approvalRequestId,
			organizationId,
		);
		const target = approval?.payload.target;
		if (
			approval?.actionType !== "mcp.tool_call" ||
			approval.status !== "pending" ||
			resolveRuntimeApprovalTimeout(approval).expired ||
			approval.payload.kind !== "mcp_tool_call" ||
			typeof approval.payload.fingerprint !== "string" ||
			!target ||
			typeof target !== "object" ||
			Array.isArray(target) ||
			target.workspaceId !== workspaceId ||
			target.conversationId !== conversationId ||
			typeof target.resourceHash !== "string" ||
			typeof target.accountHash !== "string" ||
			!WorkspaceConnectionActorSchema.safeParse(target.actor).success ||
			"gadgetId" in target
		)
			return {
				status: "refused",
				message:
					"No pending connection read matches this workspace and conversation.",
			};
		// Governance applies the same live rule again when the call is replayed.
		const requester = approval.payload.initiatedByUserId;
		if (
			!(await mayDecideWorkspaceConnection(
				db,
				target,
				typeof requester === "string" ? requester : undefined,
				by,
			))
		)
			return {
				status: "refused",
				message:
					target.connectionScope !== "tenant" && requester !== by
						? "Only the person whose own account this uses can decide this."
						: "Someone with build access to this workspace must decide this.",
			};

		const status = decision === "approve" ? "approved" : "rejected";
		const resolvedBy = `user:${by}`;
		const resolved = await resolveApprovalRequest(db, approval.id, {
			status,
			resolvedBy,
		});
		if (!resolved)
			return {
				status: "refused",
				message: "This connection read is no longer pending or is blocked.",
			};
		await insertAuditEvent(db, {
			organizationId,
			actorId: resolvedBy,
			actorType: "user",
			action: runtimeApprovalAuditAction({ status }),
			resourceType: "approval_request",
			resourceId: approval.id,
		});
		return { status: decision === "approve" ? "approved" : "denied" };
	} catch {
		return {
			status: "refused",
			message: "The connection decision could not be recorded.",
		};
	}
}
