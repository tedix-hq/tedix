import { describe, expect, it } from "vite-plus/test";
import { buildDescopeAihDriftReport } from "./descope-aih-drift";

describe("buildDescopeAihDriftReport", () => {
	it("compares managed tedi clients with the exact live FGA role scope set", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-20T00:00:00.000Z",
			projectId: "project-id",
			servers: [
				{
					id: "server-1",
					name: "App One",
					approvedScopes: {
						connectionsScopes: [
							{ name: "connections.read", optional: true },
							{ name: "connections.execute" },
							{ name: "mcp:catalog.read" },
							{ name: "mcp:observe.read" },
						],
					},
				},
			],
			clientsByServerId: new Map([
				[
					"server-1",
					[
						{
							id: "client-1",
							name: "tedi:cto:tedi-1",
							status: "verified",
							scopes: [
								"mcp:catalog",
								"mcp:observe",
								"connections.execute",
								"platform:admin",
							],
							tags: ["tedi:tedi-1", "app:app-one"],
						},
					],
				],
			]),
			outboundApps: [],
			tenants: [],
			roles: [],
			fgaRelations: [
				{
					target: "descope-user-1",
					relationDefinition: "observer",
					namespace: "app",
					resource: "app-1",
				},
			],
			fgaQueryError: null,
			providers: [],
			d1Apps: [
				{
					id: "app-1",
					slug: "app-one",
					name: "App One",
					descopeResourceId: "server-1",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
					metadata: {},
				},
			],
			d1Tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "CTO",
					descopeMcpResourceId: null,
					descopeUserId: "descope-user-1",
					mcpCapabilityProfile: "standard",
				},
			],
		});

		const issue = report.issues.find(
			(candidate) => candidate.code === "tedi_mcp_client_scope_overgrant",
		);
		expect(issue?.severity).toBe("critical");
		expect(issue?.details).toMatchObject({
			role: "observer",
			expectedScopes: [
				"connections.read",
				"mcp:catalog.read",
				"mcp:observe.read",
			],
			extraScopes: [
				"connections.execute",
				"mcp:catalog",
				"mcp:observe",
				"platform:admin",
			],
		});
	});

	it("audits the same Resource-approved scope intersection used by provisioning", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-09-03T00:00:00.000Z",
			projectId: "project-id",
			servers: [
				{
					id: "server-1",
					name: "Tedix",
					approvedScopes: {
						connectionsScopes: [
							{ name: "connections.execute" },
							{ name: "mcp:work.read" },
							{ name: "mcp:work.write" },
						],
					},
				},
			],
			clientsByServerId: new Map([
				[
					"server-1",
					[
						{
							id: "client-1",
							name: "tedi:cto:tedi-1",
							scopes: [
								"connections.execute",
								"mcp:work.read",
								"mcp:work.write",
							],
							tags: ["tedi:tedi-1", "app:app-one"],
						},
					],
				],
			]),
			outboundApps: [],
			tenants: [],
			roles: [],
			fgaRelations: [
				{
					target: "descope-user-1",
					relationDefinition: "operator",
					namespace: "app",
					resource: "app-1",
				},
			],
			fgaQueryError: null,
			providers: [],
			d1Apps: [
				{
					id: "app-1",
					slug: "app-one",
					name: "App One",
					descopeResourceId: "server-1",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
					metadata: {},
				},
			],
			d1Tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "CTO",
					descopeMcpResourceId: null,
					descopeUserId: "descope-user-1",
					mcpCapabilityProfile: "platform_admin",
				},
			],
		});

		expect(
			report.issues.some((candidate) =>
				candidate.code.startsWith("tedi_mcp_client_scope_"),
			),
		).toBe(false);
	});

	it("keeps peer tedi credentials out of managed app-assignment drift", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-20T00:00:00.000Z",
			projectId: "project-id",
			servers: [{ id: "server-1", name: "Peer Server" }],
			clientsByServerId: new Map([
				[
					"server-1",
					[
						{
							id: "peer-client-1",
							name: "tedi:acme:tedi-1",
							scopes: ["platform:admin"],
							tags: ["tedi:tedi-1", "peer:acme"],
						},
						{
							id: "peer-client-2",
							name: "tedi:operator:tedi-2",
							scopes: ["platform:admin"],
							tags: ["tedi:tedi-2", "peer-tedi:operator"],
						},
					],
				],
			]),
			outboundApps: [],
			tenants: [],
			roles: [],
			fgaRelations: [],
			fgaQueryError: null,
			providers: [],
			d1Apps: [],
			d1Tedis: [],
		});

		expect(
			report.issues.some((candidate) =>
				candidate.code.startsWith("tedi_mcp_client_"),
			),
		).toBe(false);
	});

	it("does not infer assignment or scope drift when the FGA audit failed", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-20T00:00:00.000Z",
			projectId: "project-id",
			servers: [{ id: "server-1", name: "App One" }],
			clientsByServerId: new Map([
				[
					"server-1",
					[
						{
							id: "client-1",
							name: "tedi:cto:tedi-1",
							scopes: ["platform:admin"],
							tags: ["tedi:tedi-1", "app:app-one"],
						},
					],
				],
			]),
			outboundApps: [],
			tenants: [],
			roles: [],
			fgaRelations: [],
			fgaQueryError: "Descope unavailable",
			providers: [],
			d1Apps: [
				{
					id: "app-1",
					slug: "app-one",
					name: "App One",
					descopeResourceId: "server-1",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
					metadata: {},
				},
			],
			d1Tedis: [
				{
					id: "tedi-1",
					slug: "cto",
					name: "CTO",
					descopeMcpResourceId: null,
					descopeUserId: "descope-user-1",
				},
			],
		});

		expect(
			report.issues.some((candidate) =>
				[
					"tedi_mcp_client_assignment_missing",
					"tedi_mcp_client_scope_overgrant",
					"tedi_mcp_client_scope_missing",
				].includes(candidate.code),
			),
		).toBe(false);
		expect(
			report.issues.some(
				(candidate) => candidate.code === "fga_relation_audit_unavailable",
			),
		).toBe(true);
	});

	it("flags missing D1 resources, unsafe clients, bad flows, and provider drift", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-05-22T00:00:00.000Z",
			projectId: "project-id",
			servers: [
				{
					id: "server-live",
					name: "Tedix Unified",
					audienceWhitelist: ["https://tedix-unified.mcp.tedix.dev/mcp"],
					loginPageURL:
						"https://auth.tedix.dev/login/project-id?flow=inbound-apps-user-consent",
					dynamicRegistration: {
						flowId: "",
						disableApprovedScopesAsDefault: true,
					},
					approvedScopes: {
						connectionsScopes: [
							{ name: "platform:admin" },
							{ name: "mcp:observe" },
						],
					},
				},
				{
					id: "server-bad-flow",
					name: "Tedi CMO",
					audienceWhitelist: ["https://cmo.tedi.tedix.dev/mcp"],
					loginPageURL:
						"https://auth.tedix.dev/login/project-id?flow=sign-up-or-in",
					dynamicRegistration: { flowId: "sign-up-or-in" },
					approvedScopes: {
						connectionsScopes: [{ name: "tedi:admin" }],
					},
				},
			],
			clientsByServerId: new Map([
				[
					"server-live",
					Array.from({ length: 11 }, (_, index) => ({
						id: `client-${index}`,
						name: index === 0 ? "tedi:cto:abc" : "Codex",
						mcpServerId: "server-live",
						status: "verified",
						scopes: ["platform:admin"],
						tags: index === 0 ? ["tedi:abc", "app:tedix-unified"] : [],
					})),
				],
				["server-bad-flow", []],
			]),
			outboundApps: [
				{
					id: "descope-api-key",
					name: "Descope API Key",
					appType: "apikey",
					logo: "data:image/png;base64,logo",
					defaultScopes: [],
				},
				{
					id: "todoist",
					name: "Todoist",
					appType: "oauth",
					useDcr: false,
					logo: null,
					defaultScopes: ["data:read_write"],
				},
			],
			tenants: [{ id: "org_tedix", name: "Tedix" }],
			roles: [
				{ name: "platform-admin", permissionNames: ["platform:admin"] },
				{ name: "tedi", permissionNames: [] },
				{ name: "legacy-empty-role", permissionsNames: [] },
			],
			fgaRelations: [
				{
					target: "U123",
					relationDefinition: "operator",
					namespace: "app",
					resource: "deleted-app",
				},
			],
			fgaQueryError: null,
			providers: [
				{
					id: "github-pat-key",
					name: "GitHub Personal Access Token",
					description: "",
					icon: "",
					category: "development",
					type: "api_key",
					requiredScopes: [],
					supportedScopes: ["tenant", "user"],
					recommendedScope: "user",
					descopeAppId: "github-pat-key",
				},
				{
					id: "todoist",
					name: "Todoist",
					description: "",
					icon: "https://www.todoist.com/favicon.ico",
					category: "productivity",
					type: "oauth",
					requiredScopes: ["data:read_write"],
					supportedScopes: ["tenant", "user"],
					recommendedScope: "user",
					descopeAppId: "todoist",
					oauthConfig: {
						authorizationUrl: "https://todoist.com/oauth/authorize",
						tokenUrl: "https://todoist.com/oauth/access_token",
						useDcr: true,
						dcrUrl: "https://todoist.com/oauth/register",
					},
				},
			],
			d1Apps: [
				{
					id: "app-live",
					slug: "tedix-unified",
					name: "Tedix Unified",
					descopeResourceId: "server-live",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: "github-pat-key",
				},
				{
					id: "app-missing",
					slug: "missing-provider-app",
					name: "Missing Provider App",
					descopeResourceId: "server-missing",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: "missing-provider",
				},
			],
			d1Tedis: [
				{
					id: "tedi-cmo",
					slug: "cmo",
					name: "cmo",
					descopeMcpResourceId: "server-bad-flow",
					descopeUserId: "U123",
				},
			],
		});

		expect(report.summary).toMatchObject({
			mcpServers: 2,
			mcpClients: 11,
			outboundApps: 2,
			d1AppsWithDescopeResource: 2,
			d1TedisWithDescopeResource: 1,
		});
		expect(report.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"d1_descope_resource_missing",
				"broad_untagged_mcp_clients",
				"mcp_server_login_flow_repeats_tenant_selection",
				"mcp_server_cli_cimd_unavailable",
				"connection_provider_missing",
				"connection_provider_registry_missing",
				"connection_provider_dcr_drift",
				"connection_provider_logo_missing",
				"descope_roles_without_permissions",
				"fga_relation_missing_d1_app",
			]),
		);
		expect(
			report.issues.find(
				(issue) => issue.code === "descope_roles_without_permissions",
			)?.details,
		).toEqual({ roles: ["legacy-empty-role"] });
		expect(report.connectionProviders).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "github-pat-key",
					appSlugs: ["tedix-unified"],
					backing: "missing",
					expectedType: "api_key",
				}),
				expect.objectContaining({
					providerId: "missing-provider",
					appSlugs: ["missing-provider-app"],
					backing: "missing",
				}),
				expect.objectContaining({
					providerId: "todoist",
					appSlugs: [],
					backing: "descope",
					expectedType: "oauth",
					actualType: "oauth",
					expectedUseDcr: true,
					actualUseDcr: false,
					hasLogo: false,
				}),
			]),
		);
	});

	/**
	 * The pairing that made this audit lie: the warning below is the ONLY signal
	 * that the relation half of the report is untrustworthy, and it is raised
	 * solely from `fgaQueryError`. `queryTediRelations` used to return `[]` on a
	 * non-ok Descope response without throwing, so the caller's catch never ran,
	 * this warning never fired, and an outage rendered as a clean report.
	 */
	it("warns that the relation audit is untrustworthy when the query failed", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-19T00:00:00.000Z",
			projectId: "project-id",
			servers: [],
			clientsByServerId: new Map(),
			tenants: [],
			roles: [],
			fgaRelations: [],
			fgaQueryError: "FGA targetsRelations query failed: rate limited",
			d1Tedis: [],
			providers: [],
			outboundApps: [],
			d1Apps: [],
		} as never);
		const flagged = report.issues.find(
			(i) => i.code === "fga_relation_audit_unavailable",
		);
		expect(flagged?.severity).toBe("warning");
		expect(flagged?.details).toMatchObject({
			error: "FGA targetsRelations query failed: rate limited",
		});
	});

	it("stays silent about relation-audit availability on a successful query", () => {
		// Zero relations from a query that SUCCEEDED is a real clean result and
		// must not raise the warning — otherwise the signal is noise.
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-19T00:00:00.000Z",
			projectId: "project-id",
			servers: [],
			clientsByServerId: new Map(),
			tenants: [],
			roles: [],
			fgaRelations: [],
			fgaQueryError: null,
			d1Tedis: [],
			providers: [],
			outboundApps: [],
			d1Apps: [],
		} as never);
		expect(
			report.issues.some((i) => i.code === "fga_relation_audit_unavailable"),
		).toBe(false);
	});

	it("flags a live provider that has no connection_providers row", () => {
		// A provider can lack a registry row while serving credentials fine
		// through Descope's Token Vault.
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-07-29T00:00:00.000Z",
			projectId: "project-id",
			servers: [],
			clientsByServerId: new Map(),
			tenants: [],
			roles: [],
			fgaRelations: [],
			d1Tedis: [],
			providers: [],
			outboundApps: [
				{ id: "google-docs", name: "Google Docs", appType: "oauth" },
			],
			d1Apps: [
				{
					id: "app-1",
					slug: "google-docs-tedix",
					name: "Google Docs",
					descopeResourceId: null,
					authMode: null,
					codeMode: null,
					connectionProviderId: "google-docs",
				},
			],
		} as never);
		const flagged = report.issues.find(
			(i) => i.code === "connection_provider_unregistered",
		);
		expect(flagged?.severity).toBe("warning");
		expect(flagged?.resourceId).toBe("google-docs");
		expect(flagged?.details).toMatchObject({ appSlugs: ["google-docs-tedix"] });
	});

	it("flags missing OAuth defaults while allowing harmless scope supersets", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-02T00:00:00.000Z",
			projectId: "project-id",
			servers: [],
			clientsByServerId: new Map(),
			tenants: [],
			roles: [],
			fgaRelations: [],
			d1Tedis: [],
			providers: [
				{
					id: "gmail",
					name: "Gmail",
					description: "",
					icon: "",
					category: "productivity",
					type: "oauth",
					requiredScopes: ["gmail.readonly", "gmail.modify"],
					supportedScopes: ["tenant", "user"],
					recommendedScope: "user",
					descopeAppId: "gmail",
				},
				{
					id: "calendar",
					name: "Calendar",
					description: "",
					icon: "",
					category: "productivity",
					type: "oauth",
					requiredScopes: ["calendar.readonly"],
					supportedScopes: ["tenant", "user"],
					recommendedScope: "user",
					descopeAppId: "calendar",
				},
				{
					id: "drive",
					name: "Drive",
					description: "",
					icon: "",
					category: "productivity",
					type: "oauth",
					requiredScopes: ["drive.readonly"],
					supportedScopes: ["tenant", "user"],
					recommendedScope: "user",
					descopeAppId: "drive",
				},
			],
			outboundApps: [
				{
					id: "gmail",
					name: "Gmail",
					appType: "oauth",
					defaultScopes: [],
				},
				{
					id: "calendar",
					name: "Calendar",
					appType: "oauth",
					defaultScopes: ["calendar.events"],
				},
				{
					id: "drive",
					name: "Drive",
					appType: "oauth",
					defaultScopes: ["openid", "profile", "drive.readonly"],
				},
			],
			d1Apps: [
				{
					id: "app-gmail",
					slug: "gmail-app",
					name: "Gmail App",
					descopeResourceId: null,
					authMode: null,
					codeMode: null,
					connectionProviderId: "gmail",
				},
				{
					id: "app-calendar",
					slug: "calendar-app",
					name: "Calendar App",
					descopeResourceId: null,
					authMode: null,
					codeMode: null,
					connectionProviderId: "calendar",
				},
				{
					id: "app-drive",
					slug: "drive-app",
					name: "Drive App",
					descopeResourceId: null,
					authMode: null,
					codeMode: null,
					connectionProviderId: "drive",
				},
			],
		} as never);

		expect(report.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				"connection_provider_default_scopes_missing",
				"connection_provider_default_scopes_drift",
			]),
		);
		expect(
			report.issues.find(
				(issue) => issue.code === "connection_provider_default_scopes_missing",
			)?.resourceId,
		).toBe("gmail");
		expect(
			report.issues.find(
				(issue) => issue.code === "connection_provider_default_scopes_drift",
			)?.resourceId,
		).toBe("calendar");
		expect(
			report.issues.some(
				(issue) =>
					issue.code === "connection_provider_default_scopes_drift" &&
					issue.resourceId === "drive",
			),
		).toBe(false);
		expect(
			report.issues.find(
				(issue) => issue.code === "connection_provider_default_scopes_drift",
			)?.details,
		).toMatchObject({ missingDefaultScopes: ["calendar.readonly"] });
	});

	it("detects exact audience and managed ownership-tag drift for D1 MCP apps", () => {
		const report = buildDescopeAihDriftReport({
			checkedAt: "2026-08-12T00:00:00.000Z",
			projectId: "project-id",
			servers: [
				{
					id: "RS-resource-clean",
					name: "Unified Resource",
					audienceWhitelist: ["https://unified.mcp.tedix.dev/mcp"],
					cimdSettings: {
						enabled: true,
						domainPolicies: {
							policies: [{ domainPattern: "os.tedix.dev", enabled: true }],
						},
					},
					tags: [
						"managed-by:tedix",
						"resource:mcp-app",
						"environment:shared",
						"app:unified",
					],
				},
				{
					id: "RS-server-clean",
					name: "Acme",
					audienceWhitelist: ["https://acme.mcp.tedix.dev/mcp"],
					cimdSettings: {
						enabled: true,
						domainPolicies: {
							policies: [{ domainPattern: "os.tedix.dev", enabled: true }],
						},
					},
					tags: [
						"custom:preserved",
						"managed-by:tedix",
						"resource:mcp-app",
						"environment:shared",
						"app:acme",
					],
				},
				{
					id: "server-drift",
					name: "Docs",
					audienceWhitelist: [
						"https://docs.mcp.tedix.dev/mcp",
						"https://docs.mcp.tedix.tech/mcp",
					],
					tags: [
						"managed-by:manual",
						"resource:mcp-app",
						"environment:production",
						"app:old-docs",
					],
				},
				{
					id: "server-unsafe",
					name: "Skills",
					audienceWhitelist: [
						"https://skills.mcp.tedix.dev/mcp",
						"https://skills.mcp.tedi.club/mcp",
						"https://skills.mcp.tedix.tech/mcp",
						"https://*.mcp.tedix.dev/mcp",
						"https://other.mcp.tedix.dev/mcp",
						"https://unknown.example/mcp",
					],
					tags: [
						"managed-by:tedix",
						"resource:mcp-app",
						"environment:shared",
						"app:skills",
					],
				},
			],
			clientsByServerId: new Map(),
			outboundApps: [],
			tenants: [],
			roles: [],
			fgaRelations: [],
			providers: [],
			d1Apps: [
				{
					id: "app-resource-clean",
					slug: "unified",
					name: "Unified",
					descopeResourceId: "RS-resource-clean",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
				},
				{
					id: "app-clean",
					slug: "acme",
					name: "Acme",
					descopeResourceId: "RS-server-clean",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
				},
				{
					id: "app-drift",
					slug: "docs",
					name: "Docs",
					descopeResourceId: "server-drift",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
				},
				{
					id: "app-unsafe",
					slug: "skills",
					name: "Skills",
					descopeResourceId: "server-unsafe",
					authMode: "authenticated",
					codeMode: true,
					connectionProviderId: null,
				},
			],
			d1Tedis: [],
		});

		const issuesFor = (resourceId: string) =>
			report.issues.filter((entry) => entry.resourceId === resourceId);
		expect(issuesFor("RS-resource-clean")).toEqual([]);
		expect(issuesFor("RS-server-clean")).toEqual([]);

		const audienceDrift = issuesFor("server-drift").find(
			(entry) => entry.code === "mcp_server_audience_drift",
		);
		expect(audienceDrift?.details).toMatchObject({
			missingAudiences: [],
			unexpectedAudiences: ["https://docs.mcp.tedix.tech/mcp"],
		});
		expect(
			issuesFor("server-drift").find(
				(entry) => entry.code === "mcp_server_ownership_tag_drift",
			)?.details,
		).toMatchObject({
			missingTags: ["managed-by:tedix", "environment:shared", "app:docs"],
			unexpectedManagedTags: [
				"app:old-docs",
				"environment:production",
				"managed-by:manual",
			],
		});

		expect(issuesFor("server-unsafe").map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"mcp_server_audience_drift",
				"mcp_server_audience_wildcard",
				"mcp_server_audience_unknown",
			]),
		);
		expect(
			issuesFor("server-unsafe").find(
				(entry) => entry.code === "mcp_server_audience_unknown",
			)?.details,
		).toEqual({
			appId: "app-unsafe",
			appSlug: "skills",
			unknownAudiences: [
				"https://other.mcp.tedix.dev/mcp",
				// The retired staging surface no longer parses as a Tedix audience,
				// so a resource still carrying it is reported instead of ignored.
				"https://skills.mcp.tedi.club/mcp",
				"https://skills.mcp.tedix.tech/mcp",
				"https://unknown.example/mcp",
			],
		});
	});
});
