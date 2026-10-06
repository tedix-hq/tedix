// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import {
	buildLauncherWorkspacesFromDirectory,
	buildLocalLauncherWorkspaces,
	buildLocalOsUrl,
	buildTenantOsHandoffUrl,
	buildTenantOsUrl,
	collectAuthorizedReturnOrigins,
	type DirectoryWorkspaceRecord,
	getLauncherReturnTarget,
	isReturnTargetAuthorized,
	parseAuthorizedTenantReturnTarget,
	parseSafeHttpsUrl,
	resolveOsPlatformDomain,
	suggestOsOrganizationSlug,
} from "./launcher-routing";

describe("OS launcher routing", () => {
	it("resolves the platform domain from the OS hostname", () => {
		expect(resolveOsPlatformDomain("os.tedix.tech")).toBe("tedix.tech");
		expect(resolveOsPlatformDomain("acme.os.tedix.dev")).toBe("tedix.dev");
	});

	it.each([
		"https://os.tedix.dev/",
		"https://evil.example/",
		"http://acme.os.tedix.dev/",
		"https://user:pass@acme.os.tedix.dev/",
		"https://acme.os.tedix.dev:8443/",
		"not a url",
	])("rejects unsafe return target %s", (target) => {
		expect(parseAuthorizedTenantReturnTarget(target)).toBeNull();
	});

	it("builds only valid tenant URLs", () => {
		expect(buildTenantOsUrl("acme")).toBe("https://acme.os.tedix.dev/");
		expect(buildTenantOsUrl("acme", "tedix.tech")).toBe(
			"https://acme.os.tedix.tech/",
		);
		expect(buildTenantOsUrl("bad.slug")).toBeNull();
		expect(buildLocalOsUrl("acme")).toBe("http://acme.localhost:3030/");
		expect(buildLocalOsUrl("acme", "8787")).toBe("http://acme.localhost:8787/");
		expect(buildLocalOsUrl("bad.slug")).toBeNull();
		expect(buildLocalOsUrl("acme", "bad-port")).toBeNull();
	});

	it("suggests a bounded canonical hostname label", () => {
		expect(suggestOsOrganizationSlug("Ada’s Studio")).toBe("adas-studio");
		expect(suggestOsOrganizationSlug("  Méxïco / Research  ")).toBe(
			"mexico-research",
		);
		expect(suggestOsOrganizationSlug("***", "personal-a1b2c3d4")).toBe(
			"personal-a1b2c3d4",
		);
		expect(suggestOsOrganizationSlug("x".repeat(80))).toHaveLength(63);
	});

	it("preserves an authorized deep link on the tenant origin", () => {
		expect(
			buildTenantOsHandoffUrl(
				new URL("https://acme.os.tedix.dev/workspace/123"),
			),
		).toBe("https://acme.os.tedix.dev/workspace/123");
	});
});

