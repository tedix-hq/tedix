/**
 * Default-deny egress enforcement for workstation sandbox containers.
 *
 * Pure of the Cloudflare Sandbox SDK so it stays unit-testable in a plain
 * `node` Vitest environment. `src/index.ts` registers `outboundEgressHandler`
 * as the container's catch-all `static outbound` handler. The Tedi edge passes
 * host policy under Tedix-private params (`tedixAllowedHosts` /
 * `tedixDeniedHosts`) so the SDK cannot pre-gate before this handler records
 * durable decisions. Retired public parameter names fail closed.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { validateUrl } from "@tedix/ssrf-guard";
import { WORKSTATION_RUNTIME_EVENT_SHAPE_VERSION } from "./event-shape";
import { exceptionTopology } from "./exception-topology";

type EgressDecisionKind = "allow" | "deny";

export type WorkstationEgressEventParams = {
	attemptId?: string | null;
	allowedHosts?: string[];
	deniedHosts?: string[];
	invalidPolicyReason?: "legacy_host_policy_params";
	headerInjectionFailures?: WorkstationHeaderInjectionFailure[];
	injectedHeaders?: WorkstationInjectedHeader[];
	kernelRunId?: string | null;
	leaseId?: string | null;
	loggingMode?: WorkstationEgressLoggingMode;
	organizationId?: string | null;
	profileId?: string | null;
	tediId?: string | null;
	traceBundleId?: string | null;
	traceId?: string | null;
	workstationId?: string | null;
	workItemId?: string | null;
	proxyRequiredHosts?: string[];
	proxyRoutes?: WorkstationProxyEgressRoute[];
};

type WorkstationInjectedHeader = {
	header: string;
	hosts: string[];
	secretRef?: string | null;
	value: string;
};

type WorkstationHeaderInjectionFailure = {
	header: string;
	hosts: string[];
	reason: "invalid_header_value" | "missing_secret";
	secretRef?: string | null;
};

type WorkstationEgressLoggingMode = "all" | "deny_only";

type WorkstationProxyEgressRoute = {
	credentialProvider: "github_app" | "artifacts_token";
	githubRepository?: string;
	githubRepositoryId?: number;
	githubInstallationId?: number;
	artifactsRepositoryPath?: string;
	hosts: string[];
	id: string;
	mode?: "forward";
	ports?: number[];
	proxyRef: string;
};

type MatchedEgressRoute = {
	id: string;
	ref: string;
	type: "proxy";
};

type WorkstationApiService = {
	fetch(request: Request): Promise<Response>;
};

type WorkstationRouteBroker = {
	fetch(request: Request): Promise<Response>;
};

export type WorkstationEgressEnv = {
	API_SERVICE?: WorkstationApiService;
	ENVIRONMENT?: string;
	WORKSTATION_EGRESS_PROXY?: WorkstationRouteBroker;
};

export type WorkstationEgressContext = {
	className: string;
	containerId: string;
	params?: unknown;
};

type EgressDecision = {
	brokerError?: string;
	brokerStatus?: number;
	decision: EgressDecisionKind;
	error?: string;
	host: string;
	injectedHeaderCount?: number;
	method: string;
	protocol: string;
	reason: string;
	route?: MatchedEgressRoute;
};

type EgressDecisionOptions = {
	routeBrokerAvailable?: (route: MatchedEgressRoute) => boolean;
};

/**
 * Stable, greppable prefix for workstation egress decisions. Durable runtime
 * events are emitted when the API service binding and tedi/org context are
 * available, but logs remain the lowest-level fallback. Format:
 *
 *   [workstation-egress] decision=allow|deny host=<host> reason=<code>
 *
 * `reason` codes are stable snake_case tokens (not free text) so they can be
 * counted/grepped directly: private_network, internal_service, blocked_host,
 * protocol, invalid_url, ok.
 */
const EGRESS_LOG_PREFIX = "[workstation-egress]";
const WORKSTATION_EGRESS_TRACE_HEADER = "x-tedix-workstation-trace-id";
const PROXY_ROUTE_BROKER_BINDINGS = {
	"workstation-egress-proxy": "WORKSTATION_EGRESS_PROXY",
} as const;

