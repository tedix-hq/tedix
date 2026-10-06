/** Catalog persistence for SEP-2640 MCP Skills manifests. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { eq } from "drizzle-orm";
import {
	appCatalogMcpSkills,
	type CatalogMcpSkillResources,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

export interface CatalogMcpSkillSyncInput {
	skillUri: string;
	frontmatter: Record<string, JsonValue>;
	resources: CatalogMcpSkillResources;
}

/**
 * Upsert manifests observed in skills/list. SEP-2640 permits that method to
 * return an empty or partial catalog, so omission is never evidence of removal.
 */
export async function syncCatalogMcpSkills(
	db: Database,
	catalogAppId: string,
	skills: CatalogMcpSkillSyncInput[],
): Promise<{ added: number; updated: number; removed: 0 }> {
	const now = new Date().toISOString();
	const existing = await db
		.select()
		.from(appCatalogMcpSkills)
		.where(eq(appCatalogMcpSkills.catalogAppId, catalogAppId));
	const existingByUri = new Map(
		existing.map((skill) => [skill.skillUri, skill]),
	);
	const uniqueSkills = new Map(skills.map((skill) => [skill.skillUri, skill]));
	let added = 0;
	let updated = 0;

	for (const skill of uniqueSkills.values()) {
		const current = existingByUri.get(skill.skillUri);
		await db
			.insert(appCatalogMcpSkills)
			.values({
				id: crypto.randomUUID(),
				catalogAppId,
				skillUri: skill.skillUri,
				frontmatter: skill.frontmatter,
				resources: skill.resources,
				detectedAt: current?.detectedAt ?? now,
				lastSeenAt: now,
			})
			.onConflictDoUpdate({
				target: [
					appCatalogMcpSkills.catalogAppId,
					appCatalogMcpSkills.skillUri,
				],
				set: {
					frontmatter: skill.frontmatter,
					resources: skill.resources,
					lastSeenAt: now,
				},
			});
		if (current) updated++;
		else added++;
	}

	return { added, updated, removed: 0 };
}
