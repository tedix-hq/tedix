import { describe, expect, it } from "vite-plus/test";
import {
	codeModeCanonicalDescribeParams,
	codeModeDescribeParams,
	codeModeDiscoveryParams,
	codeModeExecutionParams,
	parseCodeModeCatalog,
	writeDiscoveryQuery,
} from "./write-codemode";

async function runGenerated(params: Record<string, unknown>, discover: object) {
	const args = params.arguments as { code: string };
	return await new Function("discover", `return (${args.code})()`)(discover);
}

describe("write discovery contracts", () => {
	it("keeps JavaScript delimiters and HTML tags as argument data", async () => {
		const value =
			'\"); throw new Error("injected"); // </script><script> & \\ \n\u2028\u2029';
		await runGenerated(codeModeDiscoveryParams(value), {
			search: async (input: { query: string }) => {
				expect(input.query).toBe(value);
				return [];
			},
		});
		const params = codeModeExecutionParams("tools.write", { value });
		const source = (params.arguments as { code: string }).code;
		const result = await new Function("tools", `return (${source})()`)({
			write: async (input: unknown) => input,
		});
		expect(result).toEqual({ value });
	});
	it("uses literal namespace-only discovery for a known primitive", async () => {
		const params = codeModeCanonicalDescribeParams("os.create_os_output");
		expect((params.arguments as { code: string }).code).toBe(
			'async () => await discover.describe({"callable":"os.create_os_output"})',
		);
		const result = await runGenerated(params, {
			describe: async () => ({
				callable: "os.create_os_output",
				parameters: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			}),
		});
		expect(
			parseCodeModeCatalog({
				content: [{ type: "text", text: JSON.stringify(result) }],
			}),
		).toEqual([
			{
				name: "os.create_os_output",
				inputSchema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
		]);
	});
	it.each([false, true])(
		"reads compact search envelope (legacy array=%s)",
		async (legacy) => {
			const rows = [
				{
					callable: "os.create_os_output",
					parameters: { properties: { kind: { enum: ["document"] } } },
				},
			];
			const result = await runGenerated(
				codeModeDiscoveryParams("create output"),
				{
					search: async () =>
						legacy ? rows : { results: rows, namespaces: {}, meta: {} },
				},
			);
			expect(result[0].callable).toBe("os.create_os_output");
		},
	);
	it("drops reads and skills before the planner's cut", async () => {
		const rows = [
			...Array.from({ length: 12 }, (_, i) => ({
				callable: `work.get_${i}`,
				annotations: { readOnlyHint: true },
			})),
			{ name: "a skill without a callable" },
			{ callable: "work.create_work_items", annotations: {} },
		];
		const result = await runGenerated(codeModeDiscoveryParams("q"), {
			search: async () => rows,
		});
		expect(result.map((row: { callable: string }) => row.callable)).toEqual([
			"work.create_work_items",
		]);
	});
	it("searches the action, not quoted values or ids", () => {
		expect(
			writeDiscoveryQuery({
				capability: null,
				content:
					'Create a Work item titled "Edit the video" in project bae23084-9c10-4bc9-a7c5-351bf6b9d63b',
			}),
		).toBe("Create a Work item titled in project");
		expect(
			writeDiscoveryQuery({ capability: "work_items.create", content: "x" }),
		).toBe("work items create");
	});
	it("fetches one exact schema without dropping union constraints", async () => {
		const parameters = {
			type: "object",
			properties: {
				content: {
					anyOf: [
						{
							type: "object",
							properties: { kind: { const: "document" } },
							required: ["kind"],
						},
					],
				},
			},
			required: ["content"],
		};
		const result = await runGenerated(
			codeModeDescribeParams("os.create_os_output"),
			{
				describe: async (input: { callable: string }) => {
					expect(input.callable).toBe("os.create_os_output");
					return {
						callable: input.callable,
						parameters,
						outputSchema: { large: "omit" },
					};
				},
			},
		);
		expect(result).toEqual([{ callable: "os.create_os_output", parameters }]);
	});
});

it.each([
	codeModeDiscoveryParams("notion update"),
	codeModeDescribeParams("notion.notion_update_page"),
	codeModeCanonicalDescribeParams("notion_update_page"),
	codeModeCanonicalDescribeParams("notion.notion_update_page"),
])(
	"preserves approval facts across generated discovery and catalog parsing",
	async (params) => {
		const metadata = {
			"com.tedix/policy": {
				riskTier: "bounded_write",
				blastRadius: "single_resource",
				argumentPolicy: "notion_page_update",
			},
			"com.tedix/connectedTool": {
				providerId: "notion",
				toolName: "notion-update-page",
			},
		};
		const hit = {
			callable: "notion.notion_update_page",
			annotations: { readOnlyHint: false, destructiveHint: true },
			_meta: metadata,
		};
		const result = await runGenerated(params, {
			search: async () => [hit],
			describe: async () => hit,
		});
		expect(
			parseCodeModeCatalog({
				content: [{ type: "text", text: JSON.stringify(result) }],
			})[0]?._meta,
		).toEqual(metadata);
	},
);
