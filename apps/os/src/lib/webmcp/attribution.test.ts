import type {
	ModelContextLike,
	WebMcpToolDef,
} from "@tedix/webmcp-core/model-context";
import { webMcpResult } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
} from "@tedix/webmcp-core/registry";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { withWebMcpInvocationHeader } from "./attribution";

afterEach(() => {
	setModelContextResolverForTests(null);
});

/** Registers one scope and returns the projected (instrumented) tools. */
function projectTools(tools: WebMcpToolDef[]) {
	const projected: WebMcpToolDef[][] = [];
	const context: ModelContextLike = {
		provideContext: ({ tools: t }) => projected.push(t),
	};
	setModelContextResolverForTests(() => context);
	registerWebMcpScope("work", tools);
	return projected.at(-1) ?? [];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("withWebMcpInvocationHeader", () => {
	it("passes base headers through untouched outside a WebMCP execute", async () => {
		const getHeaders = withWebMcpInvocationHeader(() => ({
			Authorization: "Bearer token",
		}));
		expect(await getHeaders()).toEqual({ Authorization: "Bearer token" });
	});

	it("stamps the ambient invocation id on requests made during an execute", async () => {
		let stamped: Record<string, string> | null = null;
		const getHeaders = withWebMcpInvocationHeader(async () => ({}));
		const [projected] = projectTools([
			{
				name: "list_work_items",
				description: "d",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: true, untrustedContentHint: false },
				execute: async () => {
					// Same shape as a real tool: an osApi call resolves its
					// headers while the execute is in flight.
					stamped = await getHeaders();
					return webMcpResult({ ok: true });
				},
			},
		]);
		await projected?.execute({});
		expect(stamped!["X-Tedix-Webmcp-Invocation"]).toMatch(UUID);
		// After the execute settles the ambient id is gone again.
		expect(await getHeaders()).toEqual({});
	});
});