/** Map a validateUrl() message to a stable, greppable reason code. */
function reasonCode(error: string): string {
	switch (error) {
		case "Cannot connect to private networks":
			return "private_network";
		case "Cannot connect to internal services":
			return "internal_service";
		case "Blocked host":
			return "blocked_host";
		case "URL must use HTTPS":
		case "URL must use HTTP(S)":
			return "protocol";
		case "Invalid URL":
			return "invalid_url";
		default:
			return "blocked";
	}
}

/** Best-effort hostname for the log line; never throws. */
function hostOf(rawUrl: string): string {
	try {
		return new URL(rawUrl).hostname.toLowerCase() || "unknown";
	} catch {
		return "unparseable";
	}
}

function protocolOf(rawUrl: string): string {
	try {
		return (
			new URL(rawUrl).protocol.replace(/:$/, "").toLowerCase() || "unknown"
		);
	} catch {
		return "unknown";
	}
}

function portOf(rawUrl: string): number | null {
	try {
		const url = new URL(rawUrl);
		if (url.port) return Number(url.port);
		if (url.protocol === "http:") return 80;
		if (url.protocol === "https:") return 443;
		return null;
	} catch {
		return null;
	}
}

function methodOf(method: string): string {
	const value = method.trim().toUpperCase();
	return /^[A-Z]+$/.test(value) ? value.slice(0, 16) : "UNKNOWN";
}

function cleanHostPattern(value: string): string {
	return value.trim().toLowerCase();
}

function simpleGlobMatch(pattern: string, host: string): boolean {
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i").test(host);
}

function hostMatches(patterns: readonly string[] | undefined, host: string) {
	if (!patterns?.length) return false;
	return patterns
		.map(cleanHostPattern)
		.filter(Boolean)
		.some((pattern) => pattern === host || simpleGlobMatch(pattern, host));
}

function portMatches(
	ports: readonly number[] | undefined,
	port: number | null,
) {
	return !ports?.length || (port !== null && ports.includes(port));
}

// tedi.club is retired as a deploy target but Tedix still owns the zone and
// its proxied wildcard DNS, so it stays in this deny list — removing a host
// here grants egress rather than revoking it.
//
// Not a copy of @tedix/ssrf-guard: a matching GitHub proxy route can override
// a `validateUrl` denial. These hosts must never be routable through that
// override, even when a trusted caller opts into Tedix-host access.
function isHardBlockedRouteHost(host: string): boolean {
	return (
		host === "localhost" ||
		host === "metadata.google.internal" ||
		host === "api.tedix.dev" ||
		host === "api.tedi.club" ||
		host === "api.tedix.tech" ||
		host === "mcp.tedix.dev" ||
		host === "mcp.tedi.club" ||
		host === "mcp.tedix.tech" ||
		host === "tedix.dev" ||
		host === "tedi.club" ||
		host.endsWith(".tedix.dev") ||
		host.endsWith(".tedi.club") ||
		// Dev tunnel zone (subdomains only — the tedix.tech apex is an
		// external site, not a Tedix service)
		host.endsWith(".tedix.tech") ||
		host === "169.254.169.254" ||
		host === "0.0.0.0" ||
		host === "2130706433" ||
		host.startsWith("127.") ||
		host === "::1"
	);
}

function matchedEgressRoute(
	host: string,
	port: number | null,
	policy?: WorkstationEgressEventParams,
): MatchedEgressRoute | null {
	if (isHardBlockedRouteHost(host)) return null;
	for (const route of policy?.proxyRoutes ?? []) {
		if (!hostMatches(route.hosts, host) || !portMatches(route.ports, port)) {
			continue;
		}
		return {
			id: route.id,
			ref: route.proxyRef,
			type: "proxy",
		};
	}
	return null;
}

function matchedInjectedHeaders(
	host: string,
	policy?: WorkstationEgressEventParams,
): WorkstationInjectedHeader[] {
	return (policy?.injectedHeaders ?? []).filter((rule) =>
		hostMatches(rule.hosts, host),
	);
}

