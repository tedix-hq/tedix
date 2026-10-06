import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediRoleAssignments } from "../../schema/earned-delegation";
import { EarnedDelegationError, requireScopedTedi } from "./authority-policy";

export async function assignInitialRoleTrack(
	db: DbClient,
	input: {
		organizationId: string;
		tediId: string;
		roleTemplateId?: string | null;
		roleKey: string;
		roleName: string;
		metadata?: typeof tediRoleAssignments.$inferInsert.metadata;
		now: string;
	},
) {
	await requireScopedTedi(db, input.organizationId, input.tediId);
	const existing = await db
		.select()
		.from(tediRoleAssignments)
		.where(
			and(
				eq(tediRoleAssignments.organizationId, input.organizationId),
				eq(tediRoleAssignments.tediId, input.tediId),
				eq(tediRoleAssignments.status, "active"),
			),
		)
		.limit(1);
	if (existing[0]) {
		if (existing[0].roleKey === input.roleKey) return existing[0];
		throw new EarnedDelegationError(
			"invalid_transition",
			"Changing role tracks requires an independently disposed role_change decision",
		);
	}
	const rows = await db
		.insert(tediRoleAssignments)
		.values({
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			tediId: input.tediId,
			roleTemplateId: input.roleTemplateId ?? null,
			roleKey: input.roleKey,
			roleName: input.roleName,
			status: "active" as const,
			careerStage: "shadow",
			assignedAt: input.now,
			stageChangedAt: input.now,
			revision: 1,
			lastDecisionId: null,
			evidenceSnapshotHash: null,
			metadata: input.metadata ?? null,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.returning();
	return rows[0]!;
}
