import { withBearerToken } from "@tedix/api-client/adapters";
import {
	getApiClient,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import { resolveOsTenant } from "@/shared/os-tenant";
import { withWebMcpInvocationHeader } from "@/lib/webmcp/attribution";

declare const __LOCAL_DEMO_ENABLED__: boolean;

/**
 * On a provisioned tenant host the SPA talks same-origin through the OS
 * worker's `/api/*` proxy (cookies flow, no CORS, EventSource holds), and
 * `apps/api` re-derives the organization from the forwarded credentials —
 * the hostname selects nothing. The zero-account local lane keeps the direct
 * API origin because the Vite dev server has no worker in front of it.
 */
const tenant = resolveOsTenant(window.location.hostname);
/**
 * Zero-account local lane: on a local host in dev the SPA talks to its own
 * origin's `/api`, which the Vite dev middleware answers from contract-
 * validated fixtures — no Cloudflare account, no Descope tenant, no live
 * credentials. `VITE_LIVE_API=1` opts a local dev session back into the real
 * API origin.
 */
const useLocalFixtures =
	tenant.kind === "local" &&
	import.meta.env.DEV &&
	import.meta.env.VITE_LIVE_API !== "1";
const useLocalDemo = tenant.kind === "local" && __LOCAL_DEMO_ENABLED__;
export const OS_API_URL =
	tenant.kind !== "local"
		? `${window.location.origin}${window.location.pathname.startsWith("/cli/login") ? "/cli/api" : "/api"}`
		: useLocalFixtures || useLocalDemo
			? `${window.location.origin}/api`
			: __API_URL__;

/** A route must surface an actionable failure instead of holding a skeleton forever. */
export const OS_API_REQUEST_TIMEOUT_MS = 15_000;
/** Chat mutations are idempotent and persist-first, but may cross a cold OS
 * proxy and API isolate before the API's bounded acknowledgement is emitted. */
export const OS_CHAT_MUTATION_TIMEOUT_MS = 30_000;
/** Run-event reads may include a 10s server long-poll plus connection and
 * serialization overhead. Keep that protocol wait distinct from ordinary UI reads. */
export const OS_CHAT_READ_TIMEOUT_MS = 30_000;
/** Direct MCP reads perform connection verification, live tool discovery, and
 * one bounded provider call in sequence. Keep their transport alive long
 * enough for the API to return its durable success or typed failure receipt. */
export const OS_DIRECT_READ_TIMEOUT_MS = 90_000;
/** The deprovision mutation only starts durable cleanup and returns its receipt.
 * Allow cold API startup without holding the browser for the provider cleanup. */
export const OS_SITE_DEPROVISION_TIMEOUT_MS = 30_000;

/**
 * Same-origin product clients stamp `X-Tedix-Webmcp-Invocation` on requests
 * issued while a native WebMCP tool execute is in flight (see
 * `@/lib/webmcp/attribution`): pure telemetry metadata read per request, no
 * authority. The `/api` proxy's trust-header hygiene forwards it — it is
 * deliberately outside the stripped internal-trust set.
 */
const osProductHeaders = withWebMcpInvocationHeader(
	// Browser credentials remain HttpOnly and travel through same-origin
	// cookies. The zero-account lane intentionally sends no bearer either.
	withBearerToken(() => ""),
);

export const osApi: RouterContractClient<ApiContract> =
	getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_API_REQUEST_TIMEOUT_MS,
		getHeaders: osProductHeaders,
	});

export const osDirectReadApi: RouterContractClient<ApiContract> =
	getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_DIRECT_READ_TIMEOUT_MS,
		getHeaders: osProductHeaders,
	});

export const osSiteDeprovisionApi: RouterContractClient<ApiContract> =
	getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_SITE_DEPROVISION_TIMEOUT_MS,
		getHeaders: osProductHeaders,
	});

export const osChatMutationApi: RouterContractClient<ApiContract> =
	getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_CHAT_MUTATION_TIMEOUT_MS,
		getHeaders: osProductHeaders,
	});

export const osChatReadApi: RouterContractClient<ApiContract> =
	getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_CHAT_READ_TIMEOUT_MS,
		getHeaders: osProductHeaders,
	});

/**
 * Create a short-lived bearer client for explicit step-up operations.
 * Ordinary product reads and writes must use the same-origin `osApi` singleton
 * above.
 *
 * This client goes DIRECTLY to the API origin (`__API_URL__`), not through
 * the same-origin `/api` proxy: the OS worker strips Authorization on the
 * proxy path, and the stepped-up session JWT — the only token carrying
 * `su: true` — must reach the API intact. `*.os.tedix.dev` origins are
 * CORS-allowed by apps/api (apps/api/src/lib/cors-origins.ts).
 *
 * The caller passed an authoritative per-request token. Never replace it
 * with a possibly stale/duplicate cookie credential: construct per call,
 * use only from step-up consumers.
 */
export function getAuthenticatedOsApi(
	token: string,
): RouterContractClient<ApiContract> {
	return getApiClient<ApiContract>(__API_URL__, {
		timeoutMs: OS_API_REQUEST_TIMEOUT_MS,
		getHeaders: withBearerToken(() => token),
	});
}

/**
 * Bootstrap the first organization with the JWT emitted by the central
 * Descope flow before the tenantless user can receive a product session.
 */
export function prepareFirstOsOrganization(sessionJwt?: string) {
	if (!sessionJwt) return osApi.organizations.getMyOrganization({});
	const bootstrapApi = getApiClient<ApiContract>(OS_API_URL, {
		credentials: "include",
		timeoutMs: OS_API_REQUEST_TIMEOUT_MS,
		getHeaders: withBearerToken(() => sessionJwt),
	});
	return bootstrapApi.organizations.getMyOrganization({});
}
