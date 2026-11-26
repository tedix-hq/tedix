import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";

const d1Removal = "20261126153906_remove_work_verification_tables";
const pgRemoval = "20261126154006_remove_work_verification_tables";
const at = "2026-11-20T12:00:00.000Z";
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;

for (const store of ["d1", "postgres"] as const) {
	describe(`observation table removal ${store}`, () => {
		it("refuses missing or changed history across organizations, then removes only reconciled tables", async () => {
			const pg = store === "postgres" ? await createPGliteFacade() : null;
			const sqlite =
				store === "d1"
					? createMigratedSqlite({ beforeMigration: d1Removal })
					: null;
			const exec = async (sql: string) => {
				if (pg) await pg.engine.exec(sql);
				else sqlite!.exec(sql);
			};
			const rows = async (sql: string): Promise<Record<string, unknown>[]> =>
				pg
					? ((await pg.engine.query(sql)).rows as Record<string, unknown>[])
					: (sqlite!.prepare(sql).all() as Record<string, unknown>[]);
			try {
				if (pg) {
					for (const migration of readMigrationFiles({
						migrationsFolder: fileURLToPath(
							new URL("../../../drizzle-pg", import.meta.url),
						),
					})) {
						if (
							migration.sql.some((sql) =>
								sql.includes("Work verification history is not reconciled"),
							)
						)
							break;
						for (const sql of migration.sql) await exec(sql);
					}
				}
				const migration = readFileSync(
					new URL(
						`../../../${pg ? "drizzle-pg/" + pgRemoval : "drizzle/" + d1Removal}/migration.sql`,
						import.meta.url,
					),
					"utf8",
				);
				const apply = async () => {
					await exec("BEGIN");
					try {
						await exec(migration);
						await exec("COMMIT");
					} catch (error) {
						await exec("ROLLBACK");
						throw error;
					}
				};
				const originals: { kind: string; record: Record<string, unknown> }[] =
					[];
				for (const org of ["first", "second"]) {
					await exec(`INSERT INTO organizations(id,name,slug) VALUES ('${org}','Fictional','${org}');
      INSERT INTO work_items(id,org_id,title,created_at,admission_spec_revision) VALUES ('${org}','${org}','Fictional', '${at}', '${org}-revision');
      INSERT INTO work_evidence(id,org_id,work_item_id,claim_key,kind,uri,submitted_by_type,submitted_by_id,submitted_at)
      VALUES ('${org}','${org}','${org}','result','url','https://example.test/proof','system','runner','${at}');
      INSERT INTO work_evidence_verifications(id,org_id,work_item_id,evidence_id,source,verifier_type,verifier_id,claimed,observed,matches_claim,observed_at)
      VALUES ('${org}','${org}','${org}','${org}','readback','system','observer','{"evidenceVersion":1}','{"nested":{"value":3,"other":4}}',${pg ? "true" : "1"},'${at}');
      INSERT INTO work_item_corroborations(id,org_id,work_item_id,principal_type,principal_id,session_id,evidence_ref,stance,body,occurred_at,created_at)
      VALUES ('${org}','${org}','${org}','user','reader','old-session','artifact://proof','contradicts','Original observation','${at}','2026-11-19T12:00:00.000Z');`);
					originals.push(
						{
							kind: "verification",
							record: {
								id: org,
								orgId: org,
								workItemId: org,
								evidenceId: org,
								source: "readback",
								verifierType: "system",
								verifierId: "observer",
								claimed: { evidenceVersion: 1 },
								observed: { nested: { other: 4, value: 3 } },
								matchesClaim: true,
								observedAt: at,
							},
						},
						{
							kind: "confirmation",
							record: {
								id: org,
								orgId: org,
								workItemId: org,
								principalType: "user",
								principalId: "reader",
								sessionId: "old-session",
								evidenceRef: "artifact://proof",
								stance: "contradicts",
								body: "Original observation",
								occurredAt: at,
								createdAt: "2026-11-19T12:00:00.000Z",
							},
						},
					);
				}
				await expect(apply()).rejects.toThrow();
				for (const { kind, record } of originals) {
					await exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
      VALUES (${quote(`work-observation:${kind}:${record.id}`)},${quote(record.orgId)},${quote(record.workItemId)},'work.observation_recorded','system','work-observation-migration',${quote(JSON.stringify({ schema: "tedix.work-observation.v1", kind, record }))},'${at}')`);
				}
				// Equal counts cannot hide a changed field, attribution, or tenant.
				for (const change of [
					"org_id='second',work_item_id='second'",
					"actor_id='untrusted-comment'",
					`payload=${quote(JSON.stringify({ schema: "tedix.work-observation.v1", kind: "verification", record: { ...originals[0]!.record, observed: { nested: { value: 99, other: 4 } } } }))}`,
				]) {
					await exec("BEGIN");
					await exec(
						`UPDATE work_events SET ${change} WHERE id='work-observation:verification:first'`,
					);
					await expect(exec(migration)).rejects.toThrow();
					await exec("ROLLBACK");
				}
				await apply();
				for (const table of [
					"work_evidence_verifications",
					"work_item_corroborations",
				]) {
					const found = pg
						? await rows(
								`SELECT table_name FROM information_schema.tables WHERE table_name='${table}'`,
							)
						: await rows(
								`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
							);
					expect(found).toEqual([]);
				}
				expect(await rows("SELECT id FROM work_evidence ORDER BY id")).toEqual([
					{ id: "first" },
					{ id: "second" },
				]);
				const events = await rows(
					"SELECT payload FROM work_events ORDER BY sequence",
				);
				expect(
					events.map((e) =>
						typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload,
					),
				).toEqual(
					originals.map(({ kind, record }) => ({
						schema: "tedix.work-observation.v1",
						kind,
						record,
					})),
				);
				if (sqlite) expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
			} finally {
				sqlite?.close();
				await pg?.close();
			}
		});
	});
}
