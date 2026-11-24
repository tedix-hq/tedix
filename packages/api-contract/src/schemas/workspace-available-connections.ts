import { z } from "zod";

/** Metadata only: no credential, owner identity or token reference crosses this port. */
export const AvailableWorkspaceConnectionSchema = z.object({
	id: z.string().min(1),
	providerId: z.string().min(1),
	service: z.string(),
	label: z.string(),
	connectionScope: z.enum(["personal", "organization"]),
	hybrid: z.boolean(),
	connectionInstanceId: z.string().optional(),
	connectedForYou: z.boolean().nullable(),
	grantedScopes: z.array(z.string()).optional(),
	/** Configured tool capabilities, not permission to execute them. */
	access: z.array(z.object({ label: z.string(), riskTier: z.string() })),
});
export type AvailableWorkspaceConnection = z.infer<
	typeof AvailableWorkspaceConnectionSchema
>;
export const WorkspaceConnectionDiscoveryInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1),
	userId: z.string().min(1),
	providerId: z.string().min(1).optional(),
});
export type WorkspaceConnectionDiscoveryInput = z.infer<
	typeof WorkspaceConnectionDiscoveryInputSchema
>;
export const LinkWorkspaceConnectionsInputSchema = z.strictObject({
	workspaceId: z.uuid(),
	connections: z.array(z.string().min(1).max(500)).min(1).max(50),
});
export const LinkWorkspaceConnectionsResultSchema = z.object({
	added: z.array(z.object({ id: z.string(), name: z.string() })),
	failed: z.array(z.object({ id: z.string(), message: z.string() })),
});
