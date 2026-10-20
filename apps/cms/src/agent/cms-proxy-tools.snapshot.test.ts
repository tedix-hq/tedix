import { expect, it } from "vite-plus/test";
import type { McpServer } from "@tedix/mcp-shared/server";
import * as z from "zod";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import expected from "./__snapshots__/cms-proxy-tools.json";

it("preserves the ordered CMS proxy tool contracts", () => {
	const tools: unknown[] = [];
	const server = {
		registerTool(
			name: string,
			definition: {
				inputSchema: z.ZodType;
				outputSchema?: z.ZodType;
				annotations?: Record<string, unknown>;
			},
		) {
			tools.push([
				name,
				definition.annotations ?? null,
				z.toJSONSchema(definition.inputSchema),
				definition.outputSchema
					? z.toJSONSchema(definition.outputSchema)
					: null,
			]);
		},
	};
	registerCmsProxyTools(server as unknown as McpServer, {
		orgSlug: "example",
		forwardedAuth: undefined,
		serviceApiKey: undefined,
		internalAuthToken: undefined,
		environment: "production",
	});
	expect(tools).toHaveLength(130);
	expect(tools).toEqual(expected);
});
