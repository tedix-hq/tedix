import type {
	EntrustmentLevel,
	EvidencePolicy,
} from "@tedix/api-contract/schemas/earned-delegation";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	entrustableActivities,
	tediEntrustmentGrants,
} from "../../schema/earned-delegation";
import {
	EarnedDelegationError,
	hashSnapshot,
	type RiskLevel,
} from "./authority-policy";

export async function createEntrustableActivity(
	db: DbClient,
	input: {
		organizationId?: string | null;
		key: string;
		version: number;
		supersedesId?: string | null;
		roleTemplateId?: string | null;
		name: string;
		description?: string | null;
		taskFamily: string;
		riskLevel: RiskLevel;
		maximumLevel: EntrustmentLevel;
		actionPatterns: string[];
		toolIds: string[];
		rubric: typeof entrustableActivities.$inferInsert.rubric;
		evidencePolicy: EvidencePolicy;
		now: string;
	},
) {
	if (input.version === 1 && input.supersedesId) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"The first activity version cannot supersede another version",
		);
	}
	if (input.version > 1 && !input.supersedesId) {
		throw new EarnedDelegationError(
			"invalid_transition",
			"Activity versions after v1 require the active predecessor",
		);
	}
	let predecessor: typeof entrustableActivities.$inferSelect | null = null;
	if (input.supersedesId) {
		const prior = await db
			.select()
			.from(entrustableActivities)
			.where(eq(entrustableActivities.id, input.supersedesId))
			.limit(1);
		if (
			prior[0]?.status !== "active" ||
			prior[0].key !== input.key ||
			prior[0].organizationId !== (input.organizationId ?? null) ||
			input.version !== prior[0].version + 1
		) {
			throw new EarnedDelegationError(
				"invalid_transition",
				"Activity versions must form a consecutive same-scope lineage",
			);
		}
		predecessor = prior[0];
	}
	const rubricHash = await hashSnapshot(input.rubric);
	const evidencePolicyHash = await hashSnapshot(input.evidencePolicy);
	const activityId = crypto.randomUUID();
	const activityValues: typeof entrustableActivities.$inferInsert = {
		id: activityId,
		organizationId: input.organizationId ?? null,
		key: input.key,
		version: input.version,
		supersedesId: input.supersedesId ?? null,
		roleTemplateId: input.roleTemplateId ?? null,
		name: input.name,
		description: input.description ?? null,
		status: "active",
		taskFamily: input.taskFamily,
		riskLevel: input.riskLevel,
		maximumLevel: input.maximumLevel,
		actionPatterns: input.actionPatterns,
		toolIds: input.toolIds,
		rubric: input.rubric,
		rubricHash,
		evidencePolicy: input.evidencePolicy,
		evidencePolicyHash,
		createdAt: input.now,
		updatedAt: input.now,
	};
	if (!predecessor) {
		const rows = await db
			.insert(entrustableActivities)
			.values(activityValues)
			.returning();
		return rows[0]!;
	}

	// Publishing a new head retires the predecessor and fails its authority
	// closed in the same D1 transaction. A stale grant can be re-earned against
	// the new rubric; it cannot silently survive a changed activity definition.
	const retirePredecessor = db
		.update(entrustableActivities)
		.set({ status: "retired", updatedAt: input.now })
		.where(
			and(
				eq(entrustableActivities.id, predecessor.id),
				eq(entrustableActivities.status, "active"),
			),
		);
	const restrictStaleGrants = db
		.update(tediEntrustmentGrants)
		.set({
			status: "restricted",
			restrictedAt: input.now,
			reason: `Activity superseded by ${activityId}`,
			revision: sql`${tediEntrustmentGrants.revision} + 1`,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(tediEntrustmentGrants.activityId, predecessor.id),
				inArray(tediEntrustmentGrants.status, ["active", "expired"]),
			),
		);
	await db.batch([
		retirePredecessor,
		restrictStaleGrants,
		db.insert(entrustableActivities).values(activityValues),
	]);
	const created = await db
		.select()
		.from(entrustableActivities)
		.where(eq(entrustableActivities.id, activityId))
		.limit(1);
	return created[0]!;
}
