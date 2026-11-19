import {
	WorkspaceConnectionReadInputSchema,
	WorkspaceConnectionReadResultSchema,
	type WorkspaceConnectionReadResult,
} from "@tedix/api-contract/schemas/workspace-connection-read";
import { getMemberAccessByUserId } from "@tedix/db/queries/organization-members";
import {
	readWorkspaceRuntimeRole,
	readWorkspaceSessionRole,
} from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getOsWorkspaceResource } from "@tedix/db/queries/os-workspaces/resources";
import { findWorkspaceConnectionTool } from "@tedix/db/queries/tools";
import { createContext } from "../rpc/context";
import {
	callWorkspaceResourceConnection,
	WorkspaceConnectionNotConnected,
} from "./os-app-connection";

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
		const resource = await getOsWorkspaceResource(context.db, {
			...scope,
			resourceId: request.resourceId,
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
				{ ...tool, arguments: request.args },
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
				)
					return WorkspaceConnectionReadResultSchema.parse({
						status: "approval_required",
						approvalId: approval.approvalRequestId,
					});
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
