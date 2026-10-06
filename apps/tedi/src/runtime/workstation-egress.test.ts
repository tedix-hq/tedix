import { describe, expect, it } from "vite-plus/test";
import type { TediConfig } from "../types";
import {
	createWorkstationOutboundHandlerParams,
	createSelectedWorkstationOutboundHandlerParams,
	DENY_ALL_SENTINEL,
	resolveWorkstationEgress,
	workstationEgressPolicySummary,
} from "./workstation-egress";

function configWith(
	workstationEgress: TediConfig["workstationEgress"],
	secrets: TediConfig["secrets"] = {},
	repoUrl?: string,
): TediConfig {
	return {
		secrets,
		workstationEgress,
		...(repoUrl
			? {
					repoConfig: {
						branch: "main",
						githubAppEnabled: true,
						githubInstallationId: 987,
						githubRepositoryId: 123,
						repoUrl,
					},
				}
			: {}),
	} as TediConfig;
}

describe("resolveWorkstationEgress", () => {
	it("creates an exact Artifacts Git route only for a correlated Work attempt", () => {
		const host = `${"a".repeat(32)}.artifacts.cloudflare.net`;
		const config = configWith({
			artifactsRepository: {
				host,
				path: "/git/tedix-prod/cms-theme-tedix-landing.git",
			},
		});
		expect(resolveWorkstationEgress(config).proxyRoutes).toEqual([]);
		const params = createWorkstationOutboundHandlerParams(config, {
			attemptId: "attempt_test",
			leaseId: "lease_test",
			organizationId: "org_test",
			profileId: "general",
			tediId: "tedi_test",
			workstationId: "ws_test",
			workItemId: "work_test",
		});
		expect(params.tedixProxyRequiredHosts).toEqual([host]);
		expect(params.tedixProxyRoutes).toEqual([
			expect.objectContaining({
				credentialProvider: "artifacts_token",
				artifactsRepositoryPath: "/git/tedix-prod/cms-theme-tedix-landing.git",
				hosts: [host],
				id: "artifacts-git-transport",
				ports: [443],
			}),
		]);
	});
	it("defaults to deny-all when no egress config is present", () => {
		expect(resolveWorkstationEgress(configWith(undefined))).toEqual({
			allowedHosts: [DENY_ALL_SENTINEL],
			deniedHosts: [],
			headerInjectionFailures: [],
			injectedHeaders: [],
			loggingMode: "deny_only",
			proxyRoutes: [],
		});
		expect(resolveWorkstationEgress(configWith(null))).toEqual({
			allowedHosts: [DENY_ALL_SENTINEL],
			deniedHosts: [],
			headerInjectionFailures: [],
			injectedHeaders: [],
			loggingMode: "deny_only",
			proxyRoutes: [],
		});
	});

	it("defaults to deny-all when the allowed list is empty", () => {
		expect(resolveWorkstationEgress(configWith({ allowedHosts: [] }))).toEqual({
			allowedHosts: [DENY_ALL_SENTINEL],
			deniedHosts: [],
			headerInjectionFailures: [],
			injectedHeaders: [],
			loggingMode: "deny_only",
			proxyRoutes: [],
		});
	});

	it("passes through configured allowed hosts (normalized)", () => {
		const resolved = resolveWorkstationEgress(
			configWith({ allowedHosts: ["  API.GitHub.com ", "*.npmjs.org", ""] }),
		);
		expect(resolved.allowedHosts).toEqual(["api.github.com", "*.npmjs.org"]);
		expect(resolved.deniedHosts).toEqual([]);
		expect(resolved.injectedHeaders).toEqual([]);
		expect(resolved.loggingMode).toBe("deny_only");
		expect(resolved.proxyRoutes).toEqual([]);
	});

	it("passes through configured denied hosts alongside allowed hosts", () => {
		const resolved = resolveWorkstationEgress(
			configWith({
				allowedHosts: ["*.github.com"],
				deniedHosts: ["evil.example.com"],
			}),
		);
		expect(resolved.allowedHosts).toEqual(["*.github.com"]);
		expect(resolved.deniedHosts).toEqual(["evil.example.com"]);
		expect(resolved.injectedHeaders).toEqual([]);
		expect(resolved.loggingMode).toBe("deny_only");
		expect(resolved.proxyRoutes).toEqual([]);
	});

	it("ignores non-string / malformed entries", () => {
		const resolved = resolveWorkstationEgress(
			configWith({
				// Malformed runtime data: non-string entries are dropped.
				allowedHosts: [42, null, "ok.example.com"] as unknown as string[],
			}),
		);
		expect(resolved.allowedHosts).toEqual(["ok.example.com"]);
		expect(resolved.injectedHeaders).toEqual([]);
		expect(resolved.loggingMode).toBe("deny_only");
		expect(resolved.proxyRoutes).toEqual([]);
	});

	it("preserves deny-only logging mode", () => {
		expect(
			resolveWorkstationEgress(
				configWith({
					allowedHosts: ["api.github.com"],
					loggingMode: "deny_only",
				}),
			).loggingMode,
		).toBe("deny_only");
	});

	it("resolves header injection rules from secret refs", () => {
		const resolved = resolveWorkstationEgress(
			configWith(
				{
					allowedHosts: ["api.vendor.com"],
					injectHeaders: [
						{
							header: "Authorization",
							hosts: ["API.VENDOR.COM"],
							value: { prefix: "Bearer ", secretRef: "VENDOR_API_KEY" },
						},
					],
				},
				{ VENDOR_API_KEY: "vendor-secret" },
			),
		);

		expect(resolved.injectedHeaders).toEqual([
			{
				header: "Authorization",
				hosts: ["api.vendor.com"],
				secretRef: "VENDOR_API_KEY",
				value: "Bearer vendor-secret",
			},
		]);
		expect(resolved.headerInjectionFailures).toEqual([]);
	});

	it("fails closed when a header injection secret is missing", () => {
		const resolved = resolveWorkstationEgress(
			configWith({
				allowedHosts: ["api.vendor.com"],
				injectHeaders: [
					{
						header: "X-Vendor-Key",
						hosts: ["api.vendor.com"],
						value: { secretRef: "MISSING_VENDOR_KEY" },
					},
				],
			}),
		);

		expect(resolved.injectedHeaders).toEqual([]);
		expect(resolved.headerInjectionFailures).toEqual([
			{
				header: "X-Vendor-Key",
				hosts: ["api.vendor.com"],
				reason: "missing_secret",
				secretRef: "MISSING_VENDOR_KEY",
			},
		]);
	});

	it("derives GitHub App repository scope only with live correlated authority", () => {
		const config = configWith(
			{ allowedHosts: ["github.com", "api.github.com"] },
			{ GITHUB_PAT: "must-not-be-forwarded" },
			"https://github.com/tedix/tedix.git",
		);
		expect(resolveWorkstationEgress(config).proxyRoutes).toEqual([]);
		const resolved = createWorkstationOutboundHandlerParams(config, {
			attemptId: "attempt_test",
			leaseId: "lease_test",
			organizationId: "org_test",
			profileId: "general",
			tediId: "tedi_test",
			workItemId: "work_test",
			workstationId: "ws_test",
		});

		expect(resolved.tedixProxyRoutes).toMatchObject([
			{
				credentialProvider: "github_app",
				githubInstallationId: 987,
				githubRepository: "tedix/tedix",
				githubRepositoryId: 123,
				hosts: ["github.com"],
				id: "github-git-transport",
			},
			{
				credentialProvider: "github_app",
				githubInstallationId: 987,
				githubRepository: "tedix/tedix",
				githubRepositoryId: 123,
				hosts: ["api.github.com"],
				id: "github-api-transport",
			},
		]);
		expect(
			JSON.stringify(workstationEgressPolicySummary(config)),
		).not.toContain("must-not-be-forwarded");
	});

	it("retains the App route when an internal workstation request refreshes egress", () => {
		const config = configWith(
			{ allowedHosts: ["github.com"] },
			{},
			"https://github.com/tedix/tedix.git",
		);
		config.organizationId = "org_test";
		const selection = {
			attemptId: "attempt_test",
			leaseId: "lease_test",
			participantTediId: "tedi_test",
			workItemId: "work_test",
			workstationId: "ws_test",
		};
		const active = createSelectedWorkstationOutboundHandlerParams(
			config,
			selection,
		);
		expect(active.workItemId).toBe(selection.workItemId);
		expect(active.attemptId).toBe(selection.attemptId);
		expect(active.tedixProxyRequiredHosts).toEqual([
			"github.com",
			"api.github.com",
		]);
		expect(active.tedixProxyRoutes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "github-git-transport" }),
			]),
		);
		expect(
			createSelectedWorkstationOutboundHandlerParams(config, {
				...selection,
				workItemId: null,
			}).tedixProxyRoutes,
		).toEqual([]);
	});

	it.each([
		"git@github.com:tedix/tedix.git",
		"https://github.com/tedix/tedix/extra",
		"https://github.com/tedix/tedix.git?token=caller-controlled",
		"https://caller@github.com/tedix/tedix.git",
		"https://github.example.com/tedix/tedix.git",
	])(
		"does not mint a route from an untrusted repository URL: %s",
		(repoUrl) => {
			expect(
				resolveWorkstationEgress(
					configWith({ allowedHosts: ["github.com"] }, {}, repoUrl),
				).proxyRoutes,
			).toEqual([]);
		},
	);
});

