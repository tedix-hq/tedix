/** Catalog persistence for SEP-2640 MCP Skills manifests. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { eq, sql } from "drizzle-orm";
import {
	appCatalogMcpSkills as schemaAppCatalogMcpSkills,
	type CatalogMcpSkillResources,
} from "../../schema/catalog";
import { coreTable } from "../../core-store/client";
import { chunkForBoundParams } from "../../utils/batch";
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
	const appCatalogMcpSkills = coreTable(db, schemaAppCatalogMcpSkills);
	const existing = await db
		.select()
		.from(appCatalogMcpSkills)
		.where(eq(appCatalogMcpSkills.catalogAppId, catalogAppId));
	const existingByUri = new Map(
		existing.map((skill) => [skill.skillUri, skill]),
	);
	const uniqueSkills = new Map(skills.map((skill) => [skill.skillUri, skill]));

	// One multi-row upsert per chunk: detectedAt is only read on insert, and
	// the conflict update never rewrites it, so a uniform value is faithful.
	// 7 bound columns per row keeps each chunk under the D1 parameter cap.
	for (const chunk of chunkForBoundParams([...uniqueSkills.values()], 14)) {
		await db
			.insert(appCatalogMcpSkills)
			.values(
				chunk.map((skill) => ({
					id: crypto.randomUUID(),
					catalogAppId,
					skillUri: skill.skillUri,
					frontmatter: skill.frontmatter,
					resources: skill.resources,
					detectedAt: now,
					lastSeenAt: now,
				})),
			)
			.onConflictDoUpdate({
				target: [
					appCatalogMcpSkills.catalogAppId,
					appCatalogMcpSkills.skillUri,
				],
				set: {
					frontmatter: sql`excluded.frontmatter`,
					resources: sql`excluded.resources`,
					lastSeenAt: now,
				},
			});
	}

	let added = 0;
	let updated = 0;
	for (const skill of uniqueSkills.keys()) {
		if (existingByUri.has(skill)) updated++;
		else added++;
	}
	return { added, updated, removed: 0 };
}