function policyDecision(
	host: string,
	port: number | null,
	policy?: WorkstationEgressEventParams,
	options: EgressDecisionOptions = {},
): Pick<EgressDecision, "decision" | "reason" | "route"> | null {
	if (policy?.invalidPolicyReason) {
		return { decision: "deny", reason: policy.invalidPolicyReason };
	}
	if (hostMatches(policy?.deniedHosts, host)) {
		return { decision: "deny", reason: "blocked_host" };
	}

	const route = matchedEgressRoute(host, port, policy);
	if (route) {
		const routeAvailable = options.routeBrokerAvailable?.(route) === true;
		if (routeAvailable) {
			return { decision: "allow", reason: "proxy_route", route };
		}
		return { decision: "deny", reason: "proxy_route_unavailable", route };
	}
	if (hostMatches(policy?.proxyRequiredHosts, host)) {
		return { decision: "deny", reason: "proxy_route_required" };
	}

	const allowedHosts = policy?.allowedHosts
		?.map(cleanHostPattern)
		.filter(Boolean);
	if (!allowedHosts || allowedHosts.length === 0) return null;
	if (!hostMatches(allowedHosts, host)) {
		return { decision: "deny", reason: "blocked_host" };
	}
	const missingInjection = policy?.headerInjectionFailures?.find((rule) =>
		hostMatches(rule.hosts, host),
	);
	if (missingInjection) {
		return { decision: "deny", reason: missingInjection.reason };
	}
	return null;
}

export function egressDecisionForRequest(
	request: Request,
	policy?: WorkstationEgressEventParams,
	options: EgressDecisionOptions = {},
): EgressDecision {
	const error = validateUrl(request.url, { allowHttp: true });
	const host = hostOf(request.url);
	const port = portOf(request.url);
	const base = {
		host,
		method: methodOf(request.method),
		protocol: protocolOf(request.url),
	};
	if (!error) {
		const policyResult = policyDecision(host, port, policy, options);
		if (policyResult) return { ...base, ...policyResult };
	} else {
		const policyResult = policyDecision(host, port, policy, options);
		if (policyResult?.route) return { ...base, ...policyResult };
	}
	const injectedHeaderCount =
		!error && policy ? matchedInjectedHeaders(host, policy).length : 0;
	return {
		decision: error ? "deny" : "allow",
		error: error ?? undefined,
		...(injectedHeaderCount > 0 ? { injectedHeaderCount } : {}),
		...base,
		reason: error ? reasonCode(error) : "ok",
	};
}

function shouldLogDecision(
	decision: EgressDecision,
	mode: WorkstationEgressLoggingMode,
): boolean {
	return mode === "all" || decision.decision === "deny";
}

function logDecision(
	decision: EgressDecision,
	mode: WorkstationEgressLoggingMode = "all",
): void {
	if (!shouldLogDecision(decision, mode)) return;
	const message = `${EGRESS_LOG_PREFIX} decision=${decision.decision} host=${decision.host} reason=${decision.reason}`;
	if (decision.decision === "deny") {
		console.warn(message);
		return;
	}
	console.log(message);
}

function blockedResponse(decision: EgressDecision): Response {
	return new Response(`Egress blocked: ${decision.error ?? "Blocked host"}`, {
		status: 403,
	});
}

function brokerResultDecision(
	decision: EgressDecision,
	result:
		| { kind: "allow"; status: number }
		| { error?: string; kind: "deny"; reason: string; status?: number },
): EgressDecision {
	return {
		...decision,
		...(result.kind === "deny" && result.error
			? { brokerError: result.error }
			: {}),
		...(result.status ? { brokerStatus: result.status } : {}),
		decision: result.kind === "allow" ? "allow" : "deny",
		reason: result.kind === "allow" ? decision.reason : result.reason,
	};
}

function routeBrokerStatusReason(status: number): string {
	if (status === 403) return "route_broker_denied";
	if (status === 501) return "route_broker_unimplemented";
	if (status >= 500) return "route_broker_failed";
	return "route_broker_status";
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const strings = value
		.map((entry) => optionalString(entry))
		.filter((entry): entry is string => Boolean(entry));
	return strings.length > 0 ? strings : undefined;
}

function rawString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalPositiveSafeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

function loggingModeParam(value: unknown): WorkstationEgressLoggingMode {
	return value === "deny_only" ? "deny_only" : "all";
}

function stringListParam(
	record: Record<string, unknown>,
	key: string,
): string[] | undefined {
	if (!(key in record)) return undefined;
	return optionalStringList(record[key]) ?? [];
}

function recordOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function injectedHeaderParam(value: unknown): WorkstationInjectedHeader | null {
	const record = recordOf(value);
	const header = optionalString(record.header);
	const hosts = optionalStringList(record.hosts);
	const injectedValue = rawString(record.value);
	if (!header || !hosts?.length || !injectedValue) return null;
	return {
		header,
		hosts,
		secretRef: optionalString(record.secretRef) ?? null,
		value: injectedValue,
	};
}

