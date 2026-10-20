import { describe, expect, it } from "vite-plus/test";
import { clientSupportsMcpApps } from "./client-apps-capability";

describe("clientSupportsMcpApps", () => {
	it("carries legacy negotiation across independent requests without overriding modern declarations", () => {
		const headers = new Headers({
			"Mcp-Session-Id": "tedix-ui-v1-11111111-1111-4111-8111-111111111111",
		});
		expect(clientSupportsMcpApps({ method: "tools/list" }, headers)).toBe(true);
		expect(clientSupportsMcpApps({ method: "tools/list" })).toBe(false);
		expect(
			clientSupportsMcpApps(
				{
					method: "tools/list",
					params: {
						_meta: {
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				},
				headers,
			),
		).toBe(false);
		headers.set("MCP-Protocol-Version", "2026-07-28");
		expect(clientSupportsMcpApps({ method: "tools/list" }, headers)).toBe(
			false,
		);
	});
	it.each([
		"arbitrary-session",
		"tedix-ui-v1-",
		"tedix-ui-v1-11111111-1111-4111-8111-111111111111-extra",
	])("does not infer Apps support from an unrelated session: %s", (id) => {
		expect(
			clientSupportsMcpApps(
				{ method: "tools/list" },
				new Headers({ "Mcp-Session-Id": id }),
			),
		).toBe(false);
	});
	it.each(["io.modelcontextprotocol/ui", "io.modelcontextprotocol/apps"])(
		"accepts %s in legacy initialize and modern request metadata",
		(extension) => {
			const capabilities = {
				extensions: {
					[extension]: { mimeTypes: ["text/html;profile=mcp-app"] },
				},
			};
			expect(
				clientSupportsMcpApps({
					method: "initialize",
					params: { capabilities },
				}),
			).toBe(true);
			for (const method of ["server/discover", "tools/list", "tools/call"]) {
				expect(
					clientSupportsMcpApps({
						method,
						params: {
							_meta: {
								"io.modelcontextprotocol/clientCapabilities": capabilities,
							},
						},
					}),
				).toBe(true);
			}
		},
	);
	it("accepts the pre-extension experimental declaration", () => {
		expect(
			clientSupportsMcpApps({
				method: "initialize",
				params: {
					capabilities: { experimental: { "io.modelcontextprotocol/ui": {} } },
				},
			}),
		).toBe(true);
	});
	it.each([
		undefined,
		null,
		false,
		true,
		"supported",
		{ mimeTypes: ["image/png"] },
		{ mimeTypes: "text/html;profile=mcp-app" },
	])("rejects malformed or incompatible declarations: %j", (capability) => {
		expect(
			clientSupportsMcpApps({
				method: "initialize",
				params: {
					capabilities: {
						extensions: { "io.modelcontextprotocol/ui": capability },
					},
				},
			}),
		).toBe(false);
	});
	it("does not infer support from Claude/ChatGPT names or unrelated capabilities", () => {
		for (const name of ["claude-desktop", "chatgpt", "tedix-cli"]) {
			expect(
				clientSupportsMcpApps({
					method: "initialize",
					params: {
						clientInfo: { name, version: "test" },
						capabilities: { tools: {} },
					},
				}),
			).toBe(false);
		}
	});
});
