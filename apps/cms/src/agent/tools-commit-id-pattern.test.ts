import { expect, it, vi } from "vite-plus/test";
import * as z from "zod";

const schemas = vi.hoisted(() => [] as { name: string; schema: unknown }[]);
vi.mock("@tedix/mcp-shared/server", () => ({
	createMcpServer: () => ({
		registerTool: (name: string, config: { inputSchema?: unknown }) =>
			schemas.push({ name, schema: config?.inputSchema }),
	}),
}));

import { buildSiteBuilderMcpServer } from "./tools";

// The gateway's secret scan exempts a full commit ID only when the tool
// declares exactly this pattern (apps/mcp/src/mcp/utils/secret-egress-scan.ts
// EXEMPT_IDENTIFIER_PATTERNS); any other spelling blocks the call.
const EXEMPT_COMMIT_ID_PATTERN = "^[a-f0-9]{40}$";

function commitIdPatterns(value: unknown, path: string, out: string[]): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			commitIdPatterns(item, `${path}[${index}]`, out);
		});
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (
			key === "pattern" &&
			typeof child === "string" &&
			/^\^\[(?:a-f0-9|0-9a-f)\]\{40\}\$$/.test(child)
		)
			out.push(`${path}=${child}`);
		else commitIdPatterns(child, `${path}.${key}`, out);
	}
}

it("declares full commit IDs with the pattern the gateway secret scan exempts", () => {
	schemas.length = 0;
	buildSiteBuilderMcpServer({
		orgSlug: "acme",
		templateSlug: "tedix",
	} as Parameters<typeof buildSiteBuilderMcpServer>[0]);
	const found: string[] = [];
	for (const { name, schema } of schemas) {
		if (!(schema instanceof z.ZodType)) continue;
		commitIdPatterns(
			z.toJSONSchema(schema, { unrepresentable: "any" }),
			name,
			found,
		);
	}
	expect(found.length).toBeGreaterThan(0);
	expect(
		found.filter((entry) => !entry.endsWith(`=${EXEMPT_COMMIT_ID_PATTERN}`)),
	).toEqual([]);
});
