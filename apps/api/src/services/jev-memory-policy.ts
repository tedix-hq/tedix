import {
	parseJevSettings,
	type MemoryJudgmentPolicy,
} from "@tedix/api-contract/schemas/jev";
import type { DbClient } from "@tedix/db/client";
import { getOrganizationById } from "@tedix/db/queries/organizations";

export interface MemoryJudgmentRoute extends MemoryJudgmentPolicy {
	transport: "cloudflare" | "direct";
	timeoutMs: number;
}

/** Tenant route for a memory judgment; null when Jev is denied or the org is unreadable. */
export async function resolveMemoryJudgmentRoute(
	db: DbClient,
	organizationId: string,
	purpose: "memoryQuality" | "graphLinking",
): Promise<MemoryJudgmentRoute | null> {
	const organization = await getOrganizationById(db, organizationId).catch(
		() => null,
	);
	if (!organization) return null;
	const settings = parseJevSettings(organization.metadata);
	if (!settings.enabled) return null;
	const policy = settings.purposes[purpose];
	return {
		...policy,
		// Clef runs only on Workers AI; the direct route exists for TypeSafe Jev alone.
		transport:
			policy.model === "typesafe/jev" ? settings.transport : "cloudflare",
		timeoutMs: settings.timeoutMs,
	};
}