function injectedHeaderListParam(value: unknown): WorkstationInjectedHeader[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(injectedHeaderParam)
		.filter((entry): entry is WorkstationInjectedHeader => Boolean(entry));
}

function headerInjectionFailureParam(
	value: unknown,
): WorkstationHeaderInjectionFailure | null {
	const record = recordOf(value);
	const header = optionalString(record.header);
	const hosts = optionalStringList(record.hosts);
	const reason = optionalString(record.reason);
	if (
		!header ||
		!hosts?.length ||
		(reason !== "missing_secret" && reason !== "invalid_header_value")
	) {
		return null;
	}
	return {
		header,
		hosts,
		reason,
		secretRef: optionalString(record.secretRef) ?? null,
	};
}

function headerInjectionFailureListParam(
	value: unknown,
): WorkstationHeaderInjectionFailure[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(headerInjectionFailureParam)
		.filter((entry): entry is WorkstationHeaderInjectionFailure =>
			Boolean(entry),
		);
}

function routePortsParam(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ports = value.filter(
		(entry): entry is number =>
			Number.isInteger(entry) && entry >= 1 && entry <= 65535,
	);
	return ports.length > 0 ? ports : undefined;
}

function proxyRouteParam(value: unknown): WorkstationProxyEgressRoute | null {
	const record = recordOf(value);
	const hosts = optionalStringList(record.hosts);
	const id = optionalString(record.id);
	const ports = routePortsParam(record.ports);
	const proxyRef = optionalString(record.proxyRef);
	const credentialProvider = optionalString(record.credentialProvider);
	const artifactsRepositoryPath = optionalString(
		record.artifactsRepositoryPath,
	);
	if (credentialProvider === "artifacts_token") {
		if (
			id !== "artifacts-git-transport" ||
			proxyRef !== "workstation-egress-proxy" ||
			hosts?.length !== 1 ||
			!/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(hosts[0] ?? "") ||
			!artifactsRepositoryPath ||
			!/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(
				artifactsRepositoryPath,
			) ||
			!ports?.includes(443) ||
			ports.length !== 1
		)
			return null;
		return {
			credentialProvider,
			artifactsRepositoryPath,
			hosts,
			id,
			mode: "forward",
			ports,
			proxyRef,
		};
	}
	const githubRepository = optionalString(record.githubRepository);
	const githubRepositoryId = optionalPositiveSafeInteger(
		record.githubRepositoryId,
	);
	const githubInstallationId = optionalPositiveSafeInteger(
		record.githubInstallationId,
	);
	if (
		!hosts?.length ||
		!id ||
		proxyRef !== "workstation-egress-proxy" ||
		credentialProvider !== "github_app" ||
		!githubRepository ||
		!githubRepositoryId ||
		!githubInstallationId ||
		!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepository)
	)
		return null;
	return {
		credentialProvider: "github_app",
		githubRepository,
		githubRepositoryId,
		githubInstallationId,
		hosts,
		id,
		mode: "forward",
		...(ports ? { ports } : {}),
		proxyRef,
	};
}

function proxyRouteListParam(value: unknown): WorkstationProxyEgressRoute[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(proxyRouteParam)
		.filter((entry): entry is WorkstationProxyEgressRoute => Boolean(entry));
}

function egressParams(value: unknown): WorkstationEgressEventParams {
	const record = recordOf(value);
	const hasLegacyHostPolicy =
		Object.hasOwn(record, "allowedHosts") ||
		Object.hasOwn(record, "deniedHosts");
	return {
		allowedHosts: stringListParam(record, "tedixAllowedHosts"),
		attemptId: optionalString(record.attemptId),
		deniedHosts: stringListParam(record, "tedixDeniedHosts"),
		...(hasLegacyHostPolicy
			? { invalidPolicyReason: "legacy_host_policy_params" as const }
			: {}),
		headerInjectionFailures: [
			...headerInjectionFailureListParam(record.tedixHeaderInjectionFailures),
		],
		injectedHeaders: [...injectedHeaderListParam(record.tedixInjectedHeaders)],
		kernelRunId: optionalString(record.kernelRunId),
		leaseId: optionalString(record.leaseId),
		loggingMode: loggingModeParam(record.tedixEgressLoggingMode),
		organizationId: optionalString(record.organizationId),
		profileId: optionalString(record.profileId),
		tediId: optionalString(record.tediId),
		traceBundleId: optionalString(record.traceBundleId),
		traceId: optionalString(record.traceId),
		workstationId: optionalString(record.workstationId),
		workItemId: optionalString(record.workItemId),
		proxyRequiredHosts: stringListParam(record, "tedixProxyRequiredHosts"),
		proxyRoutes: proxyRouteListParam(record.tedixProxyRoutes),
	};
}

