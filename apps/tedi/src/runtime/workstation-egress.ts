/**
 * Workstation egress allow/deny resolution.
 *
 * Turns a workstation's configured egress policy (sourced from
 * `runtime_profiles.config.runtimePolicy.workstationEgress`) into the concrete
 * host policy passed to the workstation runtime's named outbound handler under
 * Tedix-private param names.
 *
 * Default posture is DENY-ALL-BUT-CONFIGURED. The runtime handler treats an
 * empty allow-list as "no policy gate", so when no domains are configured we
 * install a sentinel that matches nothing, making "no config" mean "no
 * egress" rather than "open egress". The workstation runtime's static
 * `outbound` SSRF guard is the second layer that blocks private/metadata ranges
 * even for explicitly allow-listed globs. Do not pass SDK-reserved
 * `allowedHosts` / `deniedHosts` params from the edge: the Cloudflare
 * Containers SDK evaluates them before Tedix's catch-all handler can record
 * deny events.
 */

import type { TediConfig } from "../types";

/**
 * Sentinel allow-list entry used when a workstation has no configured egress
 * domains. The named outbound handler matches allow-list entries by exact
 * string or glob; this value contains no `*` and an invalid-host marker, so it
 * can never match a real hostname.
 */
export const DENY_ALL_SENTINEL = "__tedix-egress-deny-all__.invalid";

export interface ResolvedWorkstationEgress {
	allowedHosts: string[];
	deniedHosts: string[];
	headerInjectionFailures: WorkstationHeaderInjectionFailure[];
	injectedHeaders: WorkstationInjectedHeader[];
	loggingMode: WorkstationEgressLoggingMode;
	proxyRoutes: WorkstationProxyEgressRoute[];
}

export interface WorkstationEgressEvidenceContext {
	attemptId?: string | null;
	kernelRunId?: string | null;
	traceBundleId?: string | null;
	traceId?: string | null;
	workItemId?: string | null;
}

export interface WorkstationOutboundHandlerIdentity {
	leaseId: string;
	organizationId: string | null;
	profileId: string;
	tediId: string;
	workstationId: string;
}

export interface WorkstationOutboundHandlerParams
	extends WorkstationOutboundHandlerIdentity, WorkstationEgressEvidenceContext {
	tedixEgressLoggingMode: WorkstationEgressLoggingMode;
	tedixAllowedHosts: string[];
	tedixDeniedHosts: string[];
	tedixHeaderInjectionFailures: WorkstationHeaderInjectionFailure[];
	tedixInjectedHeaders: WorkstationInjectedHeader[];
	tedixProxyRequiredHosts: string[];
	tedixProxyRoutes: WorkstationProxyEgressRoute[];
}

export type WorkstationEgressLoggingMode = "all" | "deny_only";

export interface WorkstationInjectedHeader {
	header: string;
	hosts: string[];
	secretRef: string;
	value: string;
}

export interface WorkstationHeaderInjectionFailure {
	header: string;
	hosts: string[];
	reason: "invalid_header_value" | "missing_secret";
	secretRef: string;
}

export interface WorkstationProxyEgressRoute {
	credentialProvider: "github_app" | "artifacts_token";
	githubRepository?: string;
	githubRepositoryId?: number;
	githubInstallationId?: number;
	artifactsRepositoryPath?: string;
	hosts: string[];
	id: string;
	mode: "forward";
	ports?: number[];
	proxyRef: string;
}

type ConfiguredHeaderInjectionRule = NonNullable<
	NonNullable<TediConfig["workstationEgress"]>["injectHeaders"]
>[number];

function cleanHostList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const host = entry.trim().toLowerCase();
		if (host) out.push(host);
	}
	return out;
}

