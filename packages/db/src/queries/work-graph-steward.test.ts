import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { canonicalWorkFactoryDdl } from "../test/schema-ddl";
import {
	clusterDuplicateTitles,
	findExpiredAttempts,
	findIdleAcceptedWorkItems,
	getWorkGraphHealth,
	jaccardSimilarity,
	normalizeWorkItemTitle,
	runWorkGraphSteward,
	tokenSet,
} from "./work-graph-steward";

const NOW = "2026-08-20T12:00:00.000Z";
const OLD = "2026-07-01T00:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(canonicalWorkFactoryDdl());
	// Steward fixtures intentionally include orphan references for detection.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const seed = (
		id: string,
		options: {
			title?: string;
			org?: string;
			disposition?: string;
			workKind?: string;
			projectId?: string | null;
			parentId?: string | null;
			createdAt?: string;
		} = {},
	) =>
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,work_kind,project_id,parent_work_item_id,created_at,accepted_at,work_class,purpose_exception_expires_at) VALUES(?,?,?,?,?,?,?,?,?,'maintenance','2026-08-21T12:00:00.000Z')",
			)
			.run(
				id,
				options.org ?? "org",
				options.title ?? id,
				options.disposition ?? "accepted",
				options.workKind ?? "coding",
				options.projectId ?? null,
				options.parentId ?? null,
				options.createdAt ?? NOW,
				options.disposition === "proposed" ? null : (options.createdAt ?? NOW),
			);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), seed };
}