function requestScopedEgressParams(
	request: Request,
	value: unknown,
): WorkstationEgressEventParams {
	const params = egressParams(value);
	return {
		...params,
		traceId:
			optionalString(request.headers.get(WORKSTATION_EGRESS_TRACE_HEADER)) ??
			params.traceId,
	};
}

function egressEventPayload(
	decision: EgressDecision,
	ctx: WorkstationEgressContext,
	params: WorkstationEgressEventParams,
): Record<string, unknown> {
	const injectedHeaders =
		decision.decision === "allow"
			? matchedInjectedHeaders(decision.host, params).map((rule) => ({
					header: rule.header,
					secretRef: optionalString(rule.secretRef) ?? null,
				}))
			: [];
	const blockedHeaderInjections =
		decision.decision === "deny"
			? (params.headerInjectionFailures ?? [])
					.filter((rule) => hostMatches(rule.hosts, decision.host))
					.map((rule) => ({
						header: rule.header,
						reason: rule.reason,
						secretRef: optionalString(rule.secretRef) ?? null,
					}))
			: [];
	return {
		adapter: "cloudflare-sandbox-workstation",
		...(blockedHeaderInjections.length > 0 ? { blockedHeaderInjections } : {}),
		className: ctx.className,
		containerId: ctx.containerId,
		decision: decision.decision,
		...(decision.route
			? {
					egressRoute: {
						id: decision.route.id,
						ref: decision.route.ref,
						type: decision.route.type,
					},
				}
			: {}),
		host: decision.host,
		...(decision.brokerError ? { brokerError: decision.brokerError } : {}),
		...(decision.brokerStatus ? { brokerStatus: decision.brokerStatus } : {}),
		...(injectedHeaders.length > 0 ? { injectedHeaders } : {}),
		kernelRunId: optionalString(params.kernelRunId) ?? null,
		leaseId: optionalString(params.leaseId) ?? null,
		loggingMode: params.loggingMode ?? "all",
		method: decision.method,
		profileId: optionalString(params.profileId) ?? null,
		protocol: decision.protocol,
		reason: decision.reason,
		...(decision.injectedHeaderCount
			? { injectedHeaderCount: decision.injectedHeaderCount }
			: {}),
		traceBundleId: optionalString(params.traceBundleId) ?? null,
		traceId: optionalString(params.traceId) ?? null,
		workstationId: optionalString(params.workstationId) ?? null,
		workItemId: optionalString(params.workItemId) ?? null,
	};
}

function requestWithInjectedHeaders(
	request: Request,
	host: string,
	params: WorkstationEgressEventParams,
): Request {
	const rules = matchedInjectedHeaders(host, params);
	if (rules.length === 0) return request;
	const headers = new Headers(request.headers);
	for (const rule of rules) {
		headers.set(rule.header, rule.value);
	}
	return new Request(request, { headers });
}

function routeBrokerForRef(
	env: WorkstationEgressEnv | undefined,
	route: MatchedEgressRoute | undefined,
): WorkstationRouteBroker | null {
	if (!env || !route) return null;
	const bindingName =
		PROXY_ROUTE_BROKER_BINDINGS[
			route.ref as keyof typeof PROXY_ROUTE_BROKER_BINDINGS
		];
	if (!bindingName) return null;
	return env[bindingName] ?? null;
}

function routeForDecision(
	params: WorkstationEgressEventParams,
	decision: EgressDecision,
): WorkstationProxyEgressRoute | null {
	if (!decision.route) return null;
	return (
		params.proxyRoutes?.find(
			(route) =>
				route.id === decision.route?.id &&
				route.proxyRef === decision.route.ref,
		) ?? null
	);
}

