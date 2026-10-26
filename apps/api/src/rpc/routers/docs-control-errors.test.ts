import { describe, expect, it } from "vite-plus/test";
import { callDocsMcpTool } from "./docs";

/** Upstream text that must never reach a Docs caller. */
const LEAK = "upstream docs-studio.internal stack Bearer sk_live_secret";

function call(reply: (id: unknown) => Response) {
	return callDocsMcpTool({
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as { id: unknown };
			return reply(body.id);
		},
		organizationSlug: "acme",
		headers: { "X-Tedix-Delegated-Scope": "mcp:content.read" },
		name: "list_docs_sites",
		args: {},
	});
}

async function rejection(reply: (id: unknown) => Response) {
	try {
		await call(reply);
	} catch (error) {
		return error as { code: string; message: string };
	}
	throw new Error("expected the Docs call to fail");
}

describe("Docs transport failures", () => {
	it.each([
		[401, "UNAUTHORIZED", "Sign in again"],
		[403, "FORBIDDEN", "Docs role"],
		[404, "NOT_FOUND", "could not find"],
		[409, "CONFLICT", "Reload"],
		[429, "TOO_MANY_REQUESTS", "Wait a minute"],
		[500, "BAD_GATEWAY", "unavailable"],
		[503, "BAD_GATEWAY", "unavailable"],
	])("maps HTTP %i to %s with safe copy", async (status, code, copy) => {
		const error = await rejection(() => new Response(LEAK, { status }));
		expect(error.code).toBe(code);
		expect(error.message).toContain(copy);
		expect(error.message).not.toMatch(/docs-studio|stack|Bearer|sk_live/);
		expect(error.message).not.toContain(String(status));
	});

	it("hides a JSON-RPC protocol error's upstream message", async () => {
		const error = await rejection((id) =>
			Response.json({
				jsonrpc: "2.0",
				id,
				error: { code: -32603, message: LEAK },
			}),
		);
		expect(error.code).toBe("BAD_GATEWAY");
		expect(error.message).toContain("could not read");
		expect(error.message).not.toMatch(/docs-studio|Bearer|sk_live/);
	});

	it("keeps a tool error the caller's bad request with its own text", async () => {
		const error = await rejection((id) =>
			Response.json({
				jsonrpc: "2.0",
				id,
				result: {
					resultType: "complete",
					isError: true,
					content: [{ type: "text", text: "Site slug is taken" }],
				},
			}),
		);
		expect(error).toMatchObject({
			code: "BAD_REQUEST",
			message: "Site slug is taken",
		});
	});
});
