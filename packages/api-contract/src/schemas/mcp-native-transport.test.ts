import { describe, expect, it } from "vite-plus/test";
import {
	McpNativeBootstrapSchema,
	McpNativeOrganizationsSchema,
} from "./mcp-native-transport";

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

it("bounds aggregate contexts and refuses duplicate, unauthorized and mixed catalog pairs", () => {
	const descriptor = (name: string, endpoint: string) => ({
		name,
		endpoint,
		toolRowId: name,
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: null,
			sourceRef: null,
			sourceHash: null,
			syncedAt: null,
		},
	});
	const entry = {
		nativeContext: {
			version: 1,
			surface: "mcp-gateway",
			appId: "gateway-a",
			appSlug: "alpha",
			organizationId: "a",
			actor: { authType: "oauth" },
			nativeTransportAvailable: true,
		},
		nativeCatalog: {
			status: "usable",
			search: descriptor("alpha__search", "catalog/search"),
			describe: descriptor("alpha__describe", "catalog/describe"),
		},
	};
	expect(McpNativeOrganizationsSchema.safeParse([entry]).success).toBe(true);
	expect(McpNativeOrganizationsSchema.safeParse([entry, entry]).success).toBe(
		false,
	);
	expect(
		McpNativeOrganizationsSchema.safeParse(Array(11).fill(entry)).success,
	).toBe(false);
	for (const change of [
		{ authorized: false },
		{ eligible: false },
		{ endpoint: "catalog/search" },
		{ name: "alpha__search" },
	])
		expect(
			McpNativeOrganizationsSchema.safeParse([
				{
					...entry,
					nativeCatalog: {
						...entry.nativeCatalog,
						describe: { ...entry.nativeCatalog.describe, ...change },
					},
				},
			]).success,
		).toBe(false);
	expect(
		McpNativeOrganizationsSchema.safeParse([{ ...entry, token: "hidden" }])
			.success,
	).toBe(false);
});

it("refuses catalog names outside the described gateway", () => {
	const d = (name: string, endpoint: string) => ({
		name,
		endpoint,
		toolRowId: name,
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: null,
			sourceRef: null,
			sourceHash: null,
			syncedAt: null,
		},
	});
	expect(
		McpNativeOrganizationsSchema.safeParse([
			{
				nativeContext: {
					version: 1,
					surface: "mcp-gateway",
					appId: "a",
					appSlug: "alpha",
					organizationId: "a",
					actor: { authType: "oauth" },
					nativeTransportAvailable: true,
				},
				nativeCatalog: {
					status: "usable",
					search: d("beta__search", "catalog/search"),
					describe: d("beta__describe", "catalog/describe"),
				},
			},
		]).success,
	).toBe(false);
});
