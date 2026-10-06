const TEDIX_CONTROL_MCP_HOSTS = new Set([
	"builder.tedix.dev",
	"builder.tedix.tech",
	"docs-admin.tedix.dev",
	"docs-admin.tedix.tech",
]);

const TEDIX_DOCS_CONTROL_MCP_HOSTS = new Set([
	"docs-admin.tedix.dev",
	"docs-admin.tedix.tech",
]);

const TEDIX_CMS_CONTROL_MCP_HOSTS = new Set([
	"builder.tedix.dev",
	"builder.tedix.tech",
]);

const TEDIX_TENANT_MCP_HOST = /^[a-z0-9][a-z0-9-]*\.mcp\.tedix\.(?:dev|tech)$/;

export function isTedixControlMcpEndpoint(
	endpoint: string | null | undefined,
): boolean {
	if (!endpoint) return false;
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			TEDIX_CONTROL_MCP_HOSTS.has(url.hostname) &&
			url.pathname.replace(/\/+$/, "") === "/mcp"
		);
	} catch {
		return false;
	}
}

export function isTedixTenantMcpEndpoint(
	endpoint: string | null | undefined,
): boolean {
	if (!endpoint) return false;
	try {
		const url = new URL(endpoint);
		return (
			url.protocol === "https:" &&
			TEDIX_TENANT_MCP_HOST.test(url.hostname) &&
			url.pathname.replace(/\/+$/, "") === "/mcp"
		);
	} catch {
		return false;
	}
}

export function resolveTedixInternalScanHeaders(input: {
	endpoint: string | null | undefined;
	platformServiceToken?: string;
}): Record<string, string> | undefined {
	const controlEndpoint = isTedixControlMcpEndpoint(input.endpoint);
	const tenantEndpoint = isTedixTenantMcpEndpoint(input.endpoint);
	if (!controlEndpoint && !tenantEndpoint) return undefined;
	if (!input.platformServiceToken) return undefined;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${input.platformServiceToken}`,
	};
	if (tenantEndpoint) headers["X-Service-Binding"] = "true";
	const hostname = new URL(input.endpoint!).hostname;
	if (TEDIX_CMS_CONTROL_MCP_HOSTS.has(hostname))
		headers["X-Tedix-Connection-Label"] = "tedix-landing";
	if (TEDIX_DOCS_CONTROL_MCP_HOSTS.has(hostname)) {
		headers["X-Tedix-Connection-Label"] = "tedix";
		headers["X-Tedix-Delegated-Scope"] = "mcp:content.read";
		headers["X-Tedix-Actor-Type"] = "service";
		headers["X-Tedix-Actor-Id"] = "catalog-scanner";
	}
	return headers;
}
