import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { validateUrl } from "@tedix/ssrf-guard";
import {
	installationTokenForRepository,
	revokeCachedInstallationTokens,
	type GitHubAppEnv,
} from "./github-app";
import { exceptionTopology } from "./exception-topology";

const BROKER_SERVICE = "tedi-workstation-egress-broker";
const INTERNAL_HEADER_PREFIX = "x-tedix-workstation-egress-";
const ROUTE_TYPE_HEADER = "x-tedix-workstation-egress-route-type";
const ROUTE_ID_HEADER = "x-tedix-workstation-egress-route-id";
const ROUTE_REF_HEADER = "x-tedix-workstation-egress-route-ref";
const ROUTE_HOSTS_HEADER = "x-tedix-workstation-egress-route-hosts";
const ROUTE_PORTS_HEADER = "x-tedix-workstation-egress-route-ports";
const CREDENTIAL_PROVIDER_HEADER =
	"x-tedix-workstation-egress-credential-provider";
const GITHUB_REPOSITORY_HEADER = "x-tedix-workstation-egress-github-repository";
const GITHUB_REPOSITORY_ID_HEADER =
	"x-tedix-workstation-egress-github-repository-id";
const GITHUB_INSTALLATION_ID_HEADER =
	"x-tedix-workstation-egress-github-installation-id";
const ARTIFACTS_REPOSITORY_PATH_HEADER =
	"x-tedix-workstation-egress-artifacts-repository-path";
const ORGANIZATION_ID_HEADER = "x-tedix-workstation-egress-organization-id";
const TEDI_ID_HEADER = "x-tedix-workstation-egress-tedi-id";
const LEASE_ID_HEADER = "x-tedix-workstation-egress-lease-id";
const WORKSTATION_ID_HEADER = "x-tedix-workstation-egress-workstation-id";
const WORK_ITEM_ID_HEADER = "x-tedix-workstation-egress-work-item-id";
const ATTEMPT_ID_HEADER = "x-tedix-workstation-egress-attempt-id";

type BrokerEnv = GitHubAppEnv & {
	API_SERVICE?: { fetch(request: Request): Promise<Response> };
	TEDI_SERVICE?: { fetch(request: Request): Promise<Response> };
	GIT_SHA?: string;
};

const DENIED_METHODS = new Set(["CONNECT", "TRACE"]);
const MAX_GIT_V2_ADVERTISEMENT_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

const MINT_FAILURE_CODES = new Set([
	"github_repository_invalid",
	"github_app_unconfigured",
	"github_app_private_key_invalid",
	"github_app_token_invalid",
	"github_app_disabled",
	"github_app_scope_invalid",
	"github_app_installation_invalid",
]);

function mintFailureReason(error: unknown): string {
	let message: unknown;
	try {
		message =
			error instanceof Error
				? Object.getOwnPropertyDescriptor(error, "message")?.value
				: undefined;
	} catch {
		return "github_app_mint_failed";
	}
	return typeof message === "string" &&
		(MINT_FAILURE_CODES.has(message) ||
			/^github_app_upstream_[1-5]\d{2}$/.test(message))
		? message
		: "github_app_mint_failed";
}

export function brokerHealth(gitSha: string | undefined) {
	return {
		deployedSha: gitSha ?? "unknown",
		service: BROKER_SERVICE,
		status: "ok",
	};
}

function routeTypeFrom(request: Request): "proxy" | null {
	const rawType = request.headers.get(ROUTE_TYPE_HEADER)?.trim().toLowerCase();
	return rawType === "proxy" ? rawType : null;
}

function routeEvidence(request: Request): Record<string, string | null> {
	return {
		routeId: request.headers.get(ROUTE_ID_HEADER),
		routeRef: request.headers.get(ROUTE_REF_HEADER),
		routeType: request.headers.get(ROUTE_TYPE_HEADER),
	};
}

function hostMatches(pattern: string, host: string): boolean {
	const lowerPattern = pattern.toLowerCase();
	if (lowerPattern === host) return true;
	if (!lowerPattern.startsWith("*.")) return false;
	const suffix = lowerPattern.slice(1);
	return host.endsWith(suffix) && host.length > suffix.length;
}

