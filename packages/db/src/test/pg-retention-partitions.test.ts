import { expect, it } from "vite-plus/test";
import { PGlite } from "@electric-sql/pglite";
import { pgTableDdl } from "./pg-schema-ddl";
import {
	RETENTION_PARTITION_TABLES,
	retentionPartitionDdlOptions,
	retentionPartitionOfStatement,
} from "../schema-pg/retention-partitions";

const PARENTS = `
CREATE TABLE organizations (id text PRIMARY KEY);
CREATE TABLE tedis (id text PRIMARY KEY);
CREATE TABLE apps (id text PRIMARY KEY);
CREATE TABLE items (id text PRIMARY KEY);
`;

it("creates faithful monthly partitions for every eligible retention table", async () => {
	const engine = new PGlite();
	try {
		await engine.exec(PARENTS);
		for (const spec of RETENTION_PARTITION_TABLES) {
			for (const ddl of pgTableDdl(
				spec.table,
				retentionPartitionDdlOptions(spec),
			))
				await engine.exec(ddl);
			await engine.exec(retentionPartitionOfStatement(spec, "2026-11"));
			await engine.exec(retentionPartitionOfStatement(spec, "2026-12"));
		}
		await engine.exec(
			"INSERT INTO audit_events (id, organization_id, actor_id, actor_type, action, resource_type, timestamp) VALUES ('audit-1','org','actor','user','work.read','work_item','2026-11-15T00:00:00Z'), ('audit-2','org','actor','user','work.read','work_item','2026-12-01T00:00:00Z')",
		);
		await engine.exec(
			"INSERT INTO platform_cron_executions (id, schedule_id, cron, scheduled_at, started_at) VALUES ('cron-1','schedule','* * * * *','2026-11-02T00:00:00.000Z','2026-11-02T00:00:01.000Z')",
		);
		expect(
			(await engine.query("SELECT count(*)::int AS count FROM audit_events"))
				.rows,
		).toEqual([{ count: 2 }]);
		expect(
			(
				await engine.query(
					"SELECT count(*)::int AS count FROM platform_cron_executions",
				)
			).rows,
		).toEqual([{ count: 1 }]);
	} finally {
		await engine.close();
	}
});
