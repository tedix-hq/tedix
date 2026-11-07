/**
 * Gateway side of per-organization personal-data redaction.
 *
 * The setting lives on the organization row (`metadata.personalDataRedaction`)
 * and is read through `apps/api` (`mcpGovernance.resolvePersonalDataRedaction`),
 * because this Worker has no general database access. When the organization
 * turned it on, results of tools declared `sensitive_data` are masked in
 * response shaping (`@tedix/mcp-shared/personal-data-redact`).
 *
 * The answer is cached per isolate for five minutes. When the API cannot
 * answer, a previously cached answer is reused even if expired; an org whose
 * setting was never seen resolves to off — redaction stays strictly opt-in.
 */

import { setBoundedExpiringCacheEntry } from "../lib/bounded-cache";
import type { ServerContext } from "./server-context";

type RedactionContext = Partial<Pick<ServerContext, "app" | "apiClient">>;

const ORG_REDACTION_TTL_MS = 5 * 60 * 1000;
const ORG_REDACTION_MAX_ENTRIES = 500;

const orgRedactionCache = new Map<
	string,
	{ enabled: boolean; expiresAt: number }
>();

/** Test seam: forget cached organization settings. */
export function resetPersonalDataRedactionCaches(): void {
	orgRedactionCache.clear();
}

/** Whether the organization enabled personal-data redaction. Never throws. */
export async function personalDataRedactionEnabled(
	agent: RedactionContext,
): Promise<boolean> {
	const organizationId = agent.app?.organizationId;
	if (!organizationId) return false;
	const cached = orgRedactionCache.get(organizationId);
	if (cached && cached.expiresAt > Date.now()) return cached.enabled;
	const resolve = agent.apiClient?.mcpGovernance?.resolvePersonalDataRedaction;
	if (!resolve) return cached?.enabled ?? false;
	try {
		const { enabled } = await resolve({ organizationId });
		setBoundedExpiringCacheEntry(
			orgRedactionCache,
			organizationId,
			{ enabled, expiresAt: Date.now() + ORG_REDACTION_TTL_MS },
			ORG_REDACTION_MAX_ENTRIES,
		);
		return enabled;
	} catch (error) {
		console.warn("[governance] personal_data_redaction_lookup_failed", {
			organizationId,
			staleAnswer: cached?.enabled ?? null,
			error: error instanceof Error ? error.message : String(error),
		});
		return cached?.enabled ?? false;
	}
}
