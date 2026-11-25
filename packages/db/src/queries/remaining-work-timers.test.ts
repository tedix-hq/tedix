import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { workItems, workAttempts, workEvents } from "../schema/work-items";
import { workDue } from "../schema/work-due";
import { schemaDdl } from "../test/schema-ddl";
import { createD1Facade } from "../test/d1-facade";
import { claimWorkDue, releaseWorkDue } from "./work-due";
import { recordStaleLanes } from "./work-items/lane-lifecycle";

it("backfills maintenance timers and replaces claims when heartbeat, policy, retry or allocation changes", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(
			schemaDdl(organizations, workItems, workAttempts, workEvents, workDue),
		);
		const insert = (
			table: SQLiteTable,
			values: Record<string, string | number | null>,
		) => {
			const config = getTableConfig(table);
			for (const column of config.columns) {
				if (
					column.notNull &&
					column.default === undefined &&
					!column.generated &&
					!(column.name in values)
				)
					values[column.name] = column.dataType === "number" ? 0 : "fixture";
			}
			const columns = Object.keys(values);
			sqlite
				.prepare(
					`INSERT INTO ${config.name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				)
				.run(...Object.values(values));
		};
		const instant = Date.now();
		const at = (minutes: number) =>
			new Date(instant + minutes * 60_000).toISOString();
		insert(organizations, { id: "orchard", metadata: "{}" });
		const item = (
			id: string,
			values: Record<string, string | number | null> = {},
		) =>
			insert(workItems, {
				id,
				org_id: "orchard",
				created_at: at(-60),
				disposition: "accepted",
				metadata: "{}",
				...values,
			});
		item("lane");
		insert(workAttempts, {
			id: "lane-attempt",
			org_id: "orchard",
			work_item_id: "lane",
			executor_type: "external_agent",
			runtime_state: "running",
			outcome: null,
			heartbeat_at: at(0),
			expires_at: at(10),
			metadata: '{"lane":true}',
		});
		item("draft", {
			work_kind: "outbound",
			metadata: JSON.stringify({
				outbound: { status: "reviewing", reviewRequestedAt: at(0) },
			}),
		});
		item("delegation", {
			provenance: '{"source":"kernelRuntime.directDelegation"}',
			updated_at: at(-8 * 1440),
		});
		insert(workAttempts, {
			id: "failed",
			org_id: "orchard",
			work_item_id: "delegation",
			runtime_state: "failed",
			outcome: "failed",
			finished_at: at(-8 * 1440),
			attempt_number: 1,
			metadata: "{}",
		});
		item("child", { metadata: '{"childDelegation":{"rootId":"root"}}' });
		item("ship", {
			deadline: at(10),
			metadata: '{"repositoryObserver":1,"event":{"kind":"ship_red"}}',
		});
		item("push", {
			created_at: at(0),
			metadata: '{"repositoryObserver":1,"event":{"kind":"push"}}',
		});
		sqlite.exec(
			readFileSync(
				new URL(
					"../../drizzle/20261125213240_remaining_work_timers/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		const due = (kind: string, id: string) =>
			sqlite
				.prepare(
					"SELECT due_at FROM work_due WHERE org_id='orchard' AND kind=? AND object_id=?",
				)
				.get(kind, id)?.due_at;
		expect(due("lane-stale", "lane-attempt")).toBe(at(5));
		expect(due("outbound-review", "draft")).toBe(at(30));
		expect(due("stale-delegation", "delegation")).toBe(at(-1440));
		expect(due("uncontracted-child", "child")).toBeTypeOf("string");
		expect(due("repository-observer", "ship")).toBe(at(10));
		expect(due("repository-observer", "push")).toBe(at(1440));
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(
			(await claimWorkDue(db, at(4), at(20))).some(
				(row) => row.kind === "lane-stale",
			),
		).toBe(false);
		const claimed = await claimWorkDue(db, at(5), at(20));
		expect(claimed.map((row) => row.objectId)).toEqual(["lane-attempt"]);
		// Heartbeat extends a timer while the old claim is in flight.
		sqlite
			.prepare(
				"UPDATE work_attempts SET heartbeat_at=?,expires_at=? WHERE id='lane-attempt'",
			)
			.run(at(5), at(15));
		await releaseWorkDue(db, claimed, at(7), true);
		expect(due("lane-stale", "lane-attempt")).toBe(at(10));
		// A tenant changes its timeout without editing the draft.
		sqlite.exec(
			`UPDATE organizations SET metadata='{"outboundReview":{"reviewTimeoutMinutes":60}}' WHERE id='orchard'`,
		);
		expect(due("outbound-review", "draft")).toBe(at(60));
		sqlite.exec(
			`UPDATE work_items SET metadata='{"outbound":{"status":"waiting_on_you"}}' WHERE id='draft'`,
		);
		expect(due("outbound-review", "draft")).toBeUndefined();
		// A Work edit and then an admitted retry both move retirement out of reach.
		sqlite
			.prepare("UPDATE work_items SET updated_at=? WHERE id='delegation'")
			.run(at(0));
		expect(due("stale-delegation", "delegation")).toBe(at(7 * 1440));
		insert(workAttempts, {
			id: "retry",
			org_id: "orchard",
			work_item_id: "delegation",
			runtime_state: "running",
			outcome: null,
			attempt_number: 2,
			metadata: "{}",
		});
		expect(due("stale-delegation", "delegation")).toBeUndefined();
		// The allocation follows child creation in the same batch.
		insert(workEvents, {
			sequence: 1,
			id: "child",
			org_id: "orchard",
			work_item_id: "child",
			payload: '{"taskContract":{}}',
		});
		expect(due("uncontracted-child", "child")).toBeUndefined();
		sqlite
			.prepare(
				"UPDATE work_items SET metadata=json_set(metadata,'$.observerRetryAt',?) WHERE id='ship'",
			)
			.run(at(20));
		expect(due("repository-observer", "ship")).toBe(at(20));
		sqlite.exec(
			"UPDATE work_items SET disposition='cancelled' WHERE id IN ('ship','push')",
		);
		expect(due("repository-observer", "ship")).toBeUndefined();
		expect(due("repository-observer", "push")).toBeUndefined();
		// Timer precision and eligibility must agree at an exact scheduled boundary.
		sqlite.exec(
			"UPDATE work_attempts SET heartbeat_at='2026-11-25T21:57:29.993Z',expires_at='2026-11-25T22:02:30.007Z' WHERE id='lane-attempt'",
		);
		expect(due("lane-stale", "lane-attempt")).toBe("2026-11-25T22:00:00.000Z");
		expect(
			await recordStaleLanes(db, "2026-11-25T22:00:00.000Z", {
				orgId: "orchard",
				ids: ["lane-attempt"],
			}),
		).toBe(1);
	} finally {
		sqlite.close();
	}
});