describe("work graph steward canonical detectors", () => {
	it("normalizes case, punctuation, unicode, and whitespace deterministically", () => {
		expect(normalizeWorkItemTitle("  SHIP—Billing!!  ")).toBe("ship billing");
	});

	it("computes token-set Jaccard", () => {
		expect(
			jaccardSimilarity(tokenSet("ship billing now"), tokenSet("ship billing")),
		).toBeCloseTo(2 / 3);
	});

	it("clusters sibling duplicates but not cross-project duplicates", () => {
		const base = {
			workKind: "coding" as const,
			disposition: "accepted" as const,
			parentWorkItemId: null,
			createdAt: OLD,
			updatedAt: null,
		};
		const clusters = clusterDuplicateTitles(
			[
				{ ...base, id: "a", title: "Ship Billing", projectId: "p1" },
				{ ...base, id: "b", title: "ship billing!", projectId: "p1" },
				{ ...base, id: "c", title: "Ship Billing", projectId: "p2" },
			],
			0.85,
		);
		expect(clusters).toHaveLength(1);
		expect(clusters[0]?.workItemIds).toEqual(["a", "b"]);
	});

	it("finds idle accepted specifications without mutating disposition", async () => {
		const { db, seed } = fixture();
		seed("old", { createdAt: OLD });
		seed("recent");
		seed("proposed", { disposition: "proposed", createdAt: OLD });
		const result = await findIdleAcceptedWorkItems(db, {
			orgId: "org",
			now: NOW,
			idleThresholdDays: 14,
		});
		expect(result.findings.map((row) => row.workItemId)).toEqual(["old"]);
		expect(result.findings[0]).toMatchObject({
			disposition: "accepted",
			readiness: "ready",
		});
	});

	it("reports canonical dependency readiness for an idle accepted spec", async () => {
		const { sqlite, db, seed } = fixture();
		seed("blocker");
		seed("idle", { createdAt: OLD });
		sqlite
			.prepare(
				"INSERT INTO work_item_relations VALUES('r','org','blocker','idle','blocks','{}',?)",
			)
			.run(NOW);
		const result = await findIdleAcceptedWorkItems(db, {
			orgId: "org",
			now: NOW,
			idleThresholdDays: 14,
		});
		expect(result.findings).toMatchObject([
			{
				workItemId: "idle",
				disposition: "accepted",
				readiness: "dependencies_blocked",
			},
		]);
	});

	it("finds expired authoritative attempts from the canonical attempt ledger", async () => {
		const { sqlite, db, seed } = fixture();
		seed("work");
		sqlite
			.prepare(
				"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,expires_at,finished_at) VALUES('attempt','work','org','tedi','worker','running',NULL,1,?,?,?,NULL)",
			)
			.run(OLD, OLD, "2026-08-01T00:00:00.000Z");
		expect(
			(await findExpiredAttempts(db, { orgId: "org", now: NOW })).findings,
		).toMatchObject([{ workItemId: "work", attemptId: "attempt" }]);
	});

	it("does not report a live attempt as expired", async () => {
		const { sqlite, db, seed } = fixture();
		seed("work");
		sqlite
			.prepare(
				"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,expires_at,finished_at) VALUES('attempt','work','org','tedi','worker','running',NULL,1,?,?,?,NULL)",
			)
			.run(NOW, NOW, "2026-08-20T13:00:00.000Z");
		expect(
			(await findExpiredAttempts(db, { orgId: "org", now: NOW })).findings,
		).toEqual([]);
	});

	it("full health report combines duplicate and idle findings", async () => {
		const { db, seed } = fixture();
		seed("a", { title: "Ship Billing", createdAt: OLD });
		seed("b", { title: "ship billing!", createdAt: OLD });
		const report = await getWorkGraphHealth(db, {
			orgId: "org",
			now: NOW,
			idleThresholdDays: 14,
		});
		expect(report.counts).toMatchObject({
			duplicateClusters: 1,
			duplicateItems: 1,
			idleAccepted: 2,
			expiredAttempts: 0,
		});
	});

	it("honors organization and project-id scope", async () => {
		const { db, seed } = fixture();
		seed("a", { projectId: "p1", createdAt: OLD });
		seed("b", { projectId: "p2", createdAt: OLD });
		seed("foreign", { org: "other", projectId: "p1", createdAt: OLD });
		const report = await getWorkGraphHealth(db, {
			orgId: "org",
			projectId: "p1",
			now: NOW,
			idleThresholdDays: 14,
		});
		expect(report.scannedCount).toBe(1);
		expect(report.idleAccepted.map((row) => row.workItemId)).toEqual(["a"]);
	});

	it("dry-run never mutates duplicate relations or discussion comments", async () => {
		const { sqlite, db, seed } = fixture();
		seed("a", { title: "Same" });
		seed("b", { title: "same" });
		const outcome = await runWorkGraphSteward(db, {
			orgId: "org",
			now: NOW,
			apply: false,
		});
		expect(outcome.applied).toBe(false);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_item_relations").get(),
		).toEqual({ n: 0 });
	});

	it("uses the action limit to bound expensive detector reads", async () => {
		const { db, seed } = fixture();
		seed("idle-a", { createdAt: OLD });
		seed("idle-b", { createdAt: OLD });
		const outcome = await runWorkGraphSteward(db, {
			orgId: "org",
			now: NOW,
			apply: false,
			limit: 1,
		});
		expect(outcome.report.idleAccepted).toHaveLength(1);
		expect(outcome.report.truncated.idleAccepted).toBe(true);
	});

	it("apply links duplicate observations idempotently", async () => {
		const { sqlite, db, seed } = fixture();
		seed("a", { title: "Same" });
		seed("b", { title: "same" });
		const first = await runWorkGraphSteward(db, {
			orgId: "org",
			now: NOW,
			apply: true,
			actions: ["link_duplicates"],
		});
		const second = await runWorkGraphSteward(db, {
			orgId: "org",
			now: NOW,
			apply: true,
			actions: ["link_duplicates"],
		});
		expect(first.actions.linkedDuplicateRelations).toBe(1);
		expect(second.actions.linkedDuplicateRelations).toBe(0);
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_item_relations WHERE relation_type='duplicates'",
				)
				.get(),
		).toEqual({ n: 1 });
	});

	it("reports orphan project references as coherence defects", async () => {
		const { db, seed } = fixture();
		seed("work", { projectId: "missing" });
		expect(
			(await getWorkGraphHealth(db, { orgId: "org", now: NOW })).naming,
		).toMatchObject([{ workItemId: "work", issue: "orphan_project" }]);
	});
});
