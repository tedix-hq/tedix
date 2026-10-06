import { describe, expect, it } from "vite-plus/test";
import {
	McpInputRequiredError,
	McpToolError,
	stripCodeModeExecutionEnvelope,
	unwrapCallToolResult,
	unwrapJsonRpcToolResult,
} from "./tool-result";

const TOOL = "acme.list_widgets";

describe("unwrapCallToolResult", () => {
	it("passes toolResult through verbatim", () => {
		expect(unwrapCallToolResult({ toolResult: { ok: true } }, TOOL)).toEqual({
			ok: true,
		});
	});

	it("throws McpInputRequiredError on a halted MRTR result", () => {
		expect(() =>
			unwrapCallToolResult({ resultType: "input_required" }, TOOL),
		).toThrow(McpInputRequiredError);
	});

	it("throws on isError with ALL text parts joined", () => {
		expect(() =>
			unwrapCallToolResult(
				{
					isError: true,
					content: [
						{ type: "text", text: "boom" },
						{ type: "text", text: "details" },
					],
				},
				TOOL,
			),
		).toThrow("MCP tool error: boom\ndetails");
	});

	it("throws on isError even without text parts (previously the skill-runtime copy let these through)", () => {
		expect(() =>
			unwrapCallToolResult({ isError: true, content: [] }, TOOL),
		).toThrow("MCP tool error: Tool call failed");
	});

	it("prefers non-null structuredContent", () => {
		expect(
			unwrapCallToolResult(
				{
					structuredContent: { rows: [1, 2] },
					content: [{ type: "text", text: "ignored" }],
				},
				TOOL,
			),
		).toEqual({ rows: [1, 2] });
	});

	it("falls through null structuredContent to content", () => {
		expect(
			unwrapCallToolResult(
				{ structuredContent: null, content: [{ type: "text", text: "42" }] },
				TOOL,
			),
		).toBe(42);
	});

	it("joins multi-part text content and JSON-parses when possible", () => {
		expect(
			unwrapCallToolResult(
				{
					content: [
						{ type: "text", text: '{"a":' },
						{ type: "text", text: "1}" },
					],
				},
				TOOL,
			),
		).toEqual({ a: 1 });
		expect(
			unwrapCallToolResult(
				{
					content: [
						{ type: "text", text: "plain" },
						{ type: "text", text: "prose" },
					],
				},
				TOOL,
			),
		).toBe("plain\nprose");
	});

	it("returns mixed/non-text content arrays as-is", () => {
		const content = [{ type: "image", data: "…" }];
		expect(unwrapCallToolResult({ content }, TOOL)).toBe(content);
	});

	it("returns primitives and empty results unchanged", () => {
		expect(unwrapCallToolResult("raw", TOOL)).toBe("raw");
		const empty = { content: [] };
		expect(unwrapCallToolResult(empty, TOOL)).toBe(empty);
	});
});

describe("unwrapJsonRpcToolResult", () => {
	it("throws on a JSON-RPC protocol error", () => {
		expect(() =>
			unwrapJsonRpcToolResult(
				JSON.stringify({ error: { code: -32602, message: "bad params" } }),
				TOOL,
			),
		).toThrow("MCP tool error -32602: bad params");
	});

	it("is fail-soft on unparseable bodies", () => {
		expect(unwrapJsonRpcToolResult("not json", TOOL)).toBe("not json");
	});

	it("propagates input_required from the wrapped result", () => {
		expect(() =>
			unwrapJsonRpcToolResult(
				JSON.stringify({ result: { resultType: "input_required" } }),
				TOOL,
			),
		).toThrow(McpInputRequiredError);
	});

	// The cross-surface contract that kills the shape-mismatch class: the
	// JSON-RPC layer is EXACTLY the CallToolResult layer over parsed.result —
	// any fixture must normalize identically through both.
	it("normalizes identically to unwrapCallToolResult for every fixture", () => {
		const fixtures: unknown[] = [
			{ toolResult: { ok: 1 } },
			{ structuredContent: { rows: [] } },
			{ structuredContent: null, content: [{ type: "text", text: "7" }] },
			{
				content: [
					{ type: "text", text: "a" },
					{ type: "text", text: "b" },
				],
			},
			{ content: [{ type: "image", data: "x" }] },
			{ plain: "object" },
		];
		for (const fixture of fixtures) {
			expect(
				unwrapJsonRpcToolResult(JSON.stringify({ result: fixture }), TOOL),
			).toEqual(unwrapCallToolResult(fixture, TOOL));
		}
	});
});

describe("stripCodeModeExecutionEnvelope", () => {
	it("strips the aggregate code-tool envelope", () => {
		expect(
			stripCodeModeExecutionEnvelope({ executionId: "e1", result: { a: 1 } }),
		).toEqual({
			a: 1,
		});
	});

	it("leaves everything else untouched", () => {
		expect(stripCodeModeExecutionEnvelope({ executionId: "e1" })).toEqual({
			executionId: "e1",
		});
		expect(stripCodeModeExecutionEnvelope({ result: 1 })).toEqual({
			result: 1,
		});
		expect(stripCodeModeExecutionEnvelope("raw")).toBe("raw");
	});
});

it("preserves native error codes and lock details", () => {
	try {
		unwrapCallToolResult(
			{
				isError: true,
				content: [{ type: "text", text: "[ENTRY_LOCKED] Ada" }],
				_meta: { code: "ENTRY_LOCKED", details: { holder: "Ada" } },
			},
			TOOL,
		);
		throw new Error("Expected refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(McpToolError);
		expect((error as McpToolError).code).toBe("ENTRY_LOCKED");
		expect((error as McpToolError).details).toEqual({ holder: "Ada" });
	}
});
