import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sleep as sleepDefault } from "@tedix/worker-kit/sleep";

const DEFAULT_TEDIX_API_URL = "https://api.tedix.dev";

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface PublicCliWorkspace {
	slug: string;
	name: string;
	gatewayUrl: string;
}

function parseWorkspace(value: unknown): PublicCliWorkspace | null {
	const candidate =
		isRecord(value) && isRecord(value.data) ? value.data : value;
	if (!isRecord(candidate)) return null;
	if (
		typeof candidate.slug !== "string" ||
		typeof candidate.name !== "string" ||
		typeof candidate.gatewayUrl !== "string"
	) {
		return null;
	}
	let gateway: URL;
	try {
		gateway = new URL(candidate.gatewayUrl);
	} catch {
		return null;
	}
	if (
		gateway.protocol !== "https:" ||
		gateway.username ||
		gateway.password ||
		gateway.hash ||
		gateway.pathname !== "/mcp"
	) {
		return null;
	}
	return {
		slug: candidate.slug,
		name: candidate.name,
		gatewayUrl: gateway.toString(),
	};
}

// apps/api cold-start on tedix.dev routinely takes 4-7s per fresh isolate and
// occasionally returns a hard 5xx before it warms — a single-shot fetch turns
// that transient into a login-killing "could not resolve organization". Retry
// the transient failures (5xx, network error, timeout) with backoff; never
// retry a 404 (real "org not found") or any other 4xx (a bad slug).
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200] as const;
const ATTEMPT_TIMEOUT_MS = 15_000;

async function fetchWorkspaceWithRetry(
	url: string,
	fetchImpl: FetchLike,
	maxAttempts: number,
	sleep: (ms: number) => Promise<void>,
): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			const backoff =
				BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ??
				BACKOFF_MS[BACKOFF_MS.length - 1] ??
				1200;
			await sleep(backoff);
		}
		const isLast = attempt === maxAttempts - 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
		try {
			const response = await fetchImpl(url, {
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
			// A retryable status on a non-final attempt: try again. Otherwise hand
			// the response back so the caller maps 404 / bad records to a message.
			if (RETRYABLE_STATUS.has(response.status) && !isLast) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			return response;
		} catch (error) {
			// Network error or the per-attempt timeout aborting a hung cold isolate.
			lastError = error;
			if (isLast) throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	// Unreachable: the final attempt either returns or throws above.
	throw lastError ?? new Error("workspace resolution failed");
}

/**
 * Resolve an organization slug before OAuth, without requiring an existing
 * operator login. The endpoint returns only the organization's public MCP
 * resource URL; membership remains enforced by Descope and the gateway.
 *
 * Retries transient upstream failures (see `fetchWorkspaceWithRetry`) so a cold
 * apps/api isolate does not hard-fail a fresh `tedix login`.
 */
export async function resolvePublicCliWorkspace(options: {
	apiUrl?: string;
	fetch?: FetchLike;
	slug: string;
	/** Total attempts including the first (default 3). Set to 1 to disable retry. */
	maxAttempts?: number;
	/** Injectable delay for tests; defaults to real backoff. */
	sleep?: (ms: number) => Promise<void>;
}): Promise<PublicCliWorkspace> {
	const slug = options.slug.trim().toLowerCase();
	if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) {
		throw new Error(
			"Organization slug must use lowercase letters, numbers, and hyphens.",
		);
	}
	const apiUrl = (
		options.apiUrl ??
		process.env.TEDIX_API_URL ??
		DEFAULT_TEDIX_API_URL
	).replace(/\/$/, "");
	const response = await fetchWorkspaceWithRetry(
		`${apiUrl}/v1/organizations/cli-workspace/${encodeURIComponent(slug)}`,
		options.fetch ?? fetch,
		Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
		options.sleep ?? sleepDefault,
	);
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(
				`No provisioned Tedix organization was found for slug "${slug}". Check the slug with your organization administrator.`,
			);
		}
		throw new Error(
			`Tedix could not resolve organization "${slug}" (HTTP ${response.status}). Try again or pass --url <gateway-mcp-url>.`,
		);
	}
	const workspace = parseWorkspace(await response.json());
	if (!workspace || workspace.slug !== slug) {
		throw new Error(
			`Tedix returned an invalid workspace record for organization "${slug}".`,
		);
	}
	return workspace;
}
