import type { ToolJsonSchema } from "@tedix/api-contract/schemas/tools";
import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { normalizeOpenApiExternalArgs } from "./openapi-args";
import {
	applyInputSchemaDefaults,
	jsonSchemaToInputSchema,
	jsonSchemaToOutputSchema,
	validateStructuredContentAgainstOutputSchema,
} from "./schema";

describe("validateStructuredContentAgainstOutputSchema", () => {
	const outputSchema: ToolJsonSchema = {
		type: "object",
		properties: {
			success: { type: "boolean" },
			items: {
				type: "array",
				items: {
					type: "object",
					properties: {
						id: { type: "string" },
						count: { type: "integer" },
					},
					required: ["id", "count"],
					additionalProperties: false,
				},
			},
		},
		required: ["success", "items"],
		additionalProperties: false,
	};

	it("accepts structuredContent that matches outputSchema", () => {
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				outputSchema,
				{
					success: true,
					items: [{ id: "market-a", count: 2 }],
				},
				"valid_tool",
			),
		).not.toThrow();
	});

	it("rejects structuredContent that violates outputSchema", () => {
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				outputSchema,
				{
					success: true,
					items: [{ id: "market-a", count: "2" }],
				},
				"invalid_tool",
			),
		).toThrow(/invalid_tool.*outputSchema/);
	});

	it("accepts array structuredContent when outputSchema root is an array", () => {
		const arraySchema: ToolJsonSchema = {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
				},
				required: ["id"],
				additionalProperties: false,
			},
		};

		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				arraySchema,
				[{ id: "deployment_1" }],
				"array_tool",
			),
		).not.toThrow();
	});

	it("validates the transport's { data } envelope against a non-object root (github list_commits)", () => {
		// The upstream GitHub MCP server declares this root; the handler wraps
		// its array payload as { data } because MCP structuredContent must be an
		// object. Validating the envelope against the raw root rejected every
		// successful call with: Instance type "object" is invalid. Expected
		// "null", "array".
		const listCommitsSchema = {
			type: ["null", "array"],
			items: {
				type: "object",
				properties: {
					sha: { type: ["null", "string"] },
					commit: {
						type: ["null", "object"],
						properties: { message: { type: "string" } },
						required: ["message"],
						additionalProperties: false,
					},
				},
				additionalProperties: false,
			},
		} as unknown as ToolJsonSchema;

		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				listCommitsSchema,
				{
					data: [
						{ sha: "9b15a44", commit: { message: "fix(catalog): page by id" } },
					],
				},
				"github-tedix__list_commits",
			),
		).not.toThrow();
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				listCommitsSchema,
				{ data: null },
				"github-tedix__list_commits",
			),
		).not.toThrow();
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				listCommitsSchema,
				{ data: [{ sha: 42 }] },
				"github-tedix__list_commits",
			),
		).toThrow(/does not match outputSchema/);
	});

	it("accepts the envelope itself when a composed root matches it (work list rows)", () => {
		// `list_work_item_cli_rows` declares a oneOf root of object shapes and
		// returns an object envelope; unwrapping `data` here broke `tedix work`.
		const composed: ToolJsonSchema = {
			oneOf: [
				{
					type: "object",
					properties: { data: { type: "array" } },
					required: ["data"],
				},
				{
					type: "object",
					properties: { error: { type: "string" } },
					required: ["error"],
				},
			],
		} as ToolJsonSchema;
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				composed,
				{ data: [{ id: "x" }] },
				"work_rows",
			),
		).not.toThrow();
	});
	it("does not unwrap { data } when the root schema is an object", () => {
		const envelopeSchema: ToolJsonSchema = {
			type: "object",
			properties: { data: { type: "array", items: { type: "string" } } },
			required: ["data"],
			additionalProperties: false,
		};
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				envelopeSchema,
				{ data: ["a"] },
				"object_root",
			),
		).not.toThrow();
		expect(() =>
			validateStructuredContentAgainstOutputSchema(
				envelopeSchema,
				{ data: "a" },
				"object_root",
			),
		).toThrow(/does not match outputSchema/);
	});
});