function requestForRouteBroker(
	request: Request,
	decision: EgressDecision,
	params: WorkstationEgressEventParams,
): Request {
	if (!decision.route) return request;
	const headers = new Headers(request.headers);
	for (const name of [...headers.keys()]) {
		if (name.toLowerCase().startsWith("x-tedix-workstation-egress-"))
			headers.delete(name);
	}
	headers.set("X-Tedix-Workstation-Egress-Route-Id", decision.route.id);
	headers.set("X-Tedix-Workstation-Egress-Route-Ref", decision.route.ref);
	headers.set("X-Tedix-Workstation-Egress-Route-Type", decision.route.type);
	const route = routeForDecision(params, decision);
	if (route) {
		headers.set(
			"X-Tedix-Workstation-Egress-Credential-Provider",
			route.credentialProvider,
		);
		if (
			route.credentialProvider === "artifacts_token" &&
			route.artifactsRepositoryPath
		) {
			headers.set(
				"X-Tedix-Workstation-Egress-Artifacts-Repository-Path",
				route.artifactsRepositoryPath,
			);
		} else if (
			route.credentialProvider === "github_app" &&
			route.githubRepository &&
			route.githubRepositoryId &&
			route.githubInstallationId
		) {
			headers.set(
				"X-Tedix-Workstation-Egress-GitHub-Repository",
				route.githubRepository,
			);
			headers.set(
				"X-Tedix-Workstation-Egress-GitHub-Repository-Id",
				String(route.githubRepositoryId),
			);
			headers.set(
				"X-Tedix-Workstation-Egress-GitHub-Installation-Id",
				String(route.githubInstallationId),
			);
		}
	}
	for (const [header, value] of [
		["X-Tedix-Workstation-Egress-Attempt-Id", params.attemptId],
		["X-Tedix-Workstation-Egress-Organization-Id", params.organizationId],
		["X-Tedix-Workstation-Egress-Tedi-Id", params.tediId],
		["X-Tedix-Workstation-Egress-Lease-Id", params.leaseId],
		["X-Tedix-Workstation-Egress-Workstation-Id", params.workstationId],
		["X-Tedix-Workstation-Egress-Work-Item-Id", params.workItemId],
	] as const) {
		const normalized = optionalString(value);
		if (normalized) headers.set(header, normalized);
	}
	if (
		route &&
		"hosts" in route &&
		Array.isArray(route.hosts) &&
		route.hosts.length > 0
	) {
		headers.set(
			"X-Tedix-Workstation-Egress-Route-Hosts",
			JSON.stringify(route.hosts),
		);
	}
	if (
		route &&
		"ports" in route &&
		Array.isArray(route.ports) &&
		route.ports.length > 0
	) {
		headers.set(
			"X-Tedix-Workstation-Egress-Route-Ports",
			JSON.stringify(route.ports),
		);
	}
	return new Request(request, { headers, redirect: "manual" });
}

type UpstreamFailure = {
	upstreamStatus: number;
	authorizationHeaderPresent: boolean;
	responseHeaders: Record<string, string>;
};

function upstreamFailure(
	response: Response,
	request: Request,
): UpstreamFailure {
	const responseHeaders: Record<string, string> = {};
	const retry = response.headers.get("retry-after");
	if (
		retry &&
		(/^\d{1,6}$/.test(retry) ||
			(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
				retry,
			) &&
				new Date(retry).toUTCString() === retry))
	)
		responseHeaders["retry-after"] = retry;
	const server = response.headers.get("server")?.toLowerCase();
	if (server === "github.com" || server === "cloudflare")
		responseHeaders.server = server;
	const githubId = response.headers.get("x-github-request-id");
	if (githubId && /^[0-9A-F]{4,8}(?::[0-9A-F]{4,12}){3,5}$/i.test(githubId))
		responseHeaders["x-github-request-id"] = githubId;
	const ray = response.headers.get("cf-ray");
	if (ray && /^[0-9a-f]{16}-[A-Z]{3}$/i.test(ray))
		responseHeaders["cf-ray"] = ray;
	for (const name of [
		"x-ratelimit-limit",
		"x-ratelimit-remaining",
		"x-ratelimit-reset",
	]) {
		const value = response.headers.get(name);
		if (value && /^\d{1,12}$/.test(value)) responseHeaders[name] = value;
	}
	return {
		upstreamStatus: response.status,
		authorizationHeaderPresent: request.headers.has("authorization"),
		responseHeaders,
	};
}

