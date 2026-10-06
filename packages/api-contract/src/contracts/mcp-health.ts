import "@orpc/openapi/extensions/route";
/**
 * MCP Health Check Contract
 *
 * Runs deterministic health checks against any app's MCP server:
 * connectivity, tool listing, schema validation, expected tools.
 * No LLM needed — pure protocol-level verification.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";

const CheckResultSchema = z.object({
	name: z.string(),
	passed: z.boolean(),
	detail: z.string(),
	durationMs: z.number(),
	data: z.record(z.string(), z.unknown()).optional(),
});

export const mcpHealthContract = oc
	.route({ tags: ["mcp-health", "internal"] })
	.router({
		/**
		 * Run MCP health checks against an app's MCP server.
		 * Connects via Streamable HTTP, verifies tools, schemas, and connectivity.
		 */
		run: oc
			.input(
				z.object({
					appSlug: z
						.string()
						.describe("App slug to health-check (e.g. 'find', 'tedix')"),
					expectedTools: z
						.array(z.string())
						.optional()
						.describe("Tool names that must be present (optional)"),
					connectionId: z
						.string()
						.optional()
						.describe(
							"Connection provider ID for authenticated probes (e.g. 'notion', 'cloudflare'). When provided, resolves credentials via Descope Token Vault and sends Authorization header.",
						),
					tediId: z
						.string()
						.optional()
						.describe(
							"Tedi ID whose credentials to use for authenticated probes",
						),
					scope: z
						.enum(["tenant", "user"])
						.optional()
						.describe(
							"Token scope: 'user' for OAuth personal tokens, 'tenant' for org-level tokens. Defaults to 'tenant'.",
						),
					authStrategy: z
						.enum(["auto", "none", "service", "connection"])
						.optional()
						.describe(
							"Probe authentication strategy. auto uses internal service-binding auth for protected Tedix MCP apps and connection auth only when explicitly configured.",
						),
					resourceUri: z
						.string()
						.optional()
						.describe("Optional resource URI that must read successfully."),
					missingResourceUri: z
						.string()
						.optional()
						.describe(
							"Optional missing resource URI expected to fail with JSON-RPC InvalidParams (-32602).",
						),
					tasksExtension: z
						.enum(["absent", "present", "ignore"])
						.optional()
						.describe(
							"Expected io.modelcontextprotocol/tasks advertisement in server/discover for latestSpec probes. Defaults to 'absent' unless this probe targets a surface expected to mount Tasks handlers.",
						),
				}),
			)
			.output(
				z.object({
					app: z.string(),
					url: z.string(),
					toolCount: z
						.number()
						.int()
						.nonnegative()
						.nullable()
						.describe(
							"Tool count returned by a successful tools/list check; null when discovery did not produce a verified inventory.",
						),
					allPassed: z.boolean(),
					passCount: z.number(),
					failCount: z.number(),
					totalDurationMs: z.number(),
					checks: z.array(CheckResultSchema),
				}),
			),
	});

export type McpHealthContract = typeof mcpHealthContract;
