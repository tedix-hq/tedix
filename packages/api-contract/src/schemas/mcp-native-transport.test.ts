import { describe, expect, it } from "vite-plus/test";
import { McpNativeBootstrapSchema } from "./mcp-native-transport";

describe("native MCP bootstrap", () => {
	it("requires explicit nullable context and bounded catalog state", () => {
		expect(
			McpNativeBootstrapSchema.parse({
				nativeContext: null,
				nativeCatalog: { status: "unavailable", search: null, describe: null },
			}).nativeContext,
		).toBeNull();
		expect(McpNativeBootstrapSchema.safeParse({}).success).toBe(false);
	});
	it("refuses anonymous identities, token fields and invented descriptors", () => {
		const base = {
			nativeContext: {
				version: 1,
				surface: "mcp-gateway",
				appId: "app",
				appSlug: "gateway",
				organizationId: "org",
				actor: { authType: "oauth" },
				nativeTransportAvailable: true,
			},
			nativeCatalog: { status: "unavailable", search: null, describe: null },
		};
		expect(McpNativeBootstrapSchema.safeParse(base).success).toBe(true);
		expect(
			McpNativeBootstrapSchema.safeParse({
				...base,
				nativeContext: {
					...base.nativeContext,
					actor: { authType: "anonymous" },
				},
			}).success,
		).toBe(false);
		expect(
			McpNativeBootstrapSchema.safeParse({
				...base,
				nativeContext: { ...base.nativeContext, token: "forged" },
			}).success,
		).toBe(false);
		expect(
			McpNativeBootstrapSchema.safeParse({
				...base,
				nativeCatalog: { ...base.nativeCatalog, search: { name: "guessed" } },
			}).success,
		).toBe(false);
	});
});
