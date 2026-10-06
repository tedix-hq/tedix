import "@orpc/openapi/extensions/route";
/**
 * Descope AIH Management Contract
 * CRUD for MCP Servers and MCP Server Clients via Descope Management API.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ApprovedScopesSchema,
	CimdSettingsSchema,
	DescopeAihClientAuditSchema,
	DescopeAihClientRepairActionSchema,
	DescopeAihDriftReportSchema,
	DescopeAihMcpServerReconcileActionSchema,
	McpServerDynamicRegistrationSchema,
	McpServerRecordSchema,
	McpServerSessionSettingsSchema,
} from "../schemas/descope-aih";

export const descopeAihContract = oc
	.route({ tags: ["descope-aih", "internal"], prefix: "/descope-aih" })
	.errors(baseErrors)
	.router({
		listMcpServers: oc
			.route({
				method: "POST",
				path: "/mcp-servers/list",
				summary: "List all Descope AIH MCP servers",
			})
			.input(z.object({}).optional())
			.output(z.object({ servers: z.array(McpServerRecordSchema) })),

		loadMcpServer: oc
			.route({
				method: "POST",
				path: "/mcp-servers/load",
				summary: "Load a single AIH MCP server",
			})
			.input(z.object({ mcpServerId: z.string() }))
			.output(z.object({ server: McpServerRecordSchema })),

		createMcpServer: oc
			.route({
				method: "POST",
				path: "/mcp-servers/create",
				summary: "Create a new AIH MCP server",
			})
			.input(
				z.object({
					name: z.string(),
					description: z.string().optional(),
					audienceWhitelist: z.array(z.string().url()).length(1),
					approvedScopes: ApprovedScopesSchema.optional(),
					approvedCallbackUrls: z.array(z.string().url()).optional(),
					dynamicRegistration: McpServerDynamicRegistrationSchema.optional(),
					cimdSettings: CimdSettingsSchema.optional(),
					sessionSettings: McpServerSessionSettingsSchema.optional(),
					tags: z.array(z.string()).optional(),
					logo: z.string().optional(),
					skipConsentScreen: z.boolean().optional(),
					forceAddAllAuthorizationInfo: z.boolean().optional(),
				}),
			)
			.output(z.object({ server: McpServerRecordSchema })),

		updateMcpServer: oc
			.route({
				method: "POST",
				path: "/mcp-servers/update",
				summary: "Update an AIH MCP server",
			})
			.input(z.object({ server: McpServerRecordSchema }))
			.output(z.object({ server: McpServerRecordSchema })),

		deleteMcpServer: oc
			.route({
				method: "POST",
				path: "/mcp-servers/delete",
				summary: "Delete an AIH MCP server",
			})
			.input(z.object({ mcpServerId: z.string() }))
			.output(z.object({ success: z.literal(true) })),

		createMcpClient: oc
			.route({
				method: "POST",
				path: "/mcp-clients/create",
				summary: "Create a pre-registered MCP server client",
			})
			.input(
				z.object({
					name: z.string(),
					mcpServerId: z.string(),
					scopes: z.array(z.string()).optional(),
					tags: z.array(z.string()).optional(),
					approvedCallbackUrls: z.array(z.string().url()).optional(),
					logo: z.string().optional(),
					forceAddAllAuthorizationInfo: z.boolean().optional(),
				}),
			)
			.output(
				z.object({
					id: z.string(),
					clientId: z.string(),
					clientSecret: z.string(),
				}),
			),

		searchMcpClients: oc
			.route({
				method: "POST",
				path: "/mcp-clients/search",
				summary: "Search MCP server clients",
			})
			.input(
				z.object({
					mcpServerId: z.string(),
					clientId: z
						.string()
						.min(1)
						.optional()
						.describe(
							"Exact OAuth client id for authentication lookups; omitted only by administrative catalog searches that intentionally inspect the bounded server-wide result.",
						),
				}),
			)
			.output(
				z.object({
					clients: z.array(
						z
							.object({
								id: z.string(),
								name: z.string(),
								clientId: z.string(),
							})
							.passthrough(),
					),
				}),
			),

		updateMcpClient: oc
			.route({
				method: "POST",
				path: "/mcp-clients/update",
				summary: "Update an MCP server client",
			})
			.input(
				z.object({
					id: z.string(),
					mcpServerId: z.string(),
					name: z.string().min(1),
					scopes: z.array(z.string()).optional(),
					tags: z.array(z.string()).optional(),
					approvedCallbackUrls: z.array(z.string().url()).optional(),
					logo: z.string().url().optional(),
				}),
			)
			.output(z.object({ client: DescopeAihClientAuditSchema })),

		deleteMcpClient: oc
			.route({
				method: "POST",
				path: "/mcp-clients/delete",
				summary: "Delete an MCP server client",
			})
			.input(z.object({ id: z.string(), mcpServerId: z.string() }))
			.output(z.object({ success: z.literal(true) })),

		repairDevtoolDcrClients: oc
			.route({
				method: "POST",
				path: "/mcp-clients/repair-devtool-dcr",
				summary: "Repair/tag/scope devtool DCR clients for an MCP server",
				description:
					"Find devtool DCR clients such as Codex/Claude Code/MCPJam on a Descope AIH MCP server, apply the server approved scopes and canonical tags, and return an audit trail. Defaults to dryRun=true.",
			})
			.input(
				z.object({
					mcpServerId: z.string(),
					clientNames: z
						.array(z.string().min(1))
						.default(["Codex", "Claude Code", "MCPJam"])
						.optional(),
					scopes: z.array(z.string()).optional(),
					tags: z.array(z.string()).optional(),
					pruneEmptyScopeClients: z.boolean().default(false).optional(),
					dryRun: z.boolean().default(true).optional(),
				}),
			)
			.output(
				z.object({
					dryRun: z.boolean(),
					mcpServerId: z.string(),
					serverName: z.string(),
					matched: z.number(),
					updated: z.number(),
					pruned: z.number(),
					skipped: z.number(),
					desiredScopes: z.array(z.string()),
					desiredTags: z.array(z.string()),
					actions: z.array(DescopeAihClientRepairActionSchema),
				}),
			),

		exchangeClientCredentials: oc
			.route({
				method: "POST",
				path: "/mcp-clients/exchange-token",
				summary: "Exchange client_credentials for an AIH access token",
			})
			.input(
				z.object({
					mcpServerId: z.string(),
					clientId: z.string(),
					clientSecret: z.string(),
				}),
			)
			.output(
				z.object({
					accessToken: z.string(),
					expiresIn: z.number(),
				}),
			),

		issueCiMcpCredential: oc
			.route({
				method: "POST",
				path: "/mcp-clients/issue-ci-credential",
				summary:
					"Issue a one-run Tedix Unified MCP credential for release smoke",
			})
			.input(
				z.object({
					clientName: z.string().min(1).optional(),
					mcpServerUrl: z.string().url(),
				}),
			)
			.output(
				z.object({
					accessToken: z.string(),
					clientId: z.string(),
					expiresIn: z.number(),
					mcpServerId: z.string(),
				}),
			),

		deleteCiMcpCredentialClient: oc
			.route({
				method: "POST",
				path: "/mcp-clients/delete-ci-credential-client",
				summary: "Delete a one-run release-smoke AIH MCP client",
			})
			.input(
				z.object({
					clientId: z.string().min(1),
					mcpServerId: z.string().min(1),
					mcpServerUrl: z.string().url(),
				}),
			)
			.output(z.object({ success: z.literal(true) })),

		auditDrift: oc
			.route({
				method: "POST",
				path: "/drift/audit",
				summary: "Read-only Descope AIH and Tedix D1 drift audit",
			})
			.input(z.object({}).optional())
			.output(DescopeAihDriftReportSchema),

		repairStaleFgaRelation: oc
			.route({
				method: "POST",
				path: "/drift/repair-stale-fga-relation",
				summary: "Delete one FGA relation whose app no longer exists",
				description:
					"Proof-gated repair for fga_relation_missing_d1_app findings. The mutation fails closed when the app still exists and defaults to a dry run.",
			})
			.input(
				z.object({
					appId: z.string().uuid(),
					targetUserId: z.string().min(1),
					relation: z.enum(["operator", "observer"]),
					dryRun: z
						.boolean()
						.default(true)
						.optional()
						.describe(
							"Defaults to true so callers must explicitly authorize the external FGA mutation.",
						),
				}),
			)
			.output(
				z.object({
					appId: z.string().uuid(),
					targetUserId: z.string(),
					relation: z.enum(["operator", "observer"]),
					dryRun: z.boolean(),
					deleted: z.boolean(),
				}),
			),

		auditOrganizationDrift: oc
			.route({
				method: "POST",
				path: "/drift/audit-organization",
				summary: "Read-only organization-scoped Descope AIH drift audit",
				description:
					"Reports only MCP resources and connection providers referenced by the caller organization. Global tenants, roles, unrelated clients, and unrelated FGA resources are excluded.",
			})
			.input(z.object({}).optional())
			.output(DescopeAihDriftReportSchema),

		reconcileMcpAppServers: oc
			.route({
				method: "POST",
				path: "/mcp-servers/reconcile-apps",
				summary:
					"Reconcile D1-owned MCP app server audiences, scopes, and tags",
				description:
					"Converge every D1-owned MCP app server to the complete exact Tedix audience set, optional connected-action platform scope set, and ownership tags. All approved scopes remain optional so machine clients receive only explicitly requested grants; standard identity scopes remain outside machine-client approved grants. Defaults to dry-run.",
			})
			.input(
				z.object({
					dryRun: z
						.boolean()
						.default(true)
						.optional()
						.describe(
							"Defaults to true so provider mutation requires explicit apply intent.",
						),
					appIds: z
						.array(z.uuid())
						.optional()
						.describe(
							"Optional bounded app selection; omission migrates every D1-owned MCP app.",
						),
				}),
			)
			.output(
				z.object({
					dryRun: z.boolean(),
					examined: z.number(),
					changed: z.number(),
					actions: z.array(DescopeAihMcpServerReconcileActionSchema),
				}),
			),
	});

export type DescopeAihContract = typeof descopeAihContract;

export {
	type ApprovedScopes,
	ApprovedScopesSchema,
	type DescopeAihClientAudit,
	DescopeAihClientAuditSchema,
	type DescopeAihClientRepairAction,
	DescopeAihClientRepairActionSchema,
	type DescopeAihDriftIssue,
	DescopeAihDriftIssueSchema,
	type DescopeAihDriftReport,
	DescopeAihDriftReportSchema,
	type McpServerRecord,
	McpServerRecordSchema,
	type McpServerScope,
	McpServerScopeSchema,
} from "../schemas/descope-aih";