function portOf(url: URL): number {
	if (url.port) return Number(url.port);
	return url.protocol === "http:" ? 80 : 443;
}

function parseRouteHosts(request: Request): string[] {
	const raw = request.headers.get(ROUTE_HOSTS_HEADER);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(h): h is string => typeof h === "string" && h.length > 0,
		);
	} catch {
		return [];
	}
}

function parseRoutePorts(request: Request): number[] | null {
	const raw = request.headers.get(ROUTE_PORTS_HEADER);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const ports = parsed.filter(
			(p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535,
		);
		return ports.length > 0 ? ports : null;
	} catch {
		return null;
	}
}

function jsonResponse(
	status: number,
	code: string,
	request: Request,
	extra: Record<string, unknown> = {},
): Response {
	return Response.json(
		{
			ok: false,
			code,
			service: BROKER_SERVICE,
			...routeEvidence(request),
			...extra,
		},
		{ status },
	);
}

function publicProxyRequest(request: Request): Request {
	const headers = new Headers(request.headers);
	for (const header of [...headers.keys()]) {
		const lower = header.toLowerCase();
		if (lower.startsWith(INTERNAL_HEADER_PREFIX)) {
			headers.delete(header);
			continue;
		}
		if (HOP_BY_HOP_HEADERS.has(lower)) headers.delete(header);
	}
	return new Request(request, { headers, redirect: "manual" });
}

function requiredHeader(request: Request, name: string): string | null {
	const value = request.headers.get(name)?.trim();
	return value && /^[A-Za-z0-9_:.\/-]{1,256}$/.test(value) ? value : null;
}

function requiredPositiveIntegerHeader(
	request: Request,
	name: string,
): number | null {
	const raw = request.headers.get(name)?.trim();
	if (!raw || !/^\d+$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function githubRepositoryForRequest(request: Request): string | null {
	if (request.headers.get(CREDENTIAL_PROVIDER_HEADER) !== "github_app") {
		return null;
	}
	const repository = requiredHeader(request, GITHUB_REPOSITORY_HEADER);
	return repository && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)
		? repository
		: null;
}

function githubRequestMatchesRepository(
	request: Request,
	url: URL,
	repository: string,
): boolean {
	const routeId = request.headers.get(ROUTE_ID_HEADER);
	if (url.hostname === "api.github.com") {
		const expected = `/repos/${repository}`.toLowerCase();
		return (
			routeId === "github-api-transport" &&
			request.method === "GET" &&
			url.pathname.toLowerCase() === expected &&
			!url.search
		);
	}
	if (url.hostname !== "github.com" || routeId !== "github-git-transport") {
		return false;
	}
	const repositoryPath = `/${repository}`.toLowerCase();
	const path = url.pathname.toLowerCase();
	return [repositoryPath, `${repositoryPath}.git`].some(
		(expected) => path === expected || path.startsWith(`${expected}/`),
	);
}

function artifactsGitRequestMatchesRepository(
	request: Request,
	url: URL,
): boolean {
	const repositoryPath = requiredHeader(
		request,
		ARTIFACTS_REPOSITORY_PATH_HEADER,
	);
	if (
		request.headers.get(ROUTE_ID_HEADER) !== "artifacts-git-transport" ||
		!repositoryPath ||
		!/^\/git\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.git$/.test(
			repositoryPath,
		) ||
		!/^[a-f0-9]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname) ||
		url.protocol !== "https:" ||
		portOf(url) !== 443 ||
		url.hash ||
		url.username ||
		url.password
	)
		return false;
	if (request.method === "GET") {
		return (
			url.pathname === `${repositoryPath}/info/refs` &&
			(url.search === "?service=git-upload-pack" ||
				url.search === "?service=git-receive-pack")
		);
	}
	if (request.method === "POST" && !url.search) {
		return (
			url.pathname === `${repositoryPath}/git-upload-pack` ||
			url.pathname === `${repositoryPath}/git-receive-pack`
		);
	}
	return false;
}

