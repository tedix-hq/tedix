import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import { skillEntries } from "../../schema/cognitive";
import { getAffectedRows } from "../../utils/d1-result";

/**
 * Move one tenant-owned skill in the catalog hierarchy without touching its
 * immutable slug, content revision, or runtime identity.
 */
export async function moveSkillToFolder(
	db: DbClient,
	organizationId: string,
	skillId: string,
	folderPath: string | null,
): Promise<boolean> {
	const result = await db
		.update(skillEntries)
		.set({ folderPath, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(skillEntries.id, skillId),
				eq(skillEntries.organizationId, organizationId),
			),
		);
	return getAffectedRows(result) !== 0;
}
