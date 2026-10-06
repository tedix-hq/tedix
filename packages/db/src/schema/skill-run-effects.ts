/** Human observations of effects after a canonical skill workflow run. */
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { skillRuns } from "./cognitive";
import { organizations } from "./organizations";
import { workItems } from "./work-items";

export const skillRunEffectObservations = sqliteTable(
	"skill_run_effect_observations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		skillRunId: text("skill_run_id")
			.notNull()
			.references(() => skillRuns.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").references(() => workItems.id, {
			onDelete: "set null",
		}),
		source: text("source", { enum: ["human_attestation"] })
			.notNull()
			.default("human_attestation"),
		observerUserId: text("observer_user_id").notNull(),
		/** Human attestation, not a provider readback or verified task outcome. */
		observedState: text("observed_state", {
			enum: ["confirmed", "contradicted", "uncertain"],
		}).notNull(),
		evidenceRef: text("evidence_ref").notNull(),
		effectNote: text("effect_note").notNull(),
		observedAt: text("observed_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_skill_run_effect_observations_org_run").on(
			table.organizationId,
			table.skillRunId,
			table.createdAt,
		),
		uniqueIndex("uniq_skill_run_effect_observation_user_ref").on(
			table.organizationId,
			table.skillRunId,
			table.observerUserId,
			table.evidenceRef,
		),
	],
);

export type SkillRunEffectObservation =
	typeof skillRunEffectObservations.$inferSelect;
