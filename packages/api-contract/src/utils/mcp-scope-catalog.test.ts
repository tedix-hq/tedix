import { describe, expect, it } from "vite-plus/test";
import {
	collectAdvertisedScopes,
	collectDescopeResourceScopes,
	connectionScopeMappingValues,
	reconcileConnectionScopeMappings,
	toDescopeConnectionScopes,
} from "./mcp-scope-catalog";

describe("D1 connection scope mappings", () => {
	it("does not carry one provider's defaults into a different aggregate provider", () => {
		expect(
			reconcileConnectionScopeMappings(
				{},
				{
					connectionProviderId: "mail",
					connectionScopes: ["Mail.Read"],
					toolScopes: { calendar: ["calendar.read"] },
					aggregateApps: [
						{ slug: "calendar", connectionProviderId: "calendar" },
					],
				},
			),
		).toEqual({});
	});

	it("replaces stale values while retaining consent and unrelated configuration", () => {
		const approved = {
			permissionsScopes: [{ name: "other" }],
			connectionsScopes: [
				{
					name: "mail.read",
					optional: true,
					description: "Read mail",
					values: ["old"],
				},
				{ name: "unmanaged", values: ["keep"] },
			],
		};
		const config = {
			connectionProviderId: "mail",
			connectionScopes: [" Mail.Read ", "Mail.Read"],
			toolScopes: { mail: ["mail.read"] },
		};
		const result = reconcileConnectionScopeMappings(approved, config);
		expect(result).toEqual({
			...approved,
			connectionsScopes: [
				{ ...approved.connectionsScopes[0], values: ["Mail.Read"] },
				approved.connectionsScopes[1],
			],
		});
		expect(reconcileConnectionScopeMappings(result, config)).toEqual(result);
		expect(approved.connectionsScopes[0]?.values).toEqual(["old"]);
	});

	it("keeps each namespace's provider scopes separate", () => {
		const result = reconcileConnectionScopeMappings(
			{},
			{
				toolScopes: {
					mail: ["mail.read"],
					calendar: ["calendar.read"],
					other: ["other.read"],
				},
				aggregateApps: [
					{
						slug: "mail-app",
						prefix: "mail",
						connectionProviderId: "mail",
						connectionScopes: ["Mail.Read"],
					},
					{
						slug: "calendar-app",
						prefix: "calendar",
						connectionProviderId: "calendar",
						connectionScopes: ["Calendar.Read"],
					},
				],
			},
		);
		expect(result.connectionsScopes).toEqual([
			{ name: "mail.read", optional: true, values: ["Mail.Read"] },
			{ name: "calendar.read", optional: true, values: ["Calendar.Read"] },
		]);
	});

	it("clears an explicitly empty declaration and leaves absent declarations alone", () => {
		const approved = {
			connectionsScopes: [{ name: "mail.read", values: ["old"] }],
		};
		expect(
			reconcileConnectionScopeMappings(approved, {
				connectionProviderId: "mail",
				toolScopes: { mail: ["mail.read"] },
			}),
		).toEqual(approved);
		expect(
			reconcileConnectionScopeMappings(approved, {
				connectionProviderId: "mail",
				connectionScopes: [],
				toolScopes: { mail: ["mail.read"] },
			}).connectionsScopes?.[0]?.values,
		).toEqual([]);
	});
});

describe("scope catalog projection", () => {
	it("uses the same D1 declarations for gateway discovery and provider synchronization", () => {
		const config = {
			connectionProviderId: "fictional-mail",
			connectionScopes: ["Mail.Read"],
			toolScopes: { mail: ["mail.read"] },
			scopeDescriptions: {
				"mail.read": "Read fictional mail",
				"mail.write": "Write fictional mail",
			},
		};
		const gateway = collectAdvertisedScopes({ mcpConfig: config });
		const registration = toDescopeConnectionScopes(
			collectDescopeResourceScopes({ mcpConfig: config }),
			config,
		);
		expect(registration).toEqual(
			expect.arrayContaining(
				gateway.map((scope) => expect.objectContaining(scope)),
			),
		);
		expect(
			connectionScopeMappingValues({ connectionsScopes: registration }),
		).toEqual({ "mail.read": ["Mail.Read"] });
		expect(registration.every((scope) => scope.optional === true)).toBe(true);
		expect(
			connectionScopeMappingValues(
				reconcileConnectionScopeMappings(
					{ connectionsScopes: registration },
					config,
				),
			),
		).toEqual({ "mail.read": ["Mail.Read"] });
	});

	it("keeps managed mappings optional when correcting stale required provider grants", () => {
		const result = reconcileConnectionScopeMappings(
			{
				connectionsScopes: [
					{ name: "mail.read", optional: false, values: ["Mail.Write"] },
				],
			},
			{
				connectionProviderId: "fictional-mail",
				connectionScopes: ["Mail.Read"],
				toolScopes: { mail: ["mail.read"] },
			},
		);
		expect(result.connectionsScopes).toEqual([
			{ name: "mail.read", optional: true, values: ["Mail.Read"] },
		]);
	});

	it("preserves explicit policy-mode scopes without inventing provider mappings", () => {
		const config = {
			enforcePolicies: true,
			toolScopes: { mail: ["mail.read"] },
			connectionProviderId: "fictional-mail",
			connectionScopes: ["Mail.Read"],
		};
		const scopes = collectAdvertisedScopes({
			mcpConfig: config,
			tools: [{ name: "list_mail" }],
		});
		expect(scopes.map((scope) => scope.name)).toEqual(["mcp:list.mail"]);
		expect(
			toDescopeConnectionScopes(scopes, config).find(
				(scope) => scope.name === "mcp:list.mail",
			)?.values,
		).toBeUndefined();
	});
});
