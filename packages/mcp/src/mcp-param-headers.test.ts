/**
 * SEP-2243 `Mcp-Param-*` derivation — pure-function unit tests.
 *
 * Integration coverage lives with the consumers:
 * `packages/mcp-client-core/test/modern-protocol.test.ts` (stateless client)
 * and `apps/mcp/src/mcp/handler-mcp.test.ts` (upstream proxy).
 */
import { describe, expect, it } from "vite-plus/test";
import {
	buildMcpParamHeaders,
	collectMcpHeaderBindings,
	decodeMcpHeaderValue,
	encodeMcpHeaderValue,
	validateInboundMcpParamHeaders,
} from "./mcp-param-headers";

describe("collectMcpHeaderBindings", () => {
	it("collects bindings on statically reachable primitive properties", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				region: { type: "string", "x-mcp-header": "Region" },
				count: { type: "integer", "x-mcp-header": "Count" },
				nested: {
					type: "object",
					properties: {
						flag: { type: "boolean", "x-mcp-header": "Flag" },
					},
				},
				plain: { type: "string" },
			},
		});

		expect(result).toEqual({
			ok: true,
			bindings: [
				{ headerName: "Region", path: ["region"], type: "string" },
				{ headerName: "Count", path: ["count"], type: "integer" },
				{ headerName: "Flag", path: ["nested", "flag"], type: "boolean" },
			],
		});
	});

	it("rejects bindings that are not statically reachable (array items)", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				items: {
					type: "array",
					items: { type: "string", "x-mcp-header": "Item" },
				},
			},
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("rejects bindings inside combinators", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				choice: {
					anyOf: [{ type: "string", "x-mcp-header": "Choice" }],
				},
			},
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("rejects a root-level binding", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			"x-mcp-header": "Root",
			properties: {},
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("rejects invalid HTTP field-name tokens", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				tenant: { type: "string", "x-mcp-header": "Bad Header" },
			},
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("rejects non-primitive property types", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				payload: { type: "object", "x-mcp-header": "Payload" },
			},
		});
		expect(result).toMatchObject({ ok: false });
	});

	it("rejects case-insensitively duplicated header names", () => {
		const result = collectMcpHeaderBindings({
			type: "object",
			properties: {
				a: { type: "string", "x-mcp-header": "Tenant" },
				b: { type: "string", "x-mcp-header": "tenant" },
			},
		});
		expect(result).toMatchObject({ ok: false });
	});
});

describe("encodeMcpHeaderValue", () => {
	it("passes plain-safe strings, booleans, and safe integers through", () => {
		expect(encodeMcpHeaderValue("eu-west1")).toBe("eu-west1");
		expect(encodeMcpHeaderValue(true)).toBe("true");
		expect(encodeMcpHeaderValue(false)).toBe("false");
		expect(encodeMcpHeaderValue(42)).toBe("42");
	});

	it("base64-wraps non-ASCII, padded, and sentinel-shaped strings", () => {
		expect(encodeMcpHeaderValue("Hello, 世界")).toBe(
			"=?base64?SGVsbG8sIOS4lueVjA==?=",
		);
		expect(encodeMcpHeaderValue(" padded ")).toBe("=?base64?IHBhZGRlZCA=?=");
		expect(encodeMcpHeaderValue("=?base64?fake?=")).toBe(
			"=?base64?PT9iYXNlNjQ/ZmFrZT89?=",
		);
	});

	it("returns undefined for non-representable values", () => {
		expect(encodeMcpHeaderValue(null)).toBeUndefined();
		expect(encodeMcpHeaderValue(undefined)).toBeUndefined();
		expect(encodeMcpHeaderValue(1.5)).toBeUndefined();
		expect(encodeMcpHeaderValue({})).toBeUndefined();
		expect(encodeMcpHeaderValue([])).toBeUndefined();
	});
});

describe("decodeMcpHeaderValue", () => {
	it("passes non-sentinel values through unchanged", () => {
		expect(decodeMcpHeaderValue("eu-west1")).toBe("eu-west1");
		expect(decodeMcpHeaderValue("true")).toBe("true");
	});

	it("decodes the =?base64?…?= sentinel form (round-trips the encoder)", () => {
		expect(decodeMcpHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?=")).toBe(
			"Hello, 世界",
		);
		expect(decodeMcpHeaderValue("=?base64?IHBhZGRlZCA=?=")).toBe(" padded ");
		// A literal sentinel-shaped value encodes then decodes back to itself.
		expect(decodeMcpHeaderValue("=?base64?PT9iYXNlNjQ/ZmFrZT89?=")).toBe(
			"=?base64?fake?=",
		);
	});

	it("returns undefined for a sentinel with a non-canonical or invalid payload", () => {
		expect(decodeMcpHeaderValue("=?base64?not-base64!?=")).toBeUndefined();
		// Non-canonical padding.
		expect(decodeMcpHeaderValue("=?base64?QQ?=")).toBeUndefined();
		// Valid Base64 but invalid UTF-8 (lone continuation byte).
		expect(decodeMcpHeaderValue("=?base64?gA==?=")).toBeUndefined();
	});
});

