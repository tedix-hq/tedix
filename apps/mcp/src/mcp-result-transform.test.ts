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
