import type { AppMetadata as ContractAppMetadata } from "@tedix/api-contract/schemas/app";
import type { AppMetadata as DbAppMetadata } from "@tedix/db/schema/apps";

const MCP_AUTH_MODES = new Set([
	"public",
	"authenticated",
	"hybrid",
	"proxy-target",
]);

function normalizeMcpConfig(
	mcpConfig: Record<string, unknown>,
): NonNullable<ContractAppMetadata["mcpConfig"]> {
	const next = { ...mcpConfig };

	if (!Array.isArray(next.capabilities)) next.capabilities = [];
	if (typeof next.enforcePolicies !== "boolean") next.enforcePolicies = false;
	if (typeof next.authMode !== "string" || !MCP_AUTH_MODES.has(next.authMode)) {
		next.authMode = "authenticated";
	}

	const scopeSync = next.scopeSync;
	if (scopeSync && typeof scopeSync === "object" && !Array.isArray(scopeSync)) {
		const ss = { ...(scopeSync as Record<string, unknown>) };
		if (typeof ss.enabled !== "boolean") ss.enabled = false;
		if (ss.strategy !== "descope-api" && ss.strategy !== "resource-metadata") {
			ss.strategy = "descope-api";
		}
		delete ss.registerPath;
		delete ss.syncPathTemplate;
		delete ss.syncMethod;
		if (ss.lastError == null) delete ss.lastError;
		next.scopeSync = ss;
	}

	return next as NonNullable<ContractAppMetadata["mcpConfig"]>;
}

function normalizeBlogConfig(
	blogConfig: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...blogConfig };
	delete next.language;
	if (typeof next.enabled !== "boolean") next.enabled = false;

	const imageGeneration = next.imageGeneration;
	if (
		imageGeneration &&
		typeof imageGeneration === "object" &&
		!Array.isArray(imageGeneration)
	) {
		const ig = { ...(imageGeneration as Record<string, unknown>) };
		if (typeof ig.enabled !== "boolean") ig.enabled = false;
		next.imageGeneration = ig;
	}

	return next;
}

export function normalizeAppMetadata(metadata: unknown): DbAppMetadata {
	// Contract schemas allow partial metadata; the DB type expects certain
	// invariants. Normalize before returning app DTOs so older rows validate
	// against the current public schema without requiring one-off migrations.
	if (!metadata || typeof metadata !== "object")
		return metadata as DbAppMetadata;

	const m = { ...(metadata as Record<string, unknown>) };

	const mcpConfig = m.mcpConfig;
	if (mcpConfig && typeof mcpConfig === "object" && !Array.isArray(mcpConfig)) {
		m.mcpConfig = normalizeMcpConfig(mcpConfig as Record<string, unknown>);
	}

	const blogConfig = m.blogConfig;
	if (
		blogConfig &&
		typeof blogConfig === "object" &&
		!Array.isArray(blogConfig)
	) {
		m.blogConfig = normalizeBlogConfig(blogConfig as Record<string, unknown>);
	}

	return m as unknown as DbAppMetadata;
}

/**
 * Merge an app metadata patch while honoring the explicit Connection-removal
 * sentinel accepted only by UpdateAppInputSchema. Clearing a provider also
 * clears its inherited scope and credential-shaping fields so a stale binding
 * cannot survive in a partially disconnected state.
 */
export function mergeAppMetadataPatch(
	existingMetadata: unknown,
	incomingMetadata: unknown,
): DbAppMetadata {
	const existing = normalizeAppMetadata(existingMetadata) ?? {};
	const incoming = normalizeAppMetadata(incomingMetadata) ?? {};
	const existingRecord = existing as Record<string, unknown>;
	const incomingRecord = incoming as Record<string, unknown>;
	const existingMcp = existingRecord.mcpConfig;
	const incomingMcp = incomingRecord.mcpConfig;
	const existingBlog = existingRecord.blogConfig;
	const incomingBlog = incomingRecord.blogConfig;

	const mergedMetadata: Record<string, unknown> = {
		...existingRecord,
		...incomingRecord,
		...(incomingMcp &&
		typeof incomingMcp === "object" &&
		!Array.isArray(incomingMcp) &&
		existingMcp &&
		typeof existingMcp === "object" &&
		!Array.isArray(existingMcp)
			? {
					mcpConfig: {
						...(existingMcp as Record<string, unknown>),
						...(incomingMcp as Record<string, unknown>),
					},
				}
			: {}),
		...(incomingBlog &&
		typeof incomingBlog === "object" &&
		!Array.isArray(incomingBlog) &&
		existingBlog &&
		typeof existingBlog === "object" &&
		!Array.isArray(existingBlog)
			? {
					blogConfig: {
						...(existingBlog as Record<string, unknown>),
						...(incomingBlog as Record<string, unknown>),
					},
				}
			: {}),
	};

	const rawIncomingMcp =
		incomingMetadata &&
		typeof incomingMetadata === "object" &&
		!Array.isArray(incomingMetadata)
			? (incomingMetadata as Record<string, unknown>).mcpConfig
			: undefined;
	if (
		rawIncomingMcp &&
		typeof rawIncomingMcp === "object" &&
		!Array.isArray(rawIncomingMcp) &&
		Object.hasOwn(rawIncomingMcp, "connectionProviderId") &&
		(rawIncomingMcp as Record<string, unknown>).connectionProviderId === null
	) {
		const mergedMcp = mergedMetadata.mcpConfig;
		if (
			mergedMcp &&
			typeof mergedMcp === "object" &&
			!Array.isArray(mergedMcp)
		) {
			const cleared = { ...(mergedMcp as Record<string, unknown>) };
			delete cleared.connectionProviderId;
			delete cleared.connectionScope;
			delete cleared.connectionScopes;
			delete cleared.credentialProfile;
			mergedMetadata.mcpConfig = cleared;
		}
	}

	return normalizeAppMetadata(mergedMetadata);
}
