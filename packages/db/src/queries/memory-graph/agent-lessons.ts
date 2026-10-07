/**
 * Approved team lessons for local coding-agent sessions.
 *
 * A lesson is a fact whose topic key starts with the given prefix
 * (`learning-feed:`). Only approved lessons are returned: org-wide (no tedi),
 * `review_status = confirmed`, `status = active`, a use policy that allows
 * injection, not archived and not invalidated (superseded facts carry
 * `valid_to`). The prefix is a range on `idx_memory_facts_topic_key`
 * (organization, topic key), so the scan never leaves the lesson keys.
 */

import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { DbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";

export interface ApprovedAgentLessonRow {
	id: string;
	content: string;
	priority: "core" | "active" | "background" | null;
	confidence: number;
	metadata: Record<string, JsonValue> | null;
	updatedAt: string | null;
}

/** The first string after every string that starts with `prefix`. */
function prefixEnd(prefix: string): string {
	const last = prefix.charCodeAt(prefix.length - 1);
	return prefix.slice(0, -1) + String.fromCharCode(last + 1);
}

export async function listApprovedAgentLessons(
	db: DbQueryClient,
	orgId: string,
	topicPrefix: string,
	limit = 200,
): Promise<ApprovedAgentLessonRow[]> {
	return db
		.select({
			id: memoryFacts.id,
			content: memoryFacts.content,
			priority: memoryFacts.priority,
			confidence: memoryFacts.confidence,
			metadata: memoryFacts.metadata,
			updatedAt: memoryFacts.updatedAt,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				gte(memoryFacts.topicKey, topicPrefix),
				lt(memoryFacts.topicKey, prefixEnd(topicPrefix)),
				isNull(memoryFacts.tediId),
				eq(memoryFacts.reviewStatus, "confirmed"),
				eq(memoryFacts.status, "active"),
				// A confirmed lesson is delivered; one restricted to evidence or
				// barred from injection is not.
				inArray(memoryFacts.usePolicy, [
					"can_use_as_instruction",
					"requires_user_confirmation",
				]),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.orderBy(desc(memoryFacts.confidence), desc(memoryFacts.updatedAt))
		.limit(limit);
}
