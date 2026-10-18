import type { DbClient } from "../../client";
import { memoryFacts, type NewMemoryFact } from "../../schema/memory-graph";

/** Stable fact ids make a replay safe even when two harness hooks race. */
export async function insertSessionFeedbackLesson(
	db: DbClient,
	fact: NewMemoryFact,
) {
	const [created] = await db
		.insert(memoryFacts)
		.values(fact)
		.onConflictDoNothing({ target: memoryFacts.id })
		.returning();
	if (created) return created;
	const row = await db.query.memoryFacts.findFirst({
		where: { id: fact.id, organizationId: fact.organizationId },
	});
	if (!row) throw new Error("Feedback lesson was not persisted");
	return row;
}
