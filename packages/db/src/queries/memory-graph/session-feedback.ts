import type { DbClient } from "../../client";
import { recordOwnerInstructionEdges } from "../decision-graph-writers";
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
	if (created) {
		await recordOwnerInstructionEdges(db, created);
		return created;
	}
	const row = await db.query.memoryFacts.findFirst({
		where: { id: fact.id, organizationId: fact.organizationId },
	});
	if (!row) throw new Error("Feedback lesson was not persisted");
	await recordOwnerInstructionEdges(db, row);
	return row;
}
