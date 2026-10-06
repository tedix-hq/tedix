import type {
	McpGatewayDetection,
	McpGatewayRulePlan,
	McpNetworkControlConfig,
} from "@tedix/api-contract/schemas/mcp-network-security";

export interface ApprovedMcpDestination {
	appSlug: string;
	url: string;
}

function normalizedEndpoint(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
			return null;
		const path = parsed.pathname.replace(/\/+$/, "") || "/";
		return `${parsed.origin.toLowerCase()}${path}`;
	} catch {
		return null;
	}
}

function destinationOrigin(url: string): string {
	const parsed = new URL(url);
	return parsed.origin.toLowerCase();
}

function destinationHostname(url: string): string {
	return new URL(url).hostname.toLowerCase();
}

function endpointMatches(detectionUrl: string, approvedUrl: string): boolean {
	const detection = normalizedEndpoint(detectionUrl);
	const approved = normalizedEndpoint(approvedUrl);
	if (!detection || !approved) return false;
	return detection === approved || detection.startsWith(`${approved}/`);
}

function activeExceptionHostnames(
	config: McpNetworkControlConfig,
	now: Date,
): Set<string> {
	return new Set(
		config.directAccessExceptions
			.filter(
				(exception) =>
					!exception.expiresAt ||
					new Date(exception.expiresAt).getTime() > now.getTime(),
			)
			.map((exception) => exception.hostname.toLowerCase()),
	);
}

export function buildMcpPortalOnlyRulePlan(
	organizationId: string,
	config: McpNetworkControlConfig,
	now = new Date(),
): McpGatewayRulePlan {
	const exceptions = [...activeExceptionHostnames(config, now)].sort();
	const exceptionClause =
		exceptions.length === 0
			? ""
			: ` and not(http.request.host in {${exceptions.map((host) => `\"${host}\"`).join(" ")}})`;
	return {
		name: `Tedix MCP portal-only - ${organizationId}`,
		action: "block",
		filters: ["http"],
		traffic: `experimental.is_mcp == true and net.onramp.type != "mcp_portal"${exceptionClause}`,
		enabled: config.mode === "portal_only",
	};
}

export function reconcileMcpGatewayDetections(input: {
	organizationId: string;
	config: McpNetworkControlConfig;
	detections: McpGatewayDetection[];
	approvedDestinations: ApprovedMcpDestination[];
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const portalHosts = new Set(
		input.config.portalHostnames.map((hostname) => hostname.toLowerCase()),
	);
	const exceptionHosts = activeExceptionHostnames(input.config, now);
	const findings = input.detections.map((detection) => {
		const hostname = destinationHostname(detection.destinationUrl);
		const approvedAppSlugs = [
			...new Set(
				input.approvedDestinations
					.filter((approved) =>
						endpointMatches(detection.destinationUrl, approved.url),
					)
					.map((approved) => approved.appSlug),
			),
		].sort();
		const isConfiguredPortal =
			detection.trafficSource === "mcp_portal" && portalHosts.has(hostname);
		const isException = exceptionHosts.has(hostname);
		const approved = approvedAppSlugs.length > 0;

		const classification = isConfiguredPortal
			? ("approved_portal_route" as const)
			: isException
				? ("approved_exception" as const)
				: approved && input.config.mode === "portal_only"
					? ("approved_server_portal_bypass" as const)
					: approved
						? ("approved_server_direct" as const)
						: ("unknown_server" as const);
		const disposition =
			classification === "approved_portal_route" ||
			classification === "approved_exception"
				? ("allow" as const)
				: input.config.mode === "portal_only"
					? ("block" as const)
					: ("observe" as const);

		return {
			requestId: detection.requestId,
			observedAt: detection.observedAt,
			destinationOrigin: destinationOrigin(detection.destinationUrl),
			trafficSource: detection.trafficSource,
			classification,
			disposition,
			approvedAppSlugs,
		};
	});
	const count = (classification: (typeof findings)[number]["classification"]) =>
		findings.filter((finding) => finding.classification === classification)
			.length;
	return {
		mode: input.config.mode,
		approvedDestinationCount: new Set(
			input.approvedDestinations.map((destination) =>
				normalizedEndpoint(destination.url),
			),
		).size,
		counts: {
			approvedPortalRoute: count("approved_portal_route"),
			approvedServerDirect: count("approved_server_direct"),
			approvedServerPortalBypass: count("approved_server_portal_bypass"),
			approvedException: count("approved_exception"),
			unknownServer: count("unknown_server"),
		},
		findings,
		enforcementPlan: buildMcpPortalOnlyRulePlan(
			input.organizationId,
			input.config,
			now,
		),
	};
}

interface CloudflareRule {
	id: string;
	name: string;
}

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
	errors?: Array<{ message?: string }>;
}

async function cloudflareRequest<T>(input: {
	accountId: string;
	token: string;
	path: string;
	method: "GET" | "POST" | "PUT";
	body?: unknown;
	fetchImpl?: typeof fetch;
}): Promise<T> {
	const response = await (input.fetchImpl ?? fetch)(
		`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(input.accountId)}/gateway/rules${input.path}`,
		{
			method: input.method,
			headers: {
				Authorization: `Bearer ${input.token}`,
				"Content-Type": "application/json",
			},
			...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
		},
	);
	const envelope = (await response.json()) as CloudflareEnvelope<T>;
	if (!response.ok || !envelope.success) {
		const detail = envelope.errors
			?.map((error) => error.message)
			.filter(Boolean)
			.join("; ");
		throw new Error(
			`Cloudflare Gateway rule request failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return envelope.result;
}

export async function applyMcpPortalOnlyRule(input: {
	accountId: string;
	token: string;
	plan: McpGatewayRulePlan;
	fetchImpl?: typeof fetch;
}): Promise<{ created: boolean; ruleId: string }> {
	const rules = await cloudflareRequest<CloudflareRule[]>({
		accountId: input.accountId,
		token: input.token,
		path: "",
		method: "GET",
		fetchImpl: input.fetchImpl,
	});
	const existing = rules.find((rule) => rule.name === input.plan.name);
	const result = await cloudflareRequest<CloudflareRule>({
		accountId: input.accountId,
		token: input.token,
		path: existing ? `/${encodeURIComponent(existing.id)}` : "",
		method: existing ? "PUT" : "POST",
		body: {
			...input.plan,
			description:
				"Tedix-managed defense-in-depth rule. Tedix D1 identity, scopes, approvals, policy, and audit remain authoritative.",
		},
		fetchImpl: input.fetchImpl,
	});
	return { created: !existing, ruleId: result.id };
}
