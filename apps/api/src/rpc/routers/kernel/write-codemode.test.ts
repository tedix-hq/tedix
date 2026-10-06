import { describe, expect, it } from "vite-plus/test";
import {
	codeModeDescribeParams,
	codeModeDiscoveryParams,
} from "./write-codemode";

async function runGenerated(params: Record<string, unknown>, discover: object) {
	const args = params.arguments as { code: string };
	return await new Function("discover", `return (${args.code})()`)(discover);
}

describe("write discovery contracts", () => {
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