describe("createWorkstationOutboundHandlerParams", () => {
	it("uses Tedix-private host policy params instead of SDK-reserved names", () => {
		const params = createWorkstationOutboundHandlerParams(
			configWith({
				allowedHosts: ["API.GitHub.com"],
				deniedHosts: ["blocked.example.com"],
			}),
			{
				leaseId: "lease_test",
				organizationId: "org_test",
				profileId: "general",
				tediId: "tedi_test",
				traceId: "trace_test",
				workstationId: "ws_test",
			},
		);

		expect(params).not.toHaveProperty("allowedHosts");
		expect(params).not.toHaveProperty("deniedHosts");
		expect(params).toMatchObject({
			leaseId: "lease_test",
			organizationId: "org_test",
			profileId: "general",
			tediId: "tedi_test",
			traceId: "trace_test",
			tedixEgressLoggingMode: "deny_only",
			tedixAllowedHosts: ["api.github.com"],
			tedixDeniedHosts: ["blocked.example.com"],
			tedixHeaderInjectionFailures: [],
			tedixInjectedHeaders: [],
			tedixProxyRoutes: [],
			workstationId: "ws_test",
		});
	});

	it("passes the deny-all sentinel under the private allow-list param", () => {
		const params = createWorkstationOutboundHandlerParams(
			configWith(undefined),
			{
				leaseId: "lease_test",
				organizationId: null,
				profileId: "general",
				tediId: "tedi_test",
				workstationId: "ws_test",
			},
		);

		expect(params.tedixAllowedHosts).toEqual([DENY_ALL_SENTINEL]);
		expect(params.tedixDeniedHosts).toEqual([]);
		expect(params.tedixEgressLoggingMode).toBe("deny_only");
		expect(params.tedixInjectedHeaders).toEqual([]);
		expect(params.tedixProxyRoutes).toEqual([]);
	});

	it("passes resolved injected headers under Tedix-private params", () => {
		const params = createWorkstationOutboundHandlerParams(
			configWith(
				{
					allowedHosts: ["api.vendor.com"],
					injectHeaders: [
						{
							header: "X-Vendor-Key",
							hosts: ["api.vendor.com"],
							value: { secretRef: "VENDOR_KEY", suffix: ":signed" },
						},
					],
				},
				{ VENDOR_KEY: "secret-value" },
			),
			{
				leaseId: "lease_test",
				organizationId: "org_test",
				profileId: "general",
				tediId: "tedi_test",
				workstationId: "ws_test",
			},
		);

		expect(params.tedixInjectedHeaders).toEqual([
			{
				header: "X-Vendor-Key",
				hosts: ["api.vendor.com"],
				secretRef: "VENDOR_KEY",
				value: "secret-value:signed",
			},
		]);
	});
});