describe("jsonSchemaToOutputSchema", () => {
	const nullableSchema: ToolJsonSchema = {
		type: "object",
		properties: {
			id: { type: "string" },
			descopeTenantId: {
				anyOf: [{ type: "string" }, { type: "null" }],
			},
			logoUrl: {
				type: ["string", "null"],
			},
		},
		required: ["id", "descopeTenantId", "logoUrl"],
		additionalProperties: false,
	};

	it("preserves nullable JSON Schema branches for SDK output validation", async () => {
		const schema = jsonSchemaToOutputSchema(nullableSchema);

		const result = await schema?.["~standard"].validate({
			id: "org_123",
			descopeTenantId: null,
			logoUrl: null,
		});
		expect(result?.issues).toBeUndefined();
	});

	it("rejects structuredContent that violates the schema", async () => {
		const schema = jsonSchemaToOutputSchema(nullableSchema);

		const result = await schema?.["~standard"].validate({
			id: "org_123",
			descopeTenantId: 42,
			logoUrl: null,
		});
		expect(result?.issues).toBeDefined();
	});

	it("advertises the raw D1 JSON Schema verbatim", () => {
		const schema = jsonSchemaToOutputSchema(nullableSchema);

		expect(
			schema?.["~standard"].jsonSchema.output({ target: "draft-2020-12" }),
		).toBe(nullableSchema);
	});

	it("does not pass non-object root schemas into SDK output registration", () => {
		const schema = jsonSchemaToOutputSchema({
			type: "array",
			items: { type: "object" },
		});

		expect(schema).toBeUndefined();
	});

	it("accepts primitive values inside records typed as additionalProperties: {}", async () => {
		// Regression: zod's z.record(z.string(), z.unknown()) serializes to
		// `{ type: "object", additionalProperties: {} }`. The empty inner schema
		// means "any value"; the old Zod converter wrongly rejected numeric
		// values in diagnostic summary counters with
		// "expected record, received number".
		const schema = jsonSchemaToOutputSchema({
			type: "object",
			properties: {
				entries: { type: "array", items: { type: "object" } },
				count: { type: "number" },
				processSummary: {
					type: "object",
					propertyNames: { type: "string" },
					additionalProperties: {},
				},
			},
			required: ["entries", "count"],
			additionalProperties: false,
		});

		const result = await schema?.["~standard"].validate({
			entries: [],
			count: 3,
			processSummary: {
				gatewayLiveCount: 1,
				gatewayRunningCount: 1,
				latestLiveProcessId: "proc-1",
				stale: false,
				nested: { ok: true },
			},
		});
		expect(result?.issues).toBeUndefined();
	});
});

