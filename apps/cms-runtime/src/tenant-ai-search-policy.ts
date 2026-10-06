export const TENANT_AI_SEARCH_LOGICAL_NAME = "emdash-content";

export async function tenantAiSearchInstanceId(slug: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(slug),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `cms-${hash.slice(0, 24)}`;
}

export function tenantAiSearchCreateConfig(
	config: Record<string, unknown>,
	instanceId: string,
): Record<string, unknown> {
	if (config.id !== TENANT_AI_SEARCH_LOGICAL_NAME) {
		throw new Error(
			"Tenant bundles may create only their pinned AI Search instance",
		);
	}
	for (const key of Object.keys(config)) {
		if (!new Set(["id", "index_method", "custom_metadata"]).has(key)) {
			throw new Error(
				"Tenant bundles may not configure arbitrary AI Search options",
			);
		}
	}
	return { ...config, id: instanceId };
}

export function tenantAiSearchUpdateConfig(
	config: Record<string, unknown>,
): Record<string, unknown> {
	if (Object.keys(config).some((key) => key !== "custom_metadata")) {
		throw new Error("Tenant bundles may update only AI Search metadata fields");
	}
	return config;
}

export function assertTenantAiSearchLogicalName(name: string): void {
	if (name !== TENANT_AI_SEARCH_LOGICAL_NAME) {
		throw new Error(
			"Tenant bundles may access only their pinned AI Search instance",
		);
	}
}
