import { describe, expect, it } from "vite-plus/test";
import {
	isReadOnlyConsentSelection,
	selectConsentPreset,
	HUMAN_CONNECT_CONSENT_SCOPES,
	MEMBER_CLIENT_SCOPE,
	selectConnectConsentRequestScopes,
	MINIMAL_CONSENT_SCOPES,
} from "./consent-scopes";
import {
	resolveMcpToolRequiredScopes,
	isMcpToolVisibleToCaller,
} from "./tool-scopes";
describe("human consent presets", () => {
	it("offers optional Connect actions but selects only reads by default", () => {
		const offered = selectConnectConsentRequestScopes([
			...HUMAN_CONNECT_CONSENT_SCOPES,
			"platform:admin",
			"unknown.read",
			"mcp:admin",
		]);
		expect(offered).toEqual(HUMAN_CONNECT_CONSENT_SCOPES);
		const selected = selectConsentPreset(
			offered.map((name) => ({ name })),
			"read",
		);
		expect(selected).toContain("mcp:memory.read");
		expect(selected).toContain("connections.read");
		expect(selected).not.toContain("connections.execute");
		expect(selected).not.toContain("connections.admin");
		expect(isReadOnlyConsentSelection(selected)).toBe(true);
		expect(selectConnectConsentRequestScopes(["mcp:apps.read"])).toEqual([
			"mcp:apps.read",
		]);
	});
	it("includes only known read permissions in the offered envelope", () => {
		expect(
			selectConsentPreset(
				[
					"mcp:apps.read",
					"connections.read",
					"mcp:apps.write",
					"connections.execute",
					"platform:admin",
					"unknown.read",
				].map((name) => ({ name })),
				"read",
			),
		).toEqual(["mcp:apps.read", "connections.read"]);
	});
	it("does not let requested required writes change the read preset", () => {
		const selected = selectConsentPreset(
			[
				{ name: "mcp:apps.read" },
				{ name: "connections.execute", required: true },
			],
			"read",
		);
		expect(selected).toEqual(["mcp:apps.read"]);
		expect(isReadOnlyConsentSelection(selected)).toBe(true);
	});
	it("keeps Minimal to identity and staying signed in, even when writes are requested", () => {
		const offered = [
			...MINIMAL_CONSENT_SCOPES,
			"mcp:work.write",
			"connections.execute",
		].map((name) => ({ name, required: true }));
		expect(selectConsentPreset(offered, "minimal")).toEqual(
			MINIMAL_CONSENT_SCOPES,
		);
	});
	it("retains identity and background access and bounds all to requested scopes", () => {
		expect(
			selectConsentPreset(
				[{ name: "openid" }, { name: "offline_access" }, { name: "unknown" }],
				"read",
			),
		).toEqual(["openid", "offline_access"]);
		expect(selectConsentPreset([{ name: "mcp:apps.write" }], "all")).toEqual([
			"mcp:apps.write",
		]);
	});
});

it("offers platform authority only when explicitly requested and advertised", () => {
	expect(
		selectConnectConsentRequestScopes(["mcp:apps.read", "platform:admin"]),
	).toEqual(["mcp:apps.read"]);
	expect(
		selectConnectConsentRequestScopes(
			["mcp:apps.read", "platform:admin"],
			true,
		),
	).toEqual(["mcp:apps.read", "platform:admin"]);
	expect(selectConnectConsentRequestScopes(["mcp:apps.read"], true)).toEqual([
		"mcp:apps.read",
	]);
});

it("declares a member client scope with reads and writes but no administration", () => {
	const scopes = MEMBER_CLIENT_SCOPE.split(" ");
	expect(scopes).toContain("offline_access");
	expect(scopes).toContain("mcp:work.write");
	expect(scopes).toContain("connections.execute");
	expect(
		scopes.filter(
			(scope) => scope.endsWith(".admin") || scope === "platform:admin",
		),
	).toEqual([]);
});

it("allows only the caller-owned directory with Minimal, not workspaces or Work", () => {
	const tool = {
		toolId: "tedix_unified__list_my_workspaces",
		toolTypeId: "rpc",
		config: { endpoint: "directory/listMyWorkspaces" },
		annotations: { readOnlyHint: true },
	};
	expect(
		resolveMcpToolRequiredScopes(tool, "tedix_unified", {
			authMode: "authenticated",
		}),
	).toEqual(["profile"]);
	expect(
		resolveMcpToolRequiredScopes(
			{ ...tool, annotations: undefined },
			"tedix_unified",
			{ authMode: "authenticated" },
		),
	).toEqual(["profile"]);
	expect(
		isMcpToolVisibleToCaller(
			tool,
			"tedix_unified",
			{ authMode: "authenticated" },
			{ authType: "oauth", scopes: [...MINIMAL_CONSENT_SCOPES] },
		),
	).toBe(true);
	for (const endpoint of [
		"osWorkspaces/workspaces/list",
		"workItems/listCliProjection",
	]) {
		expect(
			isMcpToolVisibleToCaller(
				{ ...tool, config: { endpoint } },
				"tedix_unified",
				{ authMode: "authenticated" },
				{ authType: "oauth", scopes: [...MINIMAL_CONSENT_SCOPES] },
			),
		).toBe(false);
	}
});
