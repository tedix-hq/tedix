import { describe, expect, it } from "vite-plus/test";
import {
	groupConsentPermissions,
	normalizeConsentPermissions,
} from "./consent-permissions";

describe("shared consent permission model", () => {
	it("uses one stable grouping for inbound-app scope objects", () => {
		const permissions = normalizeConsentPermissions([
			{ name: "mcp:skills.write", description: "Run skills" },
			{ name: "mcp:skills.read", description: "Read skills" },
			{ name: "mcp:settings.admin", description: "Admin settings" },
			{ name: "mcp:skills.read", description: "duplicate" },
		]);

		expect(groupConsentPermissions(permissions)).toMatchObject([
			{ name: "Settings", highRisk: true },
			{ name: "Skills", highRisk: false },
		]);
		expect(permissions.map((permission) => permission.name)).toEqual([
			"mcp:settings.admin",
			"mcp:skills.read",
			"mcp:skills.write",
		]);
	});

	it("uses provider-defined groups for outbound connection grants", () => {
		const permissions = normalizeConsentPermissions(
			[
				"https://www.googleapis.com/auth/calendar.readonly",
				"https://www.googleapis.com/auth/calendar.events",
			],
			[
				{
					label: "Calendar",
					scopes: [
						"https://www.googleapis.com/auth/calendar.readonly",
						"https://www.googleapis.com/auth/calendar.events",
					],
				},
			],
		);

		expect(groupConsentPermissions(permissions)).toMatchObject([
			{ name: "Calendar", highRisk: false, permissions: [{}, {}] },
		]);
		expect(permissions.map((permission) => permission.name)).toEqual([
			"https://www.googleapis.com/auth/calendar.events",
			"https://www.googleapis.com/auth/calendar.readonly",
		]);
	});
});

it("reads Descope BYOS id and description fields", () => {
	const permissions = normalizeConsentPermissions([
		{ id: "mcp:apps.admin", desc: "Administer apps", required: false },
		{ id: "mcp:apps.read", desc: "Read apps", required: false },
		{ id: "openid", desc: "Identify you", required: true },
		{ id: "unknown" },
	]);
	expect(permissions.find((p) => p.name === "mcp:apps.admin")).toMatchObject({
		description: "Administer apps",
	});
	expect(permissions.find((p) => p.name === "openid")?.required).toBe(true);
	expect(permissions.map((permission) => permission.name)).toEqual([
		"mcp:apps.admin",
		"mcp:apps.read",
		"openid",
		"unknown",
	]);
});

it("states the write authority hidden by a vague connected-app scope description", () => {
	const permissions = normalizeConsentPermissions([
		{ id: "connections.execute", desc: "Invoke an approved action" },
		{ id: "connections.admin", desc: "Manage a connection" },
	]);
	expect(
		permissions.find((permission) => permission.name === "connections.execute")
			?.description,
	).toContain("writes");
	expect(
		permissions.find((permission) => permission.name === "connections.admin")
			?.description,
	).toContain("destructive");
});

it("honors provider nonoptional permissions", () => {
	expect(
		normalizeConsentPermissions([
			{ name: "connections.execute", optional: false },
		])[0]?.required,
	).toBe(true);
	expect(
		normalizeConsentPermissions([
			{ name: "connections.read", optional: true },
		])[0],
	).toMatchObject({ required: false, group: "Connected apps" });
});

it("explains platform administration separately from organization administration", () => {
	expect(normalizeConsentPermissions(["platform:admin"])).toMatchObject([
		{
			group: "Platform administration",
			admin: true,
			description: "Administer the Tedix platform across organizations",
		},
	]);
});