function gitTransportAuditMetadata(request: Request, response: Response) {
	const path = new URL(request.url).pathname.toLowerCase();
	const pathClass = path.endsWith("/info/refs")
		? "info_refs"
		: path.endsWith("/git-upload-pack")
			? "upload_pack"
			: path.endsWith("/git-receive-pack")
				? "receive_pack"
				: "other";
	const mime = response.headers
		.get("content-type")
		?.split(";", 1)[0]
		?.trim()
		.toLowerCase();
	const contentType = [
		"application/x-git-upload-pack-advertisement",
		"application/x-git-upload-pack-result",
		"application/x-git-receive-pack-advertisement",
		"application/x-git-receive-pack-result",
		"text/html",
		"application/json",
	].includes(mime ?? "")
		? mime
		: mime
			? "other"
			: "missing";
	const length = response.headers.get("content-length");
	const contentLength =
		length && /^\d{1,12}$/.test(length) ? Number(length) : null;
	const encoding = response.headers.get("content-encoding")?.toLowerCase();
	return {
		requestMethod:
			request.method === "GET" || request.method === "POST"
				? request.method
				: "other",
		pathClass,
		gitProtocolV2: request.headers.get("git-protocol") === "version=2",
		responseContentType: contentType,
		responseContentLength: contentLength,
		responseContentEncoding: ["gzip", "br", "identity"].includes(encoding ?? "")
			? encoding
			: encoding
				? "other"
				: "missing",
	};
}

function gitPacketLinesComplete(bytes: Uint8Array): boolean {
	let offset = 0;
	let finalFlush = false;
	while (offset + 4 <= bytes.length) {
		const prefix = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		if (!/^[0-9a-fA-F]{4}$/.test(prefix)) return false;
		const packetLength = Number.parseInt(prefix, 16);
		offset += 4;
		if (packetLength === 0) {
			finalFlush = offset === bytes.length;
			continue;
		}
		if (packetLength < 4 || offset + packetLength - 4 > bytes.length)
			return false;
		offset += packetLength - 4;
		finalFlush = false;
	}
	return offset === bytes.length && finalFlush;
}

async function readGitV2Advertisement(response: Response): Promise<{
	bytes: Uint8Array | null;
	length: number;
	framing: "valid" | "invalid" | "too_large" | "read_failed";
}> {
	if (!response.body) return { bytes: null, length: 0, framing: "invalid" };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_GIT_V2_ADVERTISEMENT_BYTES) {
				await reader.cancel();
				return { bytes: null, length, framing: "too_large" };
			}
			chunks.push(next.value);
		}
	} catch {
		return { bytes: null, length, framing: "read_failed" };
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const complete = gitPacketLinesComplete(bytes);
	return {
		bytes: complete ? bytes : null,
		length,
		framing: complete ? "valid" : "invalid",
	};
}

type GitHubRequestContext = {
	attemptId: string;
	installationId: number;
	intent: "fetch" | "probe" | "push";
	leaseId: string;
	organizationId: string;
	repository: string;
	repositoryId: number;
	requestId: string;
	routeId: string;
	tediId: string;
	workItemId: string;
	workstationId: string;
};

function githubContext(
	request: Request,
	url: URL,
): GitHubRequestContext | null {
	const attemptId = requiredHeader(request, ATTEMPT_ID_HEADER);
	const installationId = requiredPositiveIntegerHeader(
		request,
		GITHUB_INSTALLATION_ID_HEADER,
	);
	const leaseId = requiredHeader(request, LEASE_ID_HEADER);
	const organizationId = requiredHeader(request, ORGANIZATION_ID_HEADER);
	const repository = githubRepositoryForRequest(request);
	const repositoryId = requiredPositiveIntegerHeader(
		request,
		GITHUB_REPOSITORY_ID_HEADER,
	);
	const routeId = requiredHeader(request, ROUTE_ID_HEADER);
	const tediId = requiredHeader(request, TEDI_ID_HEADER);
	const workItemId = requiredHeader(request, WORK_ITEM_ID_HEADER);
	const workstationId = requiredHeader(request, WORKSTATION_ID_HEADER);
	if (
		!attemptId ||
		!installationId ||
		!leaseId ||
		!organizationId ||
		!repository ||
		!repositoryId ||
		!routeId ||
		!tediId ||
		!workItemId ||
		!workstationId
	)
		return null;
	const intent =
		url.hostname === "api.github.com"
			? "probe"
			: url.searchParams.get("service") === "git-receive-pack" ||
				  url.pathname.endsWith("/git-receive-pack")
				? "push"
				: "fetch";
	return {
		attemptId,
		installationId,
		intent,
		leaseId,
		organizationId,
		repository,
		repositoryId,
		requestId: crypto.randomUUID(),
		routeId,
		tediId,
		workItemId,
		workstationId,
	};
}