function secretValueForRule(
	config: TediConfig,
	rule: ConfiguredHeaderInjectionRule,
): WorkstationInjectedHeader | WorkstationHeaderInjectionFailure {
	const secretValue = config.secrets?.[rule.value.secretRef];
	if (typeof secretValue !== "string" || secretValue.length === 0) {
		return {
			header: rule.header,
			hosts: cleanHostList(rule.hosts),
			reason: "missing_secret",
			secretRef: rule.value.secretRef,
		};
	}
	const value = `${rule.value.prefix ?? ""}${secretValue}${rule.value.suffix ?? ""}`;
	if (/[\r\n]/.test(value)) {
		return {
			header: rule.header,
			hosts: cleanHostList(rule.hosts),
			reason: "invalid_header_value",
			secretRef: rule.value.secretRef,
		};
	}
	return {
		header: rule.header,
		hosts: cleanHostList(rule.hosts),
		secretRef: rule.value.secretRef,
		value,
	};
}

function resolveHeaderInjection(config: TediConfig): {
	failures: WorkstationHeaderInjectionFailure[];
	headers: WorkstationInjectedHeader[];
} {
	const rules = config.workstationEgress?.injectHeaders ?? [];
	const headers: WorkstationInjectedHeader[] = [];
	const failures: WorkstationHeaderInjectionFailure[] = [];
	for (const rule of rules) {
		const resolved = secretValueForRule(config, rule);
		if ("value" in resolved) {
			if (resolved.hosts.length > 0) headers.push(resolved);
			continue;
		}
		if (resolved.hosts.length > 0) failures.push(resolved);
	}
	return { failures, headers };
}

function resolveProxyRoutes(
	config: TediConfig,
	taskAuthority: boolean,
): WorkstationProxyEgressRoute[] {
	const artifactsRepository = config.workstationEgress?.artifactsRepository;
	const artifactsRoute: WorkstationProxyEgressRoute[] =
		taskAuthority && artifactsRepository
			? [
					{
						credentialProvider: "artifacts_token",
						artifactsRepositoryPath: artifactsRepository.path,
						hosts: [artifactsRepository.host],
						id: "artifacts-git-transport",
						mode: "forward",
						ports: [443],
						proxyRef: "workstation-egress-proxy",
					},
				]
			: [];
	const githubRepository = githubRepositoryFromUrl(config.repoConfig?.repoUrl);
	const githubRepositoryId = config.repoConfig?.githubRepositoryId;
	const githubInstallationId = config.repoConfig?.githubInstallationId;
	if (
		!taskAuthority ||
		config.repoConfig?.githubAppEnabled !== true ||
		!githubRepository ||
		typeof githubRepositoryId !== "number" ||
		!Number.isSafeInteger(githubRepositoryId) ||
		typeof githubInstallationId !== "number" ||
		!Number.isSafeInteger(githubInstallationId)
	)
		return artifactsRoute;

	// GitHub authority is minted by the broker from its GitHub App installation.
	// Only the configured repository identity crosses the runtime boundary: no PAT,
	// App key, installation token, or caller-supplied repository scope does.
	return [
		...artifactsRoute,
		{
			credentialProvider: "github_app",
			githubRepository,
			githubRepositoryId,
			githubInstallationId,
			hosts: ["github.com"],
			id: "github-git-transport",
			mode: "forward",
			ports: [443],
			proxyRef: "workstation-egress-proxy",
		},
		{
			credentialProvider: "github_app",
			githubRepository,
			githubRepositoryId,
			githubInstallationId,
			hosts: ["api.github.com"],
			id: "github-api-transport",
			mode: "forward",
			ports: [443],
			proxyRef: "workstation-egress-proxy",
		},
	];
}

function githubRepositoryFromUrl(repoUrl: string | undefined): string | null {
	if (!repoUrl) return null;
	try {
		const url = new URL(repoUrl);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "github.com" ||
			url.username ||
			url.password ||
			url.port ||
			url.search ||
			url.hash
		)
			return null;
		const parts = url.pathname
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/, "")
			.split("/");
		if (parts.length !== 2) return null;
		const [owner, repo] = parts;
		const safe = /^[A-Za-z0-9._-]+$/;
		return owner && repo && safe.test(owner) && safe.test(repo)
			? `${owner}/${repo}`
			: null;
	} catch {
		return null;
	}
}

/**
 * Resolve the effective allow/deny host lists for a workstation sandbox.
 *
 * - `allowedHosts`: the configured domains, or `[DENY_ALL_SENTINEL]` when none
 *   are configured (deny-all default).
 * - `deniedHosts`: the configured denied domains.
 */
