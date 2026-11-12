import { describe, expect, it } from "vite-plus/test";
import { mcpToolsListResultTransform } from "./mcp-result-transform";

const transform = mcpToolsListResultTransform([], undefined, new Headers());
type TransformInput = Parameters<typeof transform>[0];

function call(result: Record<string, unknown>) {
	return transform({
		request: {
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "example" },
		},
		response: { jsonrpc: "2.0", id: 7, result },
	} as TransformInput);
}

describe("MCP wire result transformation", () => {
	it("rewrites input-required markers and preserves human-readable content", () => {
		const content = [{ type: "text", text: "Confirm deletion" }];
		expect(
			call({
				content,
				_meta: {
					"tedix/inputRequired": {
						requestState: "state",
						inputRequests: { confirmation: { title: "Confirm" } },
					},
				},
			}),
		).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {
				resultType: "input_required",
				requestState: "state",
				inputRequests: { confirmation: { title: "Confirm" } },
				content,
			},
		});
	});

	it("defaults missing approval requests and omits non-array content", () => {
		expect(
			call({
				content: "ignored",
				_meta: { "tedix/inputRequired": { requestState: "state" } },
			}),
		).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {
				resultType: "input_required",
				requestState: "state",
				inputRequests: {},
			},
		});
	});

	it("rewrites generic task status and timing fields", () => {
		expect(
			call({
				_meta: {
					"tedix/genericTask": {
						taskId: "task-1",
						status: "completed",
						createdAt: "created",
						lastUpdatedAt: "updated",
						ttlMs: 1000,
						pollIntervalMs: 20,
					},
				},
			}),
		).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {
				resultType: "task",
				taskId: "task-1",
				status: "completed",
				createdAt: "created",
				lastUpdatedAt: "updated",
				ttlMs: 1000,
				pollIntervalMs: 20,
			},
		});
	});

	it("uses the existing task defaults for absent optional fields", () => {
		expect(
			call({ _meta: { "tedix/genericTask": { taskId: "task-1" } } }),
		).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: {
				resultType: "task",
				taskId: "task-1",
				status: "working",
				createdAt: undefined,
				lastUpdatedAt: undefined,
				ttlMs: null,
			},
		});
	});

	it.each([
		{ content: [] },
		{ _meta: { "tedix/inputRequired": { requestState: 1 } } },
		{ _meta: { "tedix/genericTask": { taskId: 1 } } },
	])("leaves ordinary results and malformed markers unchanged", (result) => {
		expect(call(result)).toEqual({ jsonrpc: "2.0", id: 7, result });
	});

	it("passes through protocol errors and unrelated methods by identity", () => {
		const response = {
			jsonrpc: "2.0",
			id: 7,
			error: { code: -32602, message: "Invalid params" },
		} as TransformInput["response"];
		expect(
			transform({
				request: { jsonrpc: "2.0", id: 7, method: "tools/call" },
				response,
			} as TransformInput),
		).toBe(response);
		const ordinary = {
			jsonrpc: "2.0",
			id: 7,
			result: { value: 1 },
		} as TransformInput["response"];
		expect(
			transform({
				request: { jsonrpc: "2.0", id: 7, method: "resources/list" },
				response: ordinary,
			} as TransformInput),
		).toBe(ordinary);
	});
});

it("keeps advisory inferred schemas out of normative tools/list output schemas", () => {
	const transform = mcpToolsListResultTransform(
		[
			{
				toolId: "example",
				outputSchema: { type: "object", "x-tedix-provenance": "inferred" },
			},
		],
		undefined,
		new Headers(),
	);
	const result = transform({
		request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		response: {
			jsonrpc: "2.0",
			id: 1,
			result: { tools: [{ name: "example", inputSchema: { type: "object" } }] },
		},
	} as TransformInput);
	expect(result).toMatchObject({ result: { tools: [{ name: "example" }] } });
	expect(JSON.stringify(result)).not.toContain("outputSchema");
});

it("returns a version-only reply only for a matching first-page conditional read", () => {
	const transform = mcpToolsListResultTransform(
		[],
		undefined,
		new Headers(),
		"v1",
	);
	const invoke = (params: Record<string, unknown>) =>
		transform({
			request: { jsonrpc: "2.0", id: 1, method: "tools/list", params },
			response: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [{ name: "example", inputSchema: { type: "object" } }],
				},
			},
		} as TransformInput);
	expect(invoke({ _meta: { "com.tedix/catalogVersion": "v1" } })).toMatchObject(
		{
			result: {
				tools: [],
				_meta: {
					"com.tedix/catalogVersion": "v1",
					"com.tedix/catalogUnchanged": true,
				},
			},
		},
	);
	expect(invoke({ _meta: { "com.tedix/catalogVersion": "v0" } })).toMatchObject(
		{
			result: {
				tools: [{ name: "example" }],
				_meta: { "com.tedix/catalogVersion": "v1" },
			},
		},
	);
});