function observeUpstreamFailure(
	response: Response,
	request: Request,
	decision: EgressDecision,
	env: WorkstationEgressEnv | undefined,
	ctx: WorkstationEgressContext | undefined,
	params: WorkstationEgressEventParams,
): void {
	if (response.status < 400) return;
	const failure = upstreamFailure(response, request);
	const correlation: Record<string, string> = {};
	for (const key of [
		"leaseId",
		"tediId",
		"kernelRunId",
		"traceId",
		"workstationId",
		"workItemId",
	] as const) {
		const value = params[key];
		if (typeof value === "string" && /^[A-Za-z0-9_:.-]{1,256}$/.test(value))
			correlation[key] = value;
	}
	// An allowed request can receive a failed response. This is an observation,
	// not a policy denial, and must remain visible under deny_only logging.
	console.warn("[workstation-egress] upstream_response_failed", {
		decision: "allow",
		host: decision.host,
		method: decision.method,
		...correlation,
		...failure,
	});
	trackAuditWrite(
		recordEgressDecisionFailSoft(decision, env, ctx, params, failure),
	);
}

async function recordEgressDecision(
	decision: EgressDecision,
	env: WorkstationEgressEnv | undefined,
	ctx: WorkstationEgressContext | undefined,
	params: WorkstationEgressEventParams,
	failure?: UpstreamFailure,
): Promise<void> {
	if (!env?.API_SERVICE || !ctx) return;

	if (!failure && !shouldLogDecision(decision, params.loggingMode ?? "all"))
		return;
	const tediId =
		optionalString(params.tediId) ?? optionalString(ctx.containerId);
	const organizationId = optionalString(params.organizationId);
	if (!tediId || !organizationId) return;

	const workstationId =
		optionalString(params.workstationId) ?? optionalString(ctx.containerId);
	const kernelRunId = optionalString(params.kernelRunId);
	const traceBundleId = optionalString(params.traceBundleId);
	const traceId = optionalString(params.traceId);
	// 10s bound: the write is detached from the egress hot path (see
	// trackAuditWrite), so this only guards a hung service binding. A tight
	// inline bound is routinely exceeded by baseline service-binding latency
	// and aborts audit writes.
	await callRpc(
		"cognitiveRuntime/recordEvent",
		{
			id: crypto.randomUUID(),
			kind: `workstation.egress.${decision.decision}`,
			payload: {
				...egressEventPayload(decision, ctx, params),
				...(failure ? { outcome: "upstream_failed", ...failure } : {}),
			},
			...(kernelRunId ? { runId: kernelRunId } : {}),
			runtime: {
				backend: "custom",
				externalId: workstationId,
				metadata: {
					adapter: "cloudflare-sandbox-workstation",
					environment: optionalString(env.ENVIRONMENT) ?? null,
					eventShapeVersion: WORKSTATION_RUNTIME_EVENT_SHAPE_VERSION,
					kernelRunId: kernelRunId ?? null,
					profileId: optionalString(params.profileId) ?? null,
					traceBundleId: traceBundleId ?? null,
					traceId: traceId ?? null,
					workstationId,
				},
			},
			tediId,
		},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: {
				Accept: "application/json",
				"X-Service-Binding": "true",
				"X-Tedix-Caller": "tedi-workstation-runtime",
				"X-Tedix-Org-Id": organizationId,
				"X-Tedix-Tedi-Id": tediId,
			},
			timeoutMs: 10_000,
		},
	);
}

async function recordEgressDecisionFailSoft(
	decision: EgressDecision,
	env: WorkstationEgressEnv | undefined,
	ctx: WorkstationEgressContext | undefined,
	params: WorkstationEgressEventParams,
	failure?: UpstreamFailure,
): Promise<void> {
	try {
		await recordEgressDecision(decision, env, ctx, params, failure);
	} catch (error) {
		console.warn(`${EGRESS_LOG_PREFIX} durable_event=failed`, {
			decision: decision.decision,
			host: decision.host,
			reason: decision.reason,
			exception: exceptionTopology(error),
		});
	}
}

