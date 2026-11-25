import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { tediApprovalRequests } from "../schema/approvals";
import {
	kernelRuntimeRuns,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { workItems, workAttempts } from "../schema/work-items";
import {
	workApprovalProposals,
	workInteractions,
	workInteractionResponses,
} from "../schema/work-factory";
import { workDue, WORK_DUE_KINDS } from "../schema/work-due";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { claimWorkDue, releaseWorkDue } from "./work-due";

it("backfills every timer kind, claims at its due time, and preserves writer changes across retries", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(
			schemaDdl(
				tediApprovalRequests,
				kernelRuntimeRuns,
				tediRuntimeEvents,
				workItems,
				workAttempts,
				workApprovalProposals,
				workInteractions,
				workInteractionResponses,
			),
		);
		// Other required fields are inert; exercise the real schema and migration.
		const insert = (
			table: SQLiteTable,
			values: Record<string, string | number>,
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
		const iso = (offset: number) => new Date(instant + offset).toISOString();
		const created = iso(-3 * 86_400_000);
		const at = iso(0);
		insert(tediApprovalRequests, {
			id: "approval",
			org_id: "org",
			status: "pending",
			payload: "{}",
			expires_at: at,
			created_at: created,
		});
		insert(workApprovalProposals, {
			id: "proposal",
			org_id: "org",
			status: "pending",
			approver_type: "tedi",
			proposal: "{}",
			created_at: at,
			expires_at: iso(86_400_000),
		});
		insert(workApprovalProposals, {
			id: "expired-proposal",
			org_id: "org",
			work_item_id: "expired-work",
			status: "pending",
			approver_type: "tedi",
			proposal: "{}",
			created_at: created,
			expires_at: created,
		});
		insert(workInteractions, {
			id: "review",
			org_id: "org",
			target_type: "user",
			kind: "question",
			status: "open",
			created_at: created,
			metadata: "{}",
			version: 1,
		});
		insert(kernelRuntimeRuns, {
			id: "delegation",
			organization_id: "org",
			status: "running",
			delegated_tedi_id: "tedi",
			child_run_id: "child",
			created_at: iso(-600_000),
			started_at: iso(-600_000),
			updated_at: iso(-90_000).replace("T", " ").replace("Z", ""),
			metadata: "{}",
		});
		insert(workItems, {
			id: "supervision",
			org_id: "org",
			disposition: "accepted",
			executor_type: "external_agent",
			steward_type: "tedi",
			source_session_key: "session",
			created_at: iso(-300_000),
			metadata: '{"source":"tedi.start_agent_run"}',
		});
		insert(tediRuntimeEvents, {
			id: "orphan",
			organization_id: "org",
			kind: "run.started",
			run_id: "run",
			created_at: iso(-720_000),
			payload: "{}",
			terminal_seen: 0,
		});
		insert(workAttempts, {
			id: "attempt",
			org_id: "org",
			runtime_state: "running",
			expires_at: at,
			metadata: "{}",
		});
		const dir = new URL("../../drizzle/", import.meta.url);
		const migration = readdirSync(dir).find((name) =>
			name.endsWith("_work_due"),
		)!;
		sqlite.exec(
			readFileSync(new URL(`${migration}/migration.sql`, dir), "utf8"),
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(await claimWorkDue(db, iso(-1), at)).toEqual([]);
		const lease = iso(300_000);
		const claimed = await claimWorkDue(db, at, lease);
		expect(claimed.map((r) => r.kind).sort()).toEqual(
			[...WORK_DUE_KINDS].sort(),
		);
		expect(await claimWorkDue(db, at, lease)).toEqual([]);
		// Heartbeat moves the lease deadline; a finish for the old timer loses.
		const next = iso(3_600_000);
		sqlite
			.prepare("UPDATE work_attempts SET expires_at=? WHERE id='attempt'")
			.run(next);
		await releaseWorkDue(db, claimed, iso(120_000));
		expect(
			(await db.select().from(workDue)).find((r) => r.objectId === "attempt")
				?.dueAt,
		).toBe(next);
		const retried = await claimWorkDue(db, lease, iso(600_000));
		expect(retried).toHaveLength(6);
		// A lost handler is eligible again when the claim expires.
		expect(await claimWorkDue(db, iso(599_999), next)).toEqual([]);
		expect(await claimWorkDue(db, iso(600_000), next)).toHaveLength(6);
		sqlite.exec(
			"UPDATE tedi_approval_requests SET status='expired'; UPDATE work_approval_proposals SET status='approved'; UPDATE work_interactions SET status='cancelled'; UPDATE kernel_runtime_runs SET status='completed'; UPDATE work_items SET disposition='completed'; UPDATE tedi_runtime_events SET terminal_seen=1; UPDATE work_attempts SET runtime_state='expired';",
		);
		expect(await db.select().from(workDue)).toEqual([]);
	} finally {
		sqlite.close();
	}
});
