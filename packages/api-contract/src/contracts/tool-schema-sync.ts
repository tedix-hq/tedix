import "@orpc/openapi/extensions/route";
/**
 * Tool schema sync contract.
 *
 * Generates app_tools input/output schemas from their upstream source contracts.
 * For now this supports rpc-transport tools backed by Tedix oRPC contracts.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";

export const ToolSchemaSyncTargetSchema = z
	.enum(["input", "output", "both"])
	.default("both");

export const ToolSchemaSyncSourceSchema = z.enum(["rpc"]).default("rpc");

export const ToolSchemaSyncModeSchema = z
	.enum(["schema", "projection"])
	.default("schema");

export const ToolSchemaSyncWidgetOverrideSchema = z.object({
	layoutId: z.string().min(1),
	description: z.string().optional(),
	layoutSpec: z.record(z.string(), z.unknown()),
});

export const ToolSchemaSyncInputSchema = z.object({
	appId: z
		.string()
		.uuid()
		.optional()
		.describe("App UUID. Defaults to the Tedix admin app."),
	mode: ToolSchemaSyncModeSchema.optional().describe(
		"`schema` refreshes existing rows and prunes stale oRPC-backed rows. `projection` previews or upserts full app_tools rows from oRPC contracts.",
	),
	source: ToolSchemaSyncSourceSchema.optional().describe(
		"Schema source to sync. Only rpc is implemented today.",
	),
	target: ToolSchemaSyncTargetSchema.optional().describe(
		"Which schema columns to regenerate.",
	),
	apply: z
		.boolean()
		.optional()
		.describe("When false, return a preview plan without writing D1."),
	toolIds: z
		.array(z.string().min(1))
		.optional()
		.describe("Optional logical app_tools.tool_id allowlist."),
	router: z
		.string()
		.optional()
		.describe("Optional top-level oRPC router allowlist."),
	endpoints: z
		.array(z.string().min(3))
		.max(1000)
		.optional()
		.describe(
			"Optional explicit oRPC endpoint allowlist, e.g. toolSchemaSync/preview.",
		),
	toolIdOverrides: z
		.record(z.string().min(3), z.string().min(1))
		.optional()
		.describe(
			"Projection mode only: map oRPC endpoint paths to stable app_tools.tool_id values.",
		),
	kindOverrides: z
		.record(z.string().min(3), z.enum(["read", "write", "destructive"]))
		.optional()
		.describe(
			"Projection mode only: map oRPC endpoint paths to MCP annotation intent.",
		),
	widgetOverrides: z
		.record(z.string().min(3), ToolSchemaSyncWidgetOverrideSchema)
		.optional()
		.describe(
			"Projection mode only: map oRPC endpoint paths to persisted json-render widget overlays.",
		),
	includeInternal: z
		.boolean()
		.optional()
		.describe(
			"Projection mode only: include oRPC procedures tagged internal. Defaults to true; pass false only for narrow public-surface previews.",
		),
	regenerateToolIds: z
		.boolean()
		.optional()
		.describe(
			"Projection mode only: aggressively rename existing rows to the generated/override tool_id instead of preserving the stored name. Renames in place by row id.",
		),
	pruneStale: z
		.boolean()
		.optional()
		.describe(
			"Schema mode only: delete rpc app_tools rows whose config.endpoint no longer resolves to an oRPC contract. Defaults to true.",
		),
	limit: z
		.number()
		.int()
		.positive()
		.max(1000)
		.optional()
		.describe("Maximum number of rows to update."),
});

export const ToolSchemaSyncItemSchema = z.object({
	toolUuid: z.string().nullable(),
	toolId: z.string(),
	endpoint: z.string().nullable(),
	status: z.enum([
		"inSync",
		"wouldCreate",
		"created",
		"wouldUpdate",
		"updated",
		"wouldDelete",
		"deleted",
		"skipped",
		"noContract",
		"converterUnsupported",
		"failed",
	]),
	changed: z.array(
		z.enum([
			"title",
			"description",
			"inputSchema",
			"outputSchema",
			"config",
			"annotations",
			"meta",
			"authRequired",
			"visibility",
			"schemaSource",
			"widget",
		]),
	),
	message: z.string().optional(),
});

export const ToolSchemaSyncResultSchema = z.object({
	appId: z.string(),
	mode: z.enum(["schema", "projection"]),
	source: z.enum(["rpc"]),
	target: z.enum(["input", "output", "both"]),
	apply: z.boolean(),
	total: z.number().int(),
	planned: z.number().int(),
	created: z.number().int(),
	updated: z.number().int(),
	deleted: z.number().int(),
	inSync: z.number().int(),
	skipped: z.number().int(),
	failed: z.number().int(),
	items: z.array(ToolSchemaSyncItemSchema),
});

export const ToolSchemaSyncCheckResultSchema = z.object({
	passed: z.boolean(),
	message: z.string(),
	result: ToolSchemaSyncResultSchema,
});

export type ToolSchemaSyncInput = z.infer<typeof ToolSchemaSyncInputSchema>;
export type ToolSchemaSyncResult = z.infer<typeof ToolSchemaSyncResultSchema>;
export type ToolSchemaSyncCheckResult = z.infer<
	typeof ToolSchemaSyncCheckResultSchema
>;

export const toolSchemaSyncContract = oc
	.route({ tags: ["tool-schema-sync", "internal"] })
	.router({
		preview: oc
			.route({
				method: "POST",
				path: "/tool-schema-sync/preview",
				summary: "Preview tool schema sync",
				description:
					"Preview app_tools schema changes generated from source contracts without writing D1.",
			})
			.input(
				ToolSchemaSyncInputSchema.omit({ apply: true }).extend({
					apply: z.literal(false).optional(),
				}),
			)
			.output(ToolSchemaSyncResultSchema),

		check: oc
			.route({
				method: "POST",
				path: "/tool-schema-sync/check",
				summary: "Check tool schema drift",
				description:
					"Check generated app_tools schemas against source contracts. Returns passed=false when any drift or unresolved row remains.",
			})
			.input(
				ToolSchemaSyncInputSchema.omit({ apply: true }).extend({
					apply: z.literal(false).optional(),
				}),
			)
			.output(ToolSchemaSyncCheckResultSchema),

		run: oc
			.route({
				method: "POST",
				path: "/tool-schema-sync/run",
				summary: "Run tool schema sync",
				description:
					"Start a Cloudflare Workflow that regenerates app_tools schemas from source contracts.",
			})
			.input(ToolSchemaSyncInputSchema)
			.output(
				z.object({
					workflowId: z.string(),
					status: z.enum(["queued", "running"]),
					message: z.string(),
				}),
			),
	});

export type ToolSchemaSyncContract = typeof toolSchemaSyncContract;