// ── Detached audit writes ─────────────────────────────────────────────────────
// The durable egress audit write must not sit on the egress hot path: awaiting
// it made every container outbound request pay the service-binding round-trip
// (up to the timeout) before its response returned. The Sandbox runs in a
// Durable Object, where detached promises keep running after the request
// settles (no ExecutionContext.waitUntil is exposed by the SDK's outbound
// hook), so the write is tracked-and-detached. Audit stays best-effort by
// design — an eviction mid-write loses at most the in-flight events, the same
// contract the old inline fail-soft had.
const pendingAuditWrites = new Set<Promise<void>>();

function trackAuditWrite(write: Promise<void>): void {
	pendingAuditWrites.add(write);
	// recordEgressDecisionFailSoft never rejects; settle-cleanup only.
	void write.finally(() => pendingAuditWrites.delete(write));
}

/** Await all in-flight egress audit writes (tests; graceful drain points). */
/** @internal */
export async function flushEgressAuditWrites(): Promise<void> {
	await Promise.all(pendingAuditWrites);
}

/**
 * SSRF guard for the catch-all outbound handler.
 *
 * Returns a 403 `Response` when the destination is a private/loopback/
 * link-local address, a cloud metadata endpoint, or an internal Tedix
 * service, otherwise `null` (the caller forwards the request). Workstation
 * containers may legitimately speak plain HTTP to allow-listed origins, so
 * `allowHttp` is enabled — the private-range, metadata, and internal-host
 * checks still run for both protocols.
 *
 * Every decision emits a structured `[workstation-egress]` log line. The
 * container outbound handler also records a durable runtime event when it has
 * API service-binding context.
 * @internal
 */
export function validateOutboundRequest(request: Request): Response | null {
	const decision = egressDecisionForRequest(request);
	logDecision(decision);
	return decision.decision === "deny" ? blockedResponse(decision) : null;
}

/**
 * Catch-all outbound handler. Every intercepted outbound request lands here,
 * is host-policy and SSRF validated, then forwarded to the real internet via
 * the Worker's own `fetch` (the container itself has no internet route when
 * `enableInternet = false`).
 */
export async function outboundEgressHandler(
	request: Request,
	env?: WorkstationEgressEnv,
	ctx?: WorkstationEgressContext,
): Promise<Response> {
	const params = requestScopedEgressParams(request, ctx?.params);
	const decision = egressDecisionForRequest(request, params, {
		routeBrokerAvailable: (route) => routeBrokerForRef(env, route) !== null,
	});
	const forwarded = requestWithInjectedHeaders(request, decision.host, params);
	const loggingMode = params.loggingMode ?? "all";
	if (decision.decision === "deny" || !decision.route) {
		logDecision(decision, loggingMode);
		trackAuditWrite(recordEgressDecisionFailSoft(decision, env, ctx, params));
		if (decision.decision === "deny") return blockedResponse(decision);
		const response = await fetch(forwarded);
		observeUpstreamFailure(response, forwarded, decision, env, ctx, params);
		return response;
	}
	const broker = routeBrokerForRef(env, decision.route);
	if (!broker) {
		const unavailableDecision = brokerResultDecision(decision, {
			kind: "deny",
			reason: "route_broker_unavailable",
		});
		logDecision(unavailableDecision, loggingMode);
		trackAuditWrite(
			recordEgressDecisionFailSoft(unavailableDecision, env, ctx, params),
		);
		return blockedResponse(unavailableDecision);
	}
	try {
		const response = await broker.fetch(
			requestForRouteBroker(forwarded, decision, params),
		);
		const brokerDecision = brokerResultDecision(
			decision,
			response.status >= 400
				? {
						kind: "deny",
						reason: routeBrokerStatusReason(response.status),
						status: response.status,
					}
				: { kind: "allow", status: response.status },
		);
		logDecision(brokerDecision, loggingMode);
		trackAuditWrite(
			recordEgressDecisionFailSoft(brokerDecision, env, ctx, params),
		);
		return response;
	} catch (error) {
		const exception = exceptionTopology(error);
		console.warn(`${EGRESS_LOG_PREFIX} route_broker=failed`, {
			route: decision.route,
			exception,
		});
		const failedDecision = brokerResultDecision(decision, {
			error: exception.type,
			kind: "deny",
			reason: "route_broker_failed",
		});
		logDecision(failedDecision, loggingMode);
		trackAuditWrite(
			recordEgressDecisionFailSoft(failedDecision, env, ctx, params),
		);
		return new Response("Egress route failed", { status: 502 });
	}
}
