import { and, eq, ne, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreStore, jsonParameter } from "../../core-store/dialect";
import { skillEntries } from "../../schema/cognitive";

/**
 * Keep one platform-owned skill row per organization in step with the source
 * shipped in code. Runs pin the source they were started with, so this row
 * exists for run ownership and inspection; it never changes a running watch.
 * Writes only when the row is missing or its content differs.
 */
export async function ensurePlatformSkill(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		slug: string;
		title: string;
		description: string;
		content: string;
		files: Record<string, string>;
		tags: string[];
	},
): Promise<{ id: string; slug: string; revision: number }> {
	const postgres = coreStore(db) === "postgres";
	const [row] = await db
		.insert(skillEntries)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			tediId: null,
			title: input.title,
			slug: input.slug,
			description: input.description,
			content: input.content,
			files: input.files,
			tags: input.tags,
			visibility: "org",
			lifecycleState: "active",
			paceLayer: "differentiation",
		})
		.onConflictDoUpdate({
			target: skillEntries.id,
			set: {
				content: input.content,
				files: input.files,
				description: input.description,
				lifecycleState: "active",
				revision: sql`${skillEntries.revision} + 1`,
				updatedAt: postgres
					? sql`to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
					: sql`(CURRENT_TIMESTAMP)`,
			},
			setWhere: and(
				eq(skillEntries.organizationId, input.organizationId),
				or(
					ne(skillEntries.content, input.content),
					postgres
						? sql`${skillEntries.files} IS DISTINCT FROM ${jsonParameter(db, input.files)}`
						: ne(
								sql`coalesce(${skillEntries.files}, '')`,
								JSON.stringify(input.files),
							),
					ne(sql`coalesce(${skillEntries.lifecycleState}, '')`, "active"),
				),
			),
		})
		.returning({
			platformSkillId: skillEntries.id,
			platformSkillSlug: skillEntries.slug,
			platformSkillRevision: skillEntries.revision,
		});
	if (row)
		return {
			id: row.platformSkillId,
			slug: row.platformSkillSlug ?? input.slug,
			revision: row.platformSkillRevision,
		};
	// No write happened: the row is already current.
	const [current] = await db
		.select({
			platformSkillId: skillEntries.id,
			platformSkillSlug: skillEntries.slug,
			platformSkillRevision: skillEntries.revision,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, input.id),
				eq(skillEntries.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!current)
		throw new Error(
			`platform skill ${input.slug} is unavailable in this organization`,
		);
	return {
		id: current.platformSkillId,
		slug: current.platformSkillSlug ?? input.slug,
		revision: current.platformSkillRevision,
	};
}