describe("workstationEgressPolicySummary", () => {
	it("hides the internal deny-all sentinel from public status payloads", () => {
		expect(workstationEgressPolicySummary(configWith(undefined))).toEqual({
			allowedHosts: [],
			deniedHosts: [],
			defaultDeny: true,
			headerInjections: [],
			loggingMode: "deny_only",
			mode: "allow_list",
		});
	});

	it("returns the effective configured host lists", () => {
		expect(
			workstationEgressPolicySummary(
				configWith({
					allowedHosts: ["api.github.com"],
					deniedHosts: ["blocked.example.com"],
				}),
			),
		).toEqual({
			allowedHosts: ["api.github.com"],
			deniedHosts: ["blocked.example.com"],
			defaultDeny: false,
			headerInjections: [],
			loggingMode: "deny_only",
			mode: "allow_list",
		});
	});

	it("summarizes header injection policy without secret values", () => {
		const summary = workstationEgressPolicySummary(
			configWith(
				{
					allowedHosts: ["api.vendor.com"],
					injectHeaders: [
						{
							header: "Authorization",
							hosts: ["api.vendor.com"],
							value: { prefix: "Bearer ", secretRef: "VENDOR_API_KEY" },
						},
					],
				},
				{ VENDOR_API_KEY: "vendor-secret" },
			),
		);

		expect(summary).toEqual({
			allowedHosts: ["api.vendor.com"],
			deniedHosts: [],
			defaultDeny: false,
			headerInjections: [
				{
					header: "Authorization",
					hosts: ["api.vendor.com"],
					secretAvailable: true,
					secretRef: "VENDOR_API_KEY",
				},
			],
			loggingMode: "deny_only",
			mode: "allow_list",
		});
		expect(JSON.stringify(summary)).not.toContain("vendor-secret");
	});

	it("reports configured deny-only logging mode", () => {
		expect(
			workstationEgressPolicySummary(
				configWith({
					allowedHosts: ["api.github.com"],
					loggingMode: "deny_only",
				}),
			),
		).toMatchObject({
			allowedHosts: ["api.github.com"],
			loggingMode: "deny_only",
		});
	});
});