async function recordGitHubAudit(
	env: BrokerEnv,
	context: GitHubRequestContext,
	action: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	if (!env.API_SERVICE) {
		throw new Error("github_app_audit_context_missing");
	}
	await callRpc(
		"audit/createEvent",
		{
			action,
			actorId: context.tediId,
			actorType: "tedi",
			metadata: {
				attemptId: context.attemptId,
				installationId: context.installationId,
				intent: context.intent,
				leaseId: context.leaseId,
				permissions: { contents: "write" },
				repositoryId: context.repositoryId,
				repositoryName: context.repository,
				requestId: context.requestId,
				routeId: context.routeId,
				tokenTtlSeconds: 3600,
				workItemId: context.workItemId,
				workstationId: context.workstationId,
				...metadata,
			},
			organizationId: context.organizationId,
			resourceId: context.repository,
			resourceType: "github_repository",
		},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: {
				Accept: "application/json",
				"X-Service-Binding": "true",
				"X-Tedix-Caller": "tedi-workstation-egress-broker",
				"X-Tedix-Org-Id": context.organizationId,
				"X-Tedix-Tedi-Id": context.tediId,
			},
			timeoutMs: 10_000,
		},
	);
}

async function authorizeGitHubRequest(
	env: BrokerEnv,
	context: GitHubRequestContext,
): Promise<string | null> {
	if (!env.TEDI_SERVICE) return "authority_service_unavailable";
	const response = await env.TEDI_SERVICE.fetch(
		new Request("https://tedi/internal/workstation/github/authorize", {
			body: JSON.stringify(context),
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			method: "POST",
		}),
	);
	const body = (await response.json().catch(() => null)) as {
		authorized?: boolean;
		reason?: string;
	} | null;
	return response.ok && body?.authorized === true
		? null
		: (body?.reason ?? `authority_http_${response.status}`);
}

