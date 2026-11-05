import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const migrations = path.resolve(import.meta.dirname, "../logs-db/migrations");
const sql = (name: string) => readFileSync(path.join(migrations, name), "utf8");
const setup = sql("0006_audit_events_lookup_indexes.sql");
const swap = sql("0007_audit_events_lookup_swap.sql");
const cleanup = sql("0008_audit_events_lookup_cleanup.sql");
const copy =
	"UPDATE audit_events_rebuild SET cursor = MIN(cursor + 1000, stop) WHERE id = 1 AND cursor < stop";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(sql("0001_logs_schema.sql"));
	db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2005)
		INSERT INTO audit_events (id,organization_id,actor_id,actor_type,action,resource_type,metadata,timestamp)
		SELECT 'event-'||i,'org','actor','user','mcp.tool.execute','tool',
		json_object('traceId','trace-'||i,'executionId','exec-'||i,'appId','app'),i FROM n;`);
	db.exec(setup);
	return db;
}

function finish(db: DatabaseSync) {
	while (
		db.prepare("SELECT 1 FROM audit_events_rebuild WHERE cursor < stop").get()
	)
		db.exec(copy);
	expect(
		db
			.prepare(
				"SELECT * FROM audit_events EXCEPT SELECT * FROM audit_events_v2",
			)
			.all(),
	).toEqual([]);
	expect(
		db
			.prepare(
				"SELECT * FROM audit_events_v2 EXCEPT SELECT * FROM audit_events",
			)
			.all(),
	).toEqual([]);
	db.exec(`BEGIN; ${swap} COMMIT;`);
	db.exec("BEGIN");
	expect(() => db.exec(cleanup)).toThrow(/CHECK/);
	db.exec("ROLLBACK");
	while (db.prepare("SELECT 1 FROM audit_events_pre_lookup LIMIT 1").get())
		db.exec(
			"DELETE FROM audit_events_pre_lookup WHERE rowid IN (SELECT rowid FROM audit_events_pre_lookup LIMIT 1000)",
		);
	db.exec(`BEGIN; ${cleanup} COMMIT;`);
	expect(db.prepare("PRAGMA integrity_check").all()).toEqual([
		{ integrity_check: "ok" },
	]);
}

describe("online audit index rebuild", () => {
	it("preserves inserts, duplicate delivery, updates, deletes and the final tail", () => {
		const db = fixture();
		db.exec(copy);
		db.exec(
			"UPDATE audit_events SET actor_id='updated' WHERE id IN ('event-1','event-2005')",
		);
		db.exec("UPDATE audit_events SET id='renamed' WHERE id='event-2'");
		db.exec("DELETE FROM audit_events WHERE id IN ('event-3','event-2004')");
		db.exec(
			"INSERT INTO audit_events SELECT 'tail',organization_id,actor_id,actor_type,action,resource_type,resource_id,metadata,ip_address,user_agent,timestamp FROM audit_events LIMIT 1",
		);
		db.exec(
			"INSERT OR IGNORE INTO audit_events SELECT * FROM audit_events WHERE id='tail'",
		);
		finish(db);
		expect(db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({
			n: 2004,
		});
		expect(
			db
				.prepare("SELECT actor_id FROM audit_events WHERE id='event-2005'")
				.get(),
		).toEqual({ actor_id: "updated" });
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE name LIKE 'audit_events_rebuild%' OR name='audit_events_v2'",
				)
				.all(),
		).toEqual([]);
		db.close();
	});

	it("refuses early swap and rolls back a failed copy with its cursor", () => {
		const db = fixture();
		db.exec("BEGIN");
		expect(() => db.exec(swap)).toThrow(/CHECK/);
		db.exec("ROLLBACK");
		expect(db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({
			n: 2005,
		});
		expect(() =>
			db.exec("UPDATE audit_events_rebuild SET cursor=2005"),
		).toThrow(/1000/);
		db.exec(
			"CREATE TRIGGER fail_copy BEFORE INSERT ON audit_events_v2 WHEN NEW.id='event-500' BEGIN SELECT RAISE(ABORT,'copy failed'); END;",
		);
		expect(() => db.exec(copy)).toThrow(/copy failed/);
		expect(db.prepare("SELECT cursor FROM audit_events_rebuild").get()).toEqual(
			{ cursor: 0 },
		);
		expect(
			db.prepare("SELECT count(*) AS n FROM audit_events_v2").get(),
		).toEqual({ n: 0 });
		db.exec("DROP TRIGGER fail_copy");
		finish(db);
		db.close();
	});

	it("uses all four lookup indexes after swapping, including unscoped trace and execution", () => {
		const db = fixture();
		finish(db);
		for (const [where, index] of [
			[
				"json_extract(metadata,'$.traceId')='trace-1' AND action LIKE 'mcp.%'",
				"trace_timestamp",
			],
			[
				"json_extract(metadata,'$.executionId')='exec-1' AND action IN ('mcp.code.execute','mcp.code.error','mcp.tool.execute','mcp.tool.error')",
				"execution_timestamp",
			],
			[
				"organization_id='org' AND json_extract(metadata,'$.appId')='app'",
				"org_app_timestamp",
			],
			[
				"organization_id='org' AND actor_id='actor' AND action LIKE 'mcp.%'",
				"org_actor_timestamp",
			],
		]) {
			const plan = db
				.prepare(
					`EXPLAIN QUERY PLAN SELECT * FROM audit_events WHERE ${where} ORDER BY timestamp LIMIT 50`,
				)
				.all();
			expect(plan.map((row) => row.detail).join("\n")).toContain(
				`idx_audit_events_${index}`,
			);
		}
		db.close();
	});
});