export function resolveWorkstationEgress(
	config: TediConfig,
	options: { taskAuthority?: boolean } = {},
): ResolvedWorkstationEgress {
	const egress = config.workstationEgress ?? undefined;
	const allowed = cleanHostList(egress?.allowedHosts);
	const denied = cleanHostList(egress?.deniedHosts);
	const headerInjection = resolveHeaderInjection(config);
	const proxyRoutes = resolveProxyRoutes(
		config,
		options.taskAuthority === true,
	);
	return {
		allowedHosts: allowed.length > 0 ? allowed : [DENY_ALL_SENTINEL],
		deniedHosts: denied,
		headerInjectionFailures: headerInjection.failures,
		injectedHeaders: headerInjection.headers,
		// Successful registry/package traffic is high-volume and low-signal.
		// Denials remain durable by default; profiles may explicitly opt into full
		// allow-event logging for a bounded diagnostic episode.
		loggingMode: egress?.loggingMode ?? "deny_only",
		proxyRoutes,
	};
}

export function createWorkstationOutboundHandlerParams(
	config: TediConfig,
	identity: WorkstationOutboundHandlerIdentity &
		WorkstationEgressEvidenceContext,
): WorkstationOutboundHandlerParams {
	const egress = resolveWorkstationEgress(config, {
		taskAuthority: Boolean(
			identity.organizationId &&
			identity.tediId &&
			identity.workstationId &&
			identity.leaseId &&
			identity.workItemId &&
			identity.attemptId,
		),
	});
	return {
		...identity,
		tedixEgressLoggingMode: egress.loggingMode,
		tedixAllowedHosts: egress.allowedHosts,
		tedixDeniedHosts: egress.deniedHosts,
		tedixHeaderInjectionFailures: egress.headerInjectionFailures,
		tedixInjectedHeaders: egress.injectedHeaders,
		tedixProxyRequiredHosts: [
			...(config.workstationEgress?.artifactsRepository
				? [config.workstationEgress.artifactsRepository.host]
				: []),
			...(config.repoConfig?.githubAppEnabled === true &&
			githubRepositoryFromUrl(config.repoConfig.repoUrl)
				? ["github.com", "api.github.com"]
				: []),
		],
		tedixProxyRoutes: egress.proxyRoutes,
	};
}

/** Preserve the lease's full authority when an internal request refreshes policy. */
export function createSelectedWorkstationOutboundHandlerParams(
	config: TediConfig,
	selection: {
		attemptId?: string | null;
		leaseId: string;
		participantTediId: string;
		workItemId?: string | null;
		workstationId: string;
	},
): WorkstationOutboundHandlerParams {
	return createWorkstationOutboundHandlerParams(config, {
		attemptId: selection.attemptId,
		leaseId: selection.leaseId,
		organizationId: config.organizationId,
		profileId: "general",
		tediId: selection.participantTediId,
		workItemId: selection.workItemId,
		workstationId: selection.workstationId,
	});
}

export function workstationEgressPolicySummary(config: TediConfig): {
	allowedHosts: string[];
	deniedHosts: string[];
	defaultDeny: boolean;
	headerInjections: Array<{
		header: string;
		hosts: string[];
		secretAvailable: boolean;
		secretRef: string;
	}>;
	loggingMode: WorkstationEgressLoggingMode;
	mode: "allow_list";
} {
	const egress = resolveWorkstationEgress(config);
	const defaultDeny = egress.allowedHosts.includes(DENY_ALL_SENTINEL);
	return {
		allowedHosts: defaultDeny ? [] : egress.allowedHosts,
		deniedHosts: egress.deniedHosts,
		defaultDeny,
		headerInjections: [
			...egress.injectedHeaders.map((rule) => ({
				header: rule.header,
				hosts: rule.hosts,
				secretAvailable: true,
				secretRef: rule.secretRef,
			})),
			...egress.headerInjectionFailures.map((rule) => ({
				header: rule.header,
				hosts: rule.hosts,
				secretAvailable: false,
				secretRef: rule.secretRef,
			})),
		],
		loggingMode: egress.loggingMode,
		mode: "allow_list",
	};
}
