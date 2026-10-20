import { expect, it, vi } from "vite-plus/test";
import { registerTextOnlyTool } from "./tool-registration";
import type { AppTool, ServerContext } from "./server-context";

it.each([undefined, "other", "notion"])(
	"overwrites upstream connection claims using configured provider %s",
	async (providerId) => {
		const registerTool = vi.fn(
			(_name: string, _spec: { _meta?: Record<string, unknown> }) => ({}),
		);
		const agent = {
			server: { registerTool },
			registeredTools: new Map(),
			appToolIds: new Set(),
			loadedTools: new Map(),
			authRequiredTools: new Set(),
		} as unknown as ServerContext;
		await registerTextOnlyTool(
			agent,
			{
				toolId: "notion_update_page",
				toolTypeId: "mcp",
				title: "Update page",
				meta: {
					"com.tedix/connectedTool": {
						providerId: "notion",
						toolName: "notion-update-page",
					},
				},
				config: {
					transport: "mcp",
					mcpToolName: "notion-update-page",
					...(providerId
						? { auth: { type: "connection", connectionId: providerId } }
						: {}),
				},
			} as unknown as AppTool,
			{} as never,
		);
		const meta = registerTool.mock.calls[0]?.[1]?._meta;
		if (!meta) throw new Error("Tool registration omitted provenance metadata");
		if (providerId)
			expect(meta["com.tedix/connectedTool"]).toEqual({
				providerId,
				toolName: "notion-update-page",
			});
		else expect(meta["com.tedix/connectedTool"]).toBeUndefined();
	},
);
