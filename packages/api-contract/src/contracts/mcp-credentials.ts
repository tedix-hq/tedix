import "@orpc/openapi/extensions/route";
/**
 * MCP Credentials Contract
 * Resolves auth headers for tedis connecting to MCP servers
 *
 * Auth: Descope tedi JWT or service binding — only tedi containers/workers should call this
 * Tagged "internal" — excluded from public OpenAPI spec
 */

import { oc } from "@orpc/contract";
import {
	ListServersInputSchema,
	ListServersOutputSchema,
	ResolveCredentialsInputSchema,
	ResolveCredentialsOutputSchema,
} from "../schemas/mcp-credentials";

export const mcpCredentialsContract = oc
	.route({ tags: ["internal", "mcp-credentials"], prefix: "/mcpCredentials" })
	.router({
		/**
		 * POST /mcpCredentials/resolve — Resolve auth headers for an MCP connection
		 *
		 * Given a tedi ID and target MCP server URL:
		 * 1. Parses the URL to extract the app slug from the subdomain
		 * 2. Checks if the tedi is the operator for that app
		 * 3. Returns AIH M2M auth headers for the assigned MCP server
		 */
		/**
		 * GET /mcpCredentials/listServers — List MCP servers assigned to a tedi
		 */
		listServers: oc
			.route({
				method: "GET",
				path: "/servers",
				summary: "List MCP servers assigned to a tedi",
			})
			.input(ListServersInputSchema)
			.output(ListServersOutputSchema),

		resolve: oc
			.route({
				method: "POST",
				path: "/resolve",
				summary: "Resolve MCP connection credentials for a tedi",
				description:
					"Returns auth headers a tedi should use when connecting to an MCP server. " +
					"Assigned app and peer tedi MCP servers use Descope AIH M2M credentials. " +
					"A Home-supervised child supplies its persisted dispatch tuple and receives a short-lived, audience-bound delegated bearer instead; missing authority fails closed.",
			})
			.input(ResolveCredentialsInputSchema)
			.output(ResolveCredentialsOutputSchema),
	});

export type McpCredentialsContract = typeof mcpCredentialsContract;
