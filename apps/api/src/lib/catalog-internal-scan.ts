import type {
	InstallationTrustPolicy,
	ManagedCatalogScanEndpoint,
} from "@tedix/api-contract/schemas/installation-trust";
import type { FetchFn, ServiceBindingFetcher } from "./mcp-client";

/** Exact installation grants, never a tenant-editable catalog URL or hostname suffix. */
export function getManagedCatalogScanEndpoint(
	endpoint: string | null | undefined,
	policy: InstallationTrustPolicy | null | undefined,
): ManagedCatalogScanEndpoint | undefined {
	if (!endpoint || !policy) return undefined;
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "https:" || url.username || url.password || url.hash)
			return undefined;
		return policy.catalogScan.endpoints.find((entry) => entry.url === url.href);
	} catch {
		return undefined;
	}
}

export function resolveTedixInternalScanHeaders(input: {
	endpoint: string | null | undefined;
	platformServiceToken?: string;
	policy: InstallationTrustPolicy | null | undefined;
}): Record<string, string> | undefined {
	const endpoint = getManagedCatalogScanEndpoint(input.endpoint, input.policy);
	if (!endpoint || !input.platformServiceToken) return undefined;
	return {
		...endpoint.headers,
		Authorization: `Bearer ${input.platformServiceToken}`,
		...(endpoint.transport === "mcp" ? { "X-Service-Binding": "true" } : {}),
	};
}

/** Pin privileged scans to their granted endpoint, including any transport redirect. */
export function createManagedCatalogScanFetch(
	endpoint: ManagedCatalogScanEndpoint,
	bindings: { mcp?: ServiceBindingFetcher; cms?: ServiceBindingFetcher },
	httpFetch: FetchFn = (url, init) => fetch(url, init),
): FetchFn {
	const binding = endpoint.transport === "mcp" ? bindings.mcp : bindings.cms;
	if (endpoint.transport !== "http" && !binding)
		throw new Error("Managed catalog scan service binding is unavailable");
	return async (url, init) => {
		if (new URL(url).href !== endpoint.url)
			throw new Error("Managed catalog scan endpoint changed");
		const headers = new Headers(init?.headers);
		if (endpoint.transport === "mcp")
			headers.set("X-Tedix-Host", new URL(endpoint.url).hostname);
		const options = { ...init, headers, redirect: "manual" as const };
		return endpoint.transport === "http"
			? httpFetch(url, options)
			: binding!.fetch(new Request(url, options));
	};
}

/** Old scan snapshots must not revive Worker credentials after grant revocation. */
export function catalogScanSnapshotHeaders(
	headers: Record<string, string>,
	platformServiceToken?: string,
): Record<string, string> | undefined {
	if (
		platformServiceToken &&
		Object.entries(headers).some(
			([name, value]) =>
				name.toLowerCase() === "authorization" &&
				value === `Bearer ${platformServiceToken}`,
		)
	)
		return undefined;
	return headers;
}