async function handleProxyRoute(
	request: Request,
	env: BrokerEnv,
): Promise<Response> {
	if (DENIED_METHODS.has(request.method.toUpperCase())) {
		return jsonResponse(405, "method_not_allowed", request);
	}
	if (request.headers.get("upgrade")) {
		return jsonResponse(400, "upgrade_not_allowed", request);
	}

	const ssrfError = validateUrl(request.url);
	if (ssrfError) {
		return jsonResponse(403, "target_blocked", request, { reason: ssrfError });
	}

	const allowedHosts = parseRouteHosts(request);
	if (allowedHosts.length === 0) {
		return jsonResponse(403, "proxy_route_unconfigured", request);
	}

	const url = new URL(request.url);
	const host = url.hostname.toLowerCase();
	if (!allowedHosts.some((pattern) => hostMatches(pattern, host))) {
		return jsonResponse(403, "proxy_route_host_denied", request);
	}

	const allowedPorts = parseRoutePorts(request);
	if (allowedPorts !== null && !allowedPorts.includes(portOf(url))) {
		return jsonResponse(403, "proxy_route_host_denied", request);
	}
	if (request.headers.get(CREDENTIAL_PROVIDER_HEADER) === "artifacts_token") {
		if (!artifactsGitRequestMatchesRepository(request, url)) {
			return jsonResponse(403, "artifacts_repository_scope_mismatch", request);
		}
		try {
			return await fetch(publicProxyRequest(request));
		} catch {
			return jsonResponse(502, "artifacts_upstream_failed", request);
		}
	}

	if (request.headers.get(CREDENTIAL_PROVIDER_HEADER) !== "github_app")
		return jsonResponse(403, "github_app_required", request);
	const github = githubContext(request, url);
	if (!github)
		return jsonResponse(403, "github_authority_correlation_missing", request);

	try {
		const forwarded = publicProxyRequest(request);

		await recordGitHubAudit(
			env,
			github,
			"github.app.installation_token.issuance_requested",
			{ outcome: "requested" },
		);
		const deny = async (reason: string, status = 403): Promise<Response> => {
			await recordGitHubAudit(
				env,
				github,
				"github.app.installation_token.denied",
				{ outcome: "denied", reason },
			);
			return jsonResponse(status, reason, request);
		};
		if (!githubRequestMatchesRepository(request, url, github.repository)) {
			return await deny("github_repository_scope_mismatch");
		}
		if (env.GITHUB_APP_ENABLED !== "true") {
			try {
				await revokeCachedInstallationTokens();
			} catch {
				return await deny("github_app_token_revocation_failed", 503);
			}
			return await deny("github_app_disabled", 503);
		}
		let authorityDenial: string | null;
		try {
			authorityDenial = await authorizeGitHubRequest(env, github);
		} catch {
			authorityDenial = "authority_service_failed";
		}
		if (authorityDenial) return await deny(authorityDenial);
		let installation: Awaited<
			ReturnType<typeof installationTokenForRepository>
		>;
		try {
			installation = await installationTokenForRepository(env, {
				installationId: github.installationId,
				repository: github.repository,
				repositoryId: github.repositoryId,
			});
		} catch (error) {
			const reason = mintFailureReason(error);
			await recordGitHubAudit(
				env,
				github,
				"github.app.installation_token.issuance_outcome",
				{ outcome: "failed", reason, exception: exceptionTopology(error) },
			);
			return await deny(reason, 502);
		}
		await recordGitHubAudit(
			env,
			github,
			"github.app.installation_token.issuance_outcome",
			{
				outcome: "succeeded",
				source: installation.source,
				tokenExpiresAt: new Date(
					installation.value.expiresAt * 1000,
				).toISOString(),
			},
		);
		forwarded.headers.delete("Authorization");
		forwarded.headers.set(
			"Authorization",
			url.hostname === "github.com"
				? `Basic ${btoa(`x-access-token:${installation.value.token}`)}`
				: `Bearer ${installation.value.token}`,
		);
		let upstream: Response;
		try {
			upstream = await fetch(forwarded);
		} catch (error) {
			await recordGitHubAudit(env, github, "github.app.request.outcome", {
				outcome: "network_failure",
				reason: "github_upstream_failed",
				exception: exceptionTopology(error),
			});
			return jsonResponse(502, "github_upstream_failed", request);
		}
		const gitMetadata = gitTransportAuditMetadata(forwarded, upstream);
		const advertisement =
			upstream.ok &&
			gitMetadata.requestMethod === "GET" &&
			gitMetadata.pathClass === "info_refs" &&
			gitMetadata.gitProtocolV2
				? await readGitV2Advertisement(upstream)
				: null;
		const advertisementValid =
			!advertisement ||
			(advertisement.framing === "valid" &&
				gitMetadata.responseContentType ===
					"application/x-git-upload-pack-advertisement");
		await recordGitHubAudit(env, github, "github.app.request.outcome", {
			...gitMetadata,
			...(advertisement
				? {
						advertisementBytes: advertisement.length,
						advertisementFraming: advertisement.framing,
					}
				: {}),
			githubRequestId: upstream.headers.get("x-github-request-id"),
			outcome: !advertisementValid
				? "invalid_advertisement"
				: upstream.ok
					? "succeeded"
					: "upstream_rejected",
			upstreamStatus: upstream.status,
		});
		if (!advertisementValid)
			return jsonResponse(502, "github_git_advertisement_invalid", request);
		if (advertisement?.bytes)
			return new Response(advertisement.bytes, upstream);
		return upstream;
	} catch {
		return jsonResponse(502, "proxy_fetch_failed", request);
	}
}

/** @internal */
export async function handleRequest(
	request: Request,
	env: BrokerEnv,
): Promise<Response> {
	const url = new URL(request.url);
	// authz: public — liveness + deployed-sha probe; serves no tenant data.
	if (url.pathname === "/health") {
		return Response.json(brokerHealth(env.GIT_SHA));
	}

	const routeType = routeTypeFrom(request);
	if (!routeType)
		return jsonResponse(
			400,
			request.headers.has(ROUTE_TYPE_HEADER)
				? "unsupported_route_type"
				: "missing_route_type",
			request,
		);
	return handleProxyRoute(request, env);
}

export default {
	fetch(request: Request, env: BrokerEnv): Promise<Response> {
		return handleRequest(request, env);
	},
};
