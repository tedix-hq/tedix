import { eq, sql } from "drizzle-orm";
import {
	DecisionLearningConfigSchema,
	type DecisionLearningConfig,
} from "@tedix/api-contract/schemas/decision-learning";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

export async function getDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return DecisionLearningConfigSchema.parse(
		row?.metadata?.decisionLearning ?? {},
	);
}
export async function setDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
	config: DecisionLearningConfig,
) {
	const parsed = DecisionLearningConfigSchema.parse(config);
	await db
		.update(organizations)
		.set({
			metadata: sql`json_set(coalesce(${organizations.metadata}, '{}'), '$.decisionLearning', json(${JSON.stringify(parsed)}))`,
		})
		.where(eq(organizations.id, organizationId));
	return parsed;
}
