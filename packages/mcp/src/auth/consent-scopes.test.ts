import { describe, expect, it } from "vite-plus/test";
import {
	isReadOnlyConsentSelection,
	selectConsentPreset,
	HUMAN_CONNECT_CONSENT_SCOPES,
	selectConnectConsentRequestScopes,
} from "./consent-scopes";
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
	it("preserves required authority without calling it read only", () => {
		const selected = selectConsentPreset(
			[
				{ name: "mcp:apps.read" },
				{ name: "connections.execute", required: true },
			],
			"read",
		);
		expect(selected).toEqual(["mcp:apps.read", "connections.execute"]);
		expect(isReadOnlyConsentSelection(selected)).toBe(false);
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
