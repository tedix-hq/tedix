import { describe, expect, it } from "vite-plus/test";
import {
	codeModeCanonicalDescribeParams,
	codeModeDescribeParams,
	codeModeDiscoveryParams,
	codeModeExecutionParams,
	codeModeResultHandle,
	codeModeReadResultParams,
	parseCodeModeCatalog,
	parseCodeModeCatalogValue,
	readCodeModeResultPages,
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

describe("schemas kept behind a Code Mode result handle", () => {
	const wrap = (result: unknown) => ({
		structuredContent: { executionId: "exec-1", result },
	});
	const entry = {
		callable: "apps.update_app",
		annotations: { readOnlyHint: false },
		parameters: {
			type: "object",
			properties: { appId: { type: "string" } },
			required: ["appId"],
		},
	};

	it("pages a kept describe result back into the full schema", async () => {
		const kept = wrap({
			__tedix_result_handle: true,
			handle: "exec-1",
			preview: "[{",
			total: 30415,
		});
		expect(parseCodeModeCatalog(kept)).toEqual([]);
		expect(codeModeResultHandle(kept)).toBe("exec-1");
		const text = JSON.stringify([entry]);
		const pages = [
			{ text: text.slice(0, 40), nextOffset: 40 },
			{ text: text.slice(40) },
		];
		const offsets: unknown[] = [];
		const value = await readCodeModeResultPages("exec-1", async (params) => {
			const code = (params.arguments as { code: string }).code;
			offsets.push(JSON.parse(code.match(/read_result\((.*)\)/)![1]!).offset);
			return wrap(pages.shift());
		});
		expect(offsets).toEqual([0, 40]);
		expect(parseCodeModeCatalogValue(value)).toMatchObject([
			{ name: "apps.update_app", inputSchema: { required: ["appId"] } },
		]);
	});

	it("rejects a handle that is not a plain identifier", () => {
		expect(
			codeModeResultHandle(
				wrap({ __tedix_result_handle: true, handle: '"); evil("' }),
			),
		).toBeNull();
	});
});

it("keeps result handles inside read_result arguments", async () => {
	const handle =
		'"; throw new Error("escaped"); // ` ${escape()} </script>\u2028\u2029';
	const params = codeModeReadResultParams(handle, 42);
	const source = (params.arguments as { code: string }).code;
	expect(source).not.toContain("</script>");
	expect(source).not.toMatch(/[\u2028\u2029]/);
	expect(
		await runGenerated(params, {
			read_result: async (input: unknown) => input,
		}),
	).toEqual({ handle, offset: 42, limit: 16_000 });
});
