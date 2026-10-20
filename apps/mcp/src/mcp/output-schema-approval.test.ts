import { describe, expect, it, vi } from "vite-plus/test";
import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import { mcpToolsListResultTransform } from "../mcp-result-transform";
import { WORK_ITEM_TOOLS } from "./aggregate-tedis-work-items";
import { requireDestructiveToolApproval } from "./governance";
import type { ServerContext } from "./server-context";
import { jsonSchemaToOutputSchema } from "./utils/schema";

// The stored schema varies by tool; this strict fixture must only describe
// completed execution, never an approval continuation.
const outputSchema = {
	type: "object" as const,
	properties: { id: { type: "string" as const } },
	required: ["id"],
	additionalProperties: false,
};

async function exchange(name: string, approved: boolean, payload: unknown) {
	const server = createMcpServer({ name: "schema-regression", version: "1" });
	const execute = vi.fn(() => ({ content: [], structuredContent: payload }));
	const tool = { toolId: name, title: name };
	const context = {
		server,
		callerIdentity: { authType: "service", tediId: "fixture-agent" },
	} as unknown as ServerContext;
	const first = approved
		? await requireDestructiveToolApproval(context, tool, {
				destructiveHint: true,
			})
		: null;
	const marker = first?._meta?.["tedix/inputRequired"] as
		| { requestState: string }
		| undefined;
	server.registerTool(
		name,
		{ outputSchema: jsonSchemaToOutputSchema(outputSchema) },
		async () => {
			const pending = await requireDestructiveToolApproval(
				context,
				tool,
				{ destructiveHint: true },
				{
					extra: marker
						? {
								_meta: {
									"tedix/inputResponses": {
										requestState: marker.requestState,
										content: { reason: "Fixture authorization" },
									},
								},
							}
						: undefined,
				},
			);
			return pending ?? execute();
		},
	);
	const response = await mountMcp(
		server,
		new Request("https://fixture.test/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: {} },
			}),
		}),
		{
			resultTransform: mcpToolsListResultTransform(
				[{ ...tool, outputSchema }],
				undefined,
				new Headers(),
			),
		},
	);
	return {
		body: (await response.json()) as { result: Record<string, unknown> },
		execute,
	};
}

describe("schema-declaring Work tools through the SDK and wire transform", () => {
	it.each(WORK_ITEM_TOOLS.map((tool) => tool.name))(
		"preserves approval continuation and matching completed output for %s",
		async (name) => {
			const pending = await exchange(name, false, { id: "fixture-work" });
			expect(pending.body).toHaveProperty("result");
			expect(pending.body.result).toMatchObject({
				resultType: "input_required",
				requestState: expect.any(String),
				inputRequests: { approval: expect.any(Object) },
			});
			expect(pending.body.result).not.toHaveProperty("isError");
			expect(pending.execute).not.toHaveBeenCalled();
			const completed = await exchange(name, true, { id: "fixture-work" });
			expect(completed.body.result.structuredContent).toEqual({
				id: "fixture-work",
			});
			expect(completed.execute).toHaveBeenCalledOnce();
		},
	);

	it("still rejects missing and mismatched completed structured content", async () => {
		for (const payload of [undefined, { id: 42 }]) {
			const { body } = await exchange("invalid_output", true, payload);
			expect(body.result.isError).toBe(true);
			expect(JSON.stringify(body)).toContain("Output validation error");
		}
	});
});
