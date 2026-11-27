import { createLink, createORPCClient } from "@tedix/api-client/client";
import type { RouterContractClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";

export const POPPY_DISCOVERY_PATH = "/.well-known/poppy.json";

/**
 * The organization's published Poppy discovery document for this exact host,
 * or null when the organization points its Poppy domain elsewhere. The API
 * matches the hostname against the organization's own settings, and the
 * runtime only ever asks on behalf of the site's owning organization, so a
 * site can never publish another organization's door.
 */
export async function loadPoppyDiscovery(
	env: { API_SERVICE?: Fetcher },
	organizationId: string,
	hostname: string,
): Promise<unknown | null> {
	if (!env.API_SERVICE) return null;
	const binding = env.API_SERVICE;
	const client = createORPCClient(
		createLink({
			url: "https://api/rpc",
			getHeaders: () => ({ "X-Service-Binding": "true" }),
			fetch: (input, init) =>
				input instanceof Request
					? binding.fetch(input.url, {
							method: input.method,
							headers: input.headers,
						})
					: binding.fetch(input, init),
		}),
	) as RouterContractClient<ApiContract>;
	return client.osTenant.personalAgentDiscovery({ organizationId, hostname });
}

export function poppyDiscoveryResponse(
	request: Request,
	document: unknown,
): Response {
	return new Response(
		request.method === "HEAD" ? null : JSON.stringify(document),
		{
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Cache-Control": "public, max-age=60",
				"Access-Control-Allow-Origin": "*",
			},
		},
	);
}
