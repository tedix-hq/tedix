import { createError, ErrorCodes } from "../rpc/orpc";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import {
	WorkspaceConnectionDiscoveryInputSchema,
	type AvailableWorkspaceConnection,
} from "@tedix/api-contract/schemas/workspace-available-connections";
import { readConnectionsOverview } from "../rpc/routers/connections/inventory";
import { createContext, type BaseContext } from "../rpc/context";
import { getMemberAccessByUserId } from "@tedix/db/queries/organization-members";
import { readWorkspaceSessionRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";

/** Shared by the service-binding discovery port and the human's link action. */
export async function requireConnectionSender(
	context: BaseContext,
	workspaceId: string,
	userId: string,
) {
	const organizationId = context.organizationId;
	if (!organizationId)
		throw createError(ErrorCodes.FORBIDDEN, "An organization is required");
	const [workspace, member, role] = await Promise.all([
		getOsWorkspace(context.db, { organizationId, workspaceId }),
		getMemberAccessByUserId(context.db, organizationId, userId),
		readWorkspaceSessionRole(context.db, workspaceId, userId),
	]);
	if (
		workspace?.status !== "active" ||
		member?.status !== "active" ||
		!["owner", "build"].includes(role ?? "")
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Active membership and workspace build or owner access are required",
		);
}

export async function discoverWorkspaceConnections(
	context: BaseContext,
	providerId?: string,
): Promise<AvailableWorkspaceConnection[]> {
	const inventories = await Promise.all(
		(["organization", "personal"] as const).map((scope) =>
			readConnectionsOverview(context, {
				scope,
				status: "all",
				q: "",
				limit: 10000,
				offset: 0,
				...(providerId ? { providerId } : {}),
			}),
		),
	);
	if (inventories.some((inventory) => inventory.hasMore))
		throw new Error("The connection inventory is incomplete");
	return Promise.all(
		inventories
			.flatMap((inventory) => inventory.rows)
			.map(async (row) => ({
				// An organization account is the same for every member, so its id
				// must be too; only a personal account belongs to one person.
				id: await sha256Hex(
					JSON.stringify([
						context.organizationId,
						row.scope === "user" ? context.user?.sub : null,
						row.provider.appId,
						row.scope,
						row.connectionInstanceId ?? "default",
					]),
				),
				providerId: row.provider.appId,
				service: row.provider.name,
				label: row.instanceLabel ?? row.provider.name,
				connectionScope:
					row.scope === "user"
						? ("personal" as const)
						: ("organization" as const),
				hybrid:
					row.provider.supportedScopes.includes("user") &&
					row.provider.supportedScopes.includes("tenant"),
				...(row.connectionInstanceId
					? { connectionInstanceId: row.connectionInstanceId }
					: {}),
				connectedForYou: ["unknown", "restricted"].includes(row.accountState)
					? null
					: row.accountState === "present" &&
						row.connection?.status === "connected",
				grantedScopes: row.connection?.scopes ?? [],
				access: (row.toolCapabilities ?? []).map(({ label, riskTier }) => ({
					label,
					riskTier,
				})),
			})),
	);
}

/** Only the workspace object's dedicated service binding can assert the sender. */
export async function readAvailableWorkspaceConnections(
	env: CloudflareEnv,
	input: unknown,
) {
	const request = WorkspaceConnectionDiscoveryInputSchema.parse(input);
	const context = createContext(
		new Request("https://api.internal/workspace-available-connections"),
		env,
	);
	context.organizationId = request.organizationId;
	context.authType = "service-binding";
	await requireConnectionSender(context, request.workspaceId, request.userId);
	context.user = {
		sub: request.userId,
		iss: "workspace-service",
		exp: Math.floor(Date.now() / 1000) + 60,
	};
	return discoverWorkspaceConnections(context, request.providerId);
}
