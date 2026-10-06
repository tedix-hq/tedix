import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	listSkillRunEffectObservations,
	recordSkillRunEffectObservation,
} from "./skill-run-effects";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const WORK = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_run_effect_observations (
			id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_run_id TEXT NOT NULL,
			work_item_id TEXT, source TEXT NOT NULL, observer_user_id TEXT NOT NULL,
			observed_state TEXT NOT NULL, evidence_ref TEXT NOT NULL,
			effect_note TEXT NOT NULL, observed_at TEXT NOT NULL, created_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX uniq_skill_run_effect_observation_user_ref ON
			skill_run_effect_observations (organization_id, skill_run_id, observer_user_id, evidence_ref);
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

describe("skill run effect observations", () => {
	it("records an append-only human attestation and deduplicates an exact retry", async () => {
		const { db } = fixture();
		const input = {
			id: "66666666-6666-4666-8666-666666666666",
			organizationId: ORG,
			skillRunId: RUN,
			workItemId: WORK,
			source: "human_attestation" as const,
			observerUserId: USER,
			observedState: "confirmed" as const,
			evidenceRef: "review://outcome/1",
			effectNote: "The requested report is visible to the team.",
			observedAt: "2026-09-24T12:00:00.000Z",
			createdAt: "2026-09-24T12:00:00.000Z",
		};
		const first = await recordSkillRunEffectObservation(db, input);
		const replay = await recordSkillRunEffectObservation(db, {
			...input,
			id: crypto.randomUUID(),
		});
		expect(replay.id).toBe(first.id);
		await expect(
			recordSkillRunEffectObservation(db, {
				...input,
				id: crypto.randomUUID(),
				effectNote: "Contradictory reinterpretation",
			}),
		).rejects.toThrow("different content");
		expect(
			(
				await listSkillRunEffectObservations(db, {
					organizationId: ORG,
					skillRunId: RUN,
				})
			).rows,
		).toHaveLength(1);
	});

	it("never crosses the organization or exact run and exposes truncation", async () => {
		const { db } = fixture();
		for (let index = 0; index < 3; index++) {
			await recordSkillRunEffectObservation(db, {
				id: crypto.randomUUID(),
				organizationId: ORG,
				skillRunId: RUN,
				workItemId: WORK,
				source: "human_attestation",
				observerUserId: USER,
				observedState: "uncertain",
				evidenceRef: `review://outcome/${index}`,
				effectNote: `Observation ${index}`,
				observedAt: "2026-09-24T12:00:00.000Z",
				createdAt: "2026-09-24T12:00:00.000Z",
			});
		}
		expect(
			await listSkillRunEffectObservations(db, {
				organizationId: ORG,
				skillRunId: RUN,
				limit: 2,
			}),
		).toMatchObject({
			truncated: true,
			rows: [{ organizationId: ORG }, { organizationId: ORG }],
		});
		expect(
			(
				await listSkillRunEffectObservations(db, {
					organizationId: OTHER_ORG,
					skillRunId: RUN,
				})
			).rows,
		).toEqual([]);
		expect(
			(
				await listSkillRunEffectObservations(db, {
					organizationId: ORG,
					skillRunId: crypto.randomUUID(),
				})
			).rows,
		).toEqual([]);
	});
});