describe("directory-backed returnTo authorization", () => {
	// The directory is the trust root: acme is fully provisioned (OS
	// route-out, plus an MCP copy endpoint and a custom-domain CMS); beta is a
	// provisioned org whose surfaces are all still un-provisioned; ghost has no
	// minted tenant at all. Only currently-provisioned member route-out origins
	// may ever receive a browser redirect.
	const workspaces: DirectoryWorkspaceRecord[] = [
		{
			org: {
				organizationId: "1",
				slug: "acme",
				name: "Acme",
				descopeTenantId: "T-acme",
				provisionComplete: true,
			},
			surfaces: [
				{
					surface: "os",
					provisioned: true,
					canonicalUrl: "https://acme.os.tedix.dev/",
					handoffUrl:
						"https://acme.os.tedix.dev/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
				},
				{
					surface: "cms",
					provisioned: true,
					canonicalUrl: "https://blog.acme.com/_emdash/admin",
					handoffUrl:
						"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F_emdash%2Fadmin",
					customDomain: "blog.acme.com",
				},
				{
					surface: "mcp",
					provisioned: true,
					canonicalUrl: "https://acme.mcp.tedix.dev/mcp",
					handoffUrl: null,
				},
			],
		},
		{
			org: {
				organizationId: "2",
				slug: "beta",
				name: "Beta",
				descopeTenantId: "T-beta",
				provisionComplete: true,
			},
			surfaces: [
				{
					surface: "os",
					provisioned: false,
					canonicalUrl: null,
					handoffUrl: null,
				},
				{
					surface: "cms",
					provisioned: false,
					canonicalUrl: null,
					handoffUrl: null,
				},
				{
					surface: "mcp",
					provisioned: false,
					canonicalUrl: null,
					handoffUrl: null,
				},
			],
		},
		{
			org: {
				organizationId: "3",
				slug: "ghost",
				name: "Ghost",
				descopeTenantId: null,
				provisionComplete: false,
			},
			surfaces: [
				{
					surface: "os",
					provisioned: false,
					canonicalUrl: null,
					handoffUrl: null,
				},
			],
		},
	];
	const origins = collectAuthorizedReturnOrigins(workspaces);

	function authorize(value: string): boolean {
		const target = getLauncherReturnTarget(
			`?returnTo=${encodeURIComponent(value)}`,
		);
		return target ? isReturnTargetAuthorized(target, origins) : false;
	}

	it("derives exactly the provisioned route-out origins (MCP excluded)", () => {
		expect([...origins].sort()).toEqual([
			"https://acme.cms.tedix.dev",
			"https://acme.os.tedix.dev",
			"https://blog.acme.com",
		]);
	});

	it("authorizes the exact OS development origin only in that lane", () => {
		const developmentOrigins = collectAuthorizedReturnOrigins(
			workspaces,
			"tedix.tech",
		);
		expect(developmentOrigins.has("https://acme.os.tedix.tech")).toBe(true);
		expect(developmentOrigins.has("https://beta.os.tedix.tech")).toBe(false);
		expect(origins.has("https://acme.os.tedix.tech")).toBe(false);
	});

	it.each([
		["OS deep link", "https://acme.os.tedix.dev/workspace/123#editor"],
		["custom-domain CMS", "https://blog.acme.com/_emdash/admin/posts"],
	])("authorizes a provisioned member surface (%s)", (_label, value) => {
		expect(authorize(value)).toBe(true);
	});

	it.each([
		["off-host redirect", "https://evil.example/"],
		["look-alike host", "https://acme.os.tedix.dev.evil.example/"],
		["non-https scheme", "http://acme.os.tedix.dev/"],
		["userinfo credentials", "https://user:pass@acme.os.tedix.dev/"],
		["explicit port", "https://acme.os.tedix.dev:8443/"],
		["javascript scheme", "javascript:alert(1)"],
		["data scheme", "data:text/html,<script>1</script>"],
		[
			"MCP endpoint (copy-only, not a route-out)",
			"https://acme.mcp.tedix.dev/mcp",
		],
		[
			"non-provisioned surface of a provisioned org",
			"https://beta.os.tedix.dev/",
		],
		["stale host of an unprovisioned org", "https://ghost.os.tedix.dev/"],
		["not a url", "not a url"],
	])("rejects %s", (_label, value) => {
		expect(authorize(value)).toBe(false);
	});

	it("authorizes nothing when the directory is empty", () => {
		expect(collectAuthorizedReturnOrigins([]).size).toBe(0);
		const target = getLauncherReturnTarget(
			"?returnTo=https://acme.os.tedix.dev/",
		);
		expect(
			target &&
				isReturnTargetAuthorized(target, collectAuthorizedReturnOrigins([])),
		).toBe(false);
	});

	it("parseSafeHttpsUrl gates syntax without restricting the host", () => {
		expect(parseSafeHttpsUrl("https://anything.example/x")?.origin).toBe(
			"https://anything.example",
		);
		expect(parseSafeHttpsUrl("http://acme.os.tedix.dev/")).toBeNull();
		expect(parseSafeHttpsUrl("https://acme.os.tedix.dev:8443/")).toBeNull();
		expect(parseSafeHttpsUrl("javascript:alert(1)")).toBeNull();
		expect(parseSafeHttpsUrl(null)).toBeNull();
	});
});

describe("launcher workspace projection", () => {
	it("maps provisioned surfaces to route-out and MCP-copy entries", () => {
		const records: DirectoryWorkspaceRecord[] = [
			{
				org: {
					organizationId: "1",
					slug: "acme",
					name: "Acme",
					descopeTenantId: "T-acme",
					provisionComplete: true,
				},
				surfaces: [
					{
						surface: "os",
						provisioned: true,
						canonicalUrl: "https://acme.os.tedix.dev/",
						handoffUrl:
							"https://acme.os.tedix.dev/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
					},
					{
						surface: "mcp",
						provisioned: true,
						canonicalUrl: "https://acme.mcp.tedix.dev/mcp",
						handoffUrl: null,
					},
				],
			},
		];
		const acme = buildLauncherWorkspacesFromDirectory(records)[0]!;
		expect(acme.provisioned).toBe(true);
		expect(acme.surfaces).toEqual([
			{
				surface: "os",
				href: "https://acme.os.tedix.dev/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
				copyValue: null,
			},
			{
				surface: "mcp",
				href: null,
				copyValue: "https://acme.mcp.tedix.dev/mcp",
			},
		]);
		expect(
			buildLauncherWorkspacesFromDirectory(records, "tedix.tech")[0]
				?.surfaces[0],
		).toEqual({
			surface: "os",
			href: "https://acme.os.tedix.tech/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
			copyValue: null,
		});
	});

	it("yields a disabled workspace with no surfaces when not provisionComplete", () => {
		const ghost = buildLauncherWorkspacesFromDirectory([
			{
				org: {
					organizationId: "3",
					slug: "ghost",
					name: "Ghost",
					descopeTenantId: null,
					provisionComplete: false,
				},
				surfaces: [
					{
						surface: "os",
						provisioned: true,
						canonicalUrl: "https://ghost.os.tedix.dev/",
						handoffUrl:
							"https://ghost.os.tedix.dev/auth/session-broker/start?tenant_id=T-ghost&redirect_to=%2F",
					},
				],
			},
		])[0]!;
		expect(ghost.provisioned).toBe(false);
		expect(ghost.surfaces).toEqual([]);
	});

	it("builds OS-only localhost route-outs for the local lane", () => {
		expect(
			buildLocalLauncherWorkspaces(
				[
					{
						organizationId: "l1",
						organizationName: "My Local OS",
						organizationSlug: "my-local-os",
					},
				],
				"3030",
			),
		).toEqual([
			{
				organizationId: "l1",
				name: "My Local OS",
				slug: "my-local-os",
				provisioned: true,
				surfaces: [
					{
						surface: "os",
						href: "http://my-local-os.localhost:3030/",
						copyValue: null,
					},
				],
			},
		]);
	});
});
