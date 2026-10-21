import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ToolExecutionContext } from "./handler";
import { buildStructuredContent, buildTextContent } from "./handler-content";

function ctx(
	config: Partial<ToolConfig> = {},
): ToolExecutionContext<ToolConfig> {
	return {
		appId: "app_test",
		toolId: "list_items",
		config,
	} as ToolExecutionContext<ToolConfig>;
}

function freezeJson<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}

function payload() {
	return {
		rows: [
			{
				name: "first",
				details: { label: "raw" },
				offers: [
					{ id: 1, secret: "a" },
					{ id: 2, secret: "b" },
				],
			},
			{
				name: "second",
				details: { label: "original" },
				offers: [{ id: 3, secret: "c" }],
			},
		],
		meta: { total: 2 },
	};
}

const projection = ctx({
	responseMap: { rows: "items" },
	responseTransforms: [
		{
			arrayPath: "items",
			set: "details.label",
			template: "{details.label}:{name}",
		},
	],
	arrayLimits: { items: 1, "items[].offers": 1 },
	stripFields: ["items[].name", "items[].offers[].secret", "meta.total"],
	staticOutput: { items: ["fallback"], meta: { total: 99 }, source: "catalog" },
	modelSummaryTemplate: "{count:items} {items} {meta} {source}",
});

describe("structured content ownership", () => {
	it("shapes deeply frozen upstream objects in map, transform, limit, strip, defaults order", () => {
		const data = freezeJson(payload());
		expect(buildStructuredContent({ status: 200, data }, projection)).toEqual({
			items: [{ details: { label: "raw:first" }, offers: [{ id: 1 }] }],
			meta: {},
			source: "catalog",
		});
		expect(data).toEqual(payload());
	});

	it("preserves all upstream data for later projections and repeated transforms", () => {
		const data = payload();
		const result = { status: 200, data };
		const first = buildStructuredContent(result, projection);
		const second = buildStructuredContent(
			result,
			ctx({ responseMap: { rows: "all" } }),
		);
		expect(second).toEqual({ all: payload().rows, meta: { total: 2 } });
		expect(buildStructuredContent(result, projection)).toEqual(first);
		expect(data).toEqual(payload());
	});

	it("isolates nested arrays used as the root result", () => {
		const data = freezeJson([
			[{ label: "a" }, { label: "b" }],
			[{ label: "c" }],
		]);
		const result = { status: 200, data };
		expect(
			buildStructuredContent(result, ctx({ arrayLimits: { "data[]": 1 } })),
		).toEqual({
			data: [[{ label: "a" }], [{ label: "c" }]],
		});
		expect(buildStructuredContent(result, ctx())).toEqual({ data });
		expect(data[0]).toHaveLength(2);
	});

	it("wraps mapped scalar objects without sharing their nested data", () => {
		const data = freezeJson({ row: { details: { label: "raw" } } });
		expect(
			buildStructuredContent(
				{ status: 200, data },
				ctx({
					responseMap: { "row[]": "items" },
					responseTransforms: [
						{
							arrayPath: "items",
							set: "details.label",
							template: "{details.label}!",
						},
					],
				}),
			),
		).toEqual({ items: [{ details: { label: "raw!" } }] });
		expect(data.row.details.label).toBe("raw");
	});

	it.each([null, false, 0, "hello", [1, 2], []])(
		"keeps the wrapper shape for %j",
		(data) => {
			expect(buildStructuredContent({ status: 200, data }, ctx())).toEqual({
				data,
			});
		},
	);

	it("adds defaults after stripping and retains existing null, false and zero fields", () => {
		const data = freezeJson({
			removed: "upstream",
			nullable: null,
			enabled: false,
			count: 0,
		});
		expect(
			buildStructuredContent(
				{ status: 200, data },
				ctx({
					stripFields: ["removed"],
					staticOutput: {
						removed: "default",
						nullable: "fallback",
						enabled: true,
						count: 10,
					},
				}),
			),
		).toEqual({ removed: "default", nullable: null, enabled: false, count: 0 });
	});
});

describe("model text projection", () => {
	it("renders the shaped summary once per projection without altering raw or prior output", () => {
		const data = freezeJson(payload());
		const result = { status: 200, data };
		const structured = buildStructuredContent(result, projection);
		const expected =
			'1 [{"details":{"label":"raw:first"},"offers":[{"id":1}]}] {} catalog';
		expect(buildTextContent(result, projection)).toBe(expected);
		expect(buildTextContent(result, projection)).toBe(expected);
		expect(buildStructuredContent(result, projection)).toEqual(structured);
		expect(buildTextContent(result, ctx())).toBe(
			JSON.stringify(payload(), null, 2),
		);
	});

	it("renders missing and non-array counts, nulls and object placeholders", () => {
		expect(
			buildTextContent(
				{ status: 200, data: { meta: { total: 2 }, value: null } },
				ctx({
					modelSummaryTemplate:
						"{missing}/{value}/{count:meta}/{count:missing}/{meta}",
				}),
			),
		).toBe('//0/0/{"total":2}');
	});

	it("falls back to raw JSON if a custom shaping callback throws", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const result = { status: 200, data: payload() };
			expect(
				buildTextContent(result, projection, () => {
					throw new Error("synthetic failure");
				}),
			).toBe(JSON.stringify(result.data, null, 2));
		} finally {
			error.mockRestore();
		}
	});

	it.each([false, true])(
		"truncates only display text at 4,000 characters (summary=%s)",
		(summary) => {
			const data = { value: "x".repeat(5000) };
			const config = ctx(summary ? { modelSummaryTemplate: "{value}" } : {});
			const full = summary ? data.value : JSON.stringify(data, null, 2);
			expect(buildTextContent({ status: 200, data }, config)).toBe(
				`${full.slice(0, 4000)}\n[Truncated: showing first 4,000 of ${full.length.toLocaleString("en-US")} chars. Narrow the query with this tool's pagination/filter parameters, or call it via Code Mode and select only the fields you need.]`,
			);
			expect(buildStructuredContent({ status: 200, data }, config)).toEqual(
				data,
			);
		},
	);

	it.each([
		[{ error: "boom" }, "Error: boom"],
		[{ error: { message: "bad request" } }, 'Error: {"message":"bad request"}'],
		[
			{ error: { message: "x".repeat(600) } },
			`Error: ${JSON.stringify({ message: "x".repeat(600) }).slice(0, 500)}`,
		],
		[
			{ code: "BAD_REQUEST", message: "Invalid", data: {} },
			"BAD_REQUEST: Invalid",
		],
		[
			{ code: "CONFLICT", message: "Moved", data: { current: 2 } },
			'CONFLICT: Moved — {"current":2}',
		],
		[
			{ code: "CONFLICT", message: "Moved", data: { value: "x".repeat(400) } },
			`CONFLICT: Moved — ${JSON.stringify({ value: "x".repeat(400) }).slice(0, 300)}`,
		],
		[null, "Request failed with status 500"],
	])("preserves error rendering for %j", (data, text) => {
		expect(buildTextContent({ status: 500, data }, projection)).toBe(text);
	});
});
