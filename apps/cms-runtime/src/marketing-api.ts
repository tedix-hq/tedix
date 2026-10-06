/**
 * Landing App RPC Client
 *
 * Creates a typed oRPC client for calling the API from Astro SSR pages.
 * Uses Cloudflare service binding (zero-latency, no auth) in deployed envs,
 * falls back to API key auth for local dev.
 *
 * Usage in Astro pages:
 * ```ts
 * import { env } from 'cloudflare:workers';
 * const client = getCatalogClient(env);
 * const { apps, total, pagination } = await client.catalog.list({ limit: 24 });
 * ```
 */

import { withApiKey } from "@tedix/api-client/adapters";
import {
	createLink,
	createORPCClient,
	getApiClient,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";

export type AppClient = RouterContractClient<ApiContract>;

// The API authenticates service bindings at the transport layer, but each
// procedure still requires an explicitly delegated machine scope. Keep this
// catalog-only client constrained to the one read scope it needs.
const CATALOG_READ_SCOPES = "apps:read";

function serviceBindingFetch(binding: Fetcher): typeof fetch {
	return (input, init) => {
		const withDuplex = (requestInit?: RequestInit): RequestInit | undefined => {
			if (!requestInit || requestInit.body == null) {
				return requestInit;
			}
			// Node/Undici local dev requires duplex for streamed request bodies.
			return {
				...(requestInit as Record<string, unknown>),
				duplex: "half",
			} as RequestInit;
		};

		// Miniflare service bindings in Astro dev can reject cross-realm Request
		// objects. Normalize Request inputs to URL + init before forwarding.
		if (input instanceof Request) {
			return binding.fetch(
				input.url,
				withDuplex({
					method: input.method,
					headers: input.headers,
					body: input.body,
					redirect: input.redirect,
				} as RequestInit),
			);
		}
		return binding.fetch(input, withDuplex(init));
	};
}

function getServiceBindingClient(
	binding: Fetcher,
	headers: Record<string, string> = {},
): AppClient {
	const link = createLink({
		url: "https://api/rpc",
		getHeaders: () => ({
			"X-Service-Binding": "true",
			"X-Tedix-Tedi-Scopes": CATALOG_READ_SCOPES,
			...headers,
		}),
		fetch: serviceBindingFetch(binding),
	});
	return createORPCClient(link) as AppClient;
}

/**
 * Create a typed API client from Cloudflare Worker env bindings.
 * Prefers service binding (deployed envs), falls back to API key (local dev).
 */
export function getCatalogClient(env: {
	API_URL: string;
	CATALOG_API_KEY?: string;
	API_SERVICE?: Fetcher;
}): AppClient {
	if (env.API_SERVICE) {
		return getServiceBindingClient(env.API_SERVICE);
	}
	if (!env.CATALOG_API_KEY) {
		throw new Error(
			"CATALOG_API_KEY required when API_SERVICE binding unavailable",
		);
	}
	return getApiClient<ApiContract>(env.API_URL, {
		getHeaders: withApiKey(env.CATALOG_API_KEY),
	});
}

/**
 * Create an org-scoped client over the trusted Worker service binding.
 *
 * Public landing routes must validate and rate-limit input before using this
 * client. The organization header is attached server-side and never accepted
 * from the browser.
 */
export function getOrganizationServiceClient(
	env: { API_SERVICE?: Fetcher },
	organizationId: string,
): AppClient {
	if (!env.API_SERVICE) {
		throw new Error(
			"API_SERVICE is required for organization-scoped landing writes",
		);
	}
	return getServiceBindingClient(env.API_SERVICE, {
		"X-Tedix-Org-Id": organizationId,
		"X-Tedix-Caller-Type": "landing-demand-intake",
	});
}