describe("jsonSchemaToInputSchema", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const pageSizeSchema: ToolJsonSchema = {
		type: "object",
		properties: {
			limit: { type: "integer", enum: [10, 20, 50, 100] },
		},
	};

	it("advertises the raw D1 JSON Schema verbatim", () => {
		const stored: ToolJsonSchema = {
			type: "object",
			properties: {
				status: { type: "string", enum: ["open", "closed"] },
				ref: { anyOf: [{ type: "string" }, { type: "null" }] },
				slug: { type: "string", pattern: "^[a-z0-9-]+$" },
				count: { type: "integer", minimum: 1 },
			},
			required: ["status"],
		};
		const schema = jsonSchemaToInputSchema(stored, {
			toolId: "list_things",
			lenient: false,
		});

		expect(
			schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
		).toBe(stored);
	});

	it("normalizes external OpenAPI page-size enums before validation (the audited case)", async () => {
		const schema = jsonSchemaToInputSchema(pageSizeSchema, {
			toolId: "vendor_list",
			lenient: true,
			normalizeArgs: (args) =>
				normalizeOpenApiExternalArgs(args, pageSizeSchema),
		});

		const result = await schema["~standard"].validate({ limit: 5 });
		expect(result).toEqual({ value: { limit: 10 } });
	});

	it("invalid args for a config-driven tool return the SEP-1303 structured tool result on the wire", async () => {
		// End-to-end through the same seam production uses: D1 JSON Schema →
		// jsonSchemaToInputSchema → createMcpServer().registerTool → mountMcp.
		const server = createMcpServer({ name: "sep1303-test", version: "0.0.1" });
		server.registerTool(
			"native_list",
			{
				description: "List things",
				inputSchema: jsonSchemaToInputSchema(pageSizeSchema, {
					toolId: "native_list",
					lenient: false,
				}),
			},
			async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		);

		const res = await mountMcp(
			server,
			new Request("https://test.local/mcp", {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "native_list", arguments: { limit: 5 } },
				}),
			}),
			// Presence of `requiredClientExtensions` pins the hand-rolled engine —
			// the one production apps/mcp mounts (its options are extension-shaped);
			// a simple-shaped mount dispatches to the SDK's createMcpHandler, whose
			// legacy leg frames the response as SSE.
			{ requiredClientExtensions: [] },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			error?: unknown;
			result?: {
				isError?: boolean;
				content: Array<{ text: string }>;
				structuredContent?: {
					error: string;
					tool: string;
					issues: Array<{ message: string }>;
				};
				_meta?: Record<string, unknown>;
			};
		};
		// Tool Execution Error (isError result), never JSON-RPC -32602.
		expect(body.error).toBeUndefined();
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content[0]?.text).toMatch(
			/^Input validation error: Invalid arguments for tool native_list: /,
		);
		expect(body.result?.structuredContent).toMatchObject({
			error: "input_validation_error",
			tool: "native_list",
		});
		expect(body.result?.structuredContent?.issues[0]?.message).toBeTruthy();
		expect(body.result?._meta?.["com.tedix/error"]).toBe(
			"input_validation_error",
		);
	});

	it("rejects native numeric enum violations at the gate (fail-closed)", async () => {
		const schema = jsonSchemaToInputSchema(pageSizeSchema, {
			toolId: "native_list",
			lenient: false,
		});

		const result = await schema["~standard"].validate({ limit: 5 });
		expect(result.issues).toBeDefined();
		expect(result.issues?.length).toBeGreaterThan(0);
	});

	it("lenient class warns and passes invalid args through unchanged", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const schema = jsonSchemaToInputSchema(
			{
				type: "object",
				properties: {
					code: { type: "string", pattern: "^[A-Z]{3}$" },
				},
			},
			{ toolId: "vendor_lookup", lenient: true },
		);

		const result = await schema["~standard"].validate({ code: "nope" });
		expect(result).toEqual({ value: { code: "nope" } });
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]?.[0]).toContain("vendor_lookup");
	});

	it("merges defaults: missing keys, required-with-default, nested-in-present objects only", async () => {
		const schema = jsonSchemaToInputSchema(
			{
				type: "object",
				properties: {
					query: { type: "string" },
					limit: { type: "integer", default: 25 },
					options: {
						type: "object",
						properties: {
							depth: { type: "integer", default: 2 },
						},
					},
				},
				required: ["query", "limit"],
			},
			{ toolId: "search_things", lenient: false },
		);
		const validate = schema["~standard"].validate;

		// required-with-default merged pre-validation → passes
		expect(await validate({ query: "x" })).toEqual({
			value: { query: "x", limit: 25 },
		});
		// provided value not overwritten
		expect(await validate({ query: "x", limit: 50 })).toEqual({
			value: { query: "x", limit: 50 },
		});
		// nested default merged into a present object arg
		expect(await validate({ query: "x", options: {} })).toEqual({
			value: { query: "x", limit: 25, options: { depth: 2 } },
		});
		// nested default not merged when the object arg is absent (Zod parity)
		const absent = await validate({ query: "x" });
		expect(
			"value" in absent
				? (absent.value as Record<string, unknown>).options
				: "unexpected",
		).toBeUndefined();
	});

	it("strips unknown top-level keys unless additionalProperties permits extras", async () => {
		const base: ToolJsonSchema = {
			type: "object",
			properties: { query: { type: "string" } },
		};
		const strict = jsonSchemaToInputSchema(base, {
			toolId: "strip_tool",
			lenient: false,
		});
		expect(
			await strict["~standard"].validate({ query: "x", extra: 1 }),
		).toEqual({
			value: { query: "x" },
		});

		const open = jsonSchemaToInputSchema(
			{ ...base, additionalProperties: true },
			{ toolId: "open_tool", lenient: false },
		);
		expect(await open["~standard"].validate({ query: "x", extra: 1 })).toEqual({
			value: { query: "x", extra: 1 },
		});
	});

	it("preserves nested arguments for an upstream tool with an open object schema", async () => {
		// Descope's hosted management MCP currently advertises `session.args` as
		// an object with no declared properties. JSON Schema leaves that nested
		// object open, so project selection must retain args.projectId even while
		// Tedix strips unknown keys at the tool's top level.
		const schema = jsonSchemaToInputSchema(
			{
				type: "object",
				properties: {
					action: { type: "string" },
					args: { type: "object", properties: {} },
				},
				required: ["action"],
			},
			{ toolId: "session", lenient: true },
		);

		expect(
			await schema["~standard"].validate({
				action: "selectProject",
				args: { projectId: "P2example000000000000000000" },
				projectId: "must-be-dropped",
			}),
		).toEqual({
			value: {
				action: "selectProject",
				args: { projectId: "P2example000000000000000000" },
			},
		});
	});

	it("falls back to an empty object schema for a null stored schema (never undefined)", async () => {
		const schema = jsonSchemaToInputSchema(null, {
			toolId: "schemaless_tool",
			lenient: false,
		});

		expect(schema).toBeDefined();
		expect(
			schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
		).toEqual({
			type: "object",
			properties: {},
		});
		expect(await schema["~standard"].validate({ extra: 1 })).toEqual({
			value: {},
		});
	});

	it("rejects non-object arguments in both classes", async () => {
		for (const lenient of [false, true]) {
			const schema = jsonSchemaToInputSchema(pageSizeSchema, {
				toolId: "obj_only",
				lenient,
			});
			const result = await schema["~standard"].validate("nope");
			expect(result.issues?.[0]?.message).toContain("obj_only");
		}
	});
});

describe("applyInputSchemaDefaults", () => {
	it("returns the same reference when nothing merges", () => {
		const args = { query: "x" };
		expect(
			applyInputSchemaDefaults(args, {
				properties: { query: { type: "string" } },
			}),
		).toBe(args);
	});

	it("clones default values instead of sharing schema references", () => {
		const schema = {
			properties: { opts: { type: "object", default: { depth: 1 } } },
		};
		const merged = applyInputSchemaDefaults({}, schema);
		expect(merged.opts).toEqual({ depth: 1 });
		expect(merged.opts).not.toBe(
			(schema.properties.opts as Record<string, unknown>).default,
		);
	});
});