describe("buildMcpParamHeaders", () => {
	const schema = {
		type: "object",
		properties: {
			tenant: { type: "string", "x-mcp-header": "Tenant" },
			token: { type: "string", "x-mcp-header": "Auth-Token" },
			query: { type: "string" },
		},
	};

	it("builds the prefixed header map from the final args object", () => {
		expect(
			buildMcpParamHeaders(schema, {
				tenant: "org_tedix",
				token: "päss",
				query: "select 1",
			}),
		).toEqual({
			"Mcp-Param-Tenant": "org_tedix",
			"Mcp-Param-Auth-Token": "=?base64?cMOkc3M=?=",
		});
	});

	it("omits headers for absent or non-representable args", () => {
		expect(buildMcpParamHeaders(schema, { query: "select 1" })).toEqual({});
	});

	it("binds nothing for an absent or malformed schema (fail-safe)", () => {
		expect(buildMcpParamHeaders(undefined, { tenant: "x" })).toEqual({});
		expect(
			buildMcpParamHeaders(
				{
					type: "object",
					properties: {
						a: { type: "string", "x-mcp-header": "Dup" },
						b: { type: "string", "x-mcp-header": "dup" },
					},
				},
				{ a: "1", b: "2" },
			),
		).toEqual({});
	});
});

describe("validateInboundMcpParamHeaders", () => {
	const schema = {
		type: "object",
		properties: {
			api_key: { type: "string", "x-mcp-header": "Api-Key" },
			count: { type: "integer", "x-mcp-header": "Count" },
			plain: { type: "string" },
		},
		required: ["api_key"],
	};
	const H = (init: Record<string, string>) => new Headers(init);

	it("accepts a matching literal header", () => {
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello" },
				H({ "Mcp-Param-Api-Key": "Hello" }),
			),
		).toBeUndefined();
	});

	it("accepts a matching Base64-sentinel header", () => {
		const b64 = Buffer.from("Hello").toString("base64");
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello" },
				H({ "Mcp-Param-Api-Key": `=?base64?${b64}?=` }),
			),
		).toBeUndefined();
	});

	it("rejects when the bound header is omitted but the body carries a value", () => {
		const v = validateInboundMcpParamHeaders(
			schema,
			{ api_key: "Hello" },
			H({}),
		);
		expect(v?.code).toBe(-32020);
		expect(v?.data.mismatch.header).toBe("Mcp-Param-Api-Key");
	});

	it("rejects an invalid Base64 sentinel payload (bad padding / non-alphabet)", () => {
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello" },
				H({ "Mcp-Param-Api-Key": "=?base64?SGVsbG8?=" }),
			)?.code,
		).toBe(-32020);
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello" },
				H({ "Mcp-Param-Api-Key": "=?base64?SGVs!!!bG8=?=" }),
			)?.code,
		).toBe(-32020);
	});

	it("rejects a header that decodes to a different value than the body", () => {
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello" },
				H({ "Mcp-Param-Api-Key": "Goodbye" }),
			)?.code,
		).toBe(-32020);
	});

	it("compares integer-typed bindings numerically (42.0 == 42)", () => {
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello", count: 42 },
				H({ "Mcp-Param-Api-Key": "Hello", "Mcp-Param-Count": "42.0" }),
			),
		).toBeUndefined();
	});

	it("ignores a header when the body value is null or absent", () => {
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "Hello", count: null as unknown as number },
				H({ "Mcp-Param-Api-Key": "Hello", "Mcp-Param-Count": "stale" }),
			),
		).toBeUndefined();
	});

	it("treats a non-sentinel value as a literal (no accidental decode)", () => {
		// A literal that merely resembles Base64 must compare as-is.
		expect(
			validateInboundMcpParamHeaders(
				schema,
				{ api_key: "SGVsbG8=" },
				H({ "Mcp-Param-Api-Key": "SGVsbG8=" }),
			),
		).toBeUndefined();
	});

	it("is a fail-safe no-op for absent schema, no bindings, or malformed bindings", () => {
		expect(
			validateInboundMcpParamHeaders(undefined, { api_key: "x" }, H({})),
		).toBeUndefined();
		expect(
			validateInboundMcpParamHeaders(
				{ type: "object", properties: { plain: { type: "string" } } },
				{ plain: "x" },
				H({}),
			),
		).toBeUndefined();
		// Duplicate header names → collectMcpHeaderBindings fails → validate nothing.
		expect(
			validateInboundMcpParamHeaders(
				{
					type: "object",
					properties: {
						a: { type: "string", "x-mcp-header": "Dup" },
						b: { type: "string", "x-mcp-header": "dup" },
					},
				},
				{ a: "1", b: "2" },
				H({}),
			),
		).toBeUndefined();
	});
});
