import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getRunArtifact,
	listRunWorkflowCallArtifacts,
	listRunWorkflowRuntimeObservationsForRuns,
	listRunWorkflowStepArtifacts,
	recordRunArtifact,
} from "./skill-run-artifacts";
import { sha256Hex } from "@tedix/worker-kit/crypto";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE skill_run_artifacts (
			id TEXT PRIMARY KEY NOT NULL,
			run_id TEXT NOT NULL,
			path TEXT NOT NULL,
			mime_type TEXT NOT NULL DEFAULT 'application/json',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			content_inline TEXT,
			content_r2_key TEXT,
			sha256 TEXT,
			attempt INTEGER NOT NULL DEFAULT 1,
			outcome TEXT NOT NULL DEFAULT 'success',
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			UNIQUE(run_id, path)
		);
	`);
	const insert = sqlite.prepare(`
		INSERT INTO skill_run_artifacts
			(id, run_id, path, content_inline, attempt, created_at)
		VALUES (?, 'run-1', ?, '{}', ?, ?)
	`);
	return { db: createDbClient(createD1Facade(sqlite)), insert };
}

describe("skill run artifact content addressing", () => {
	it("content-addresses inline writes without any caller change", async () => {
		const { db } = fixture();
		const created = await recordRunArtifact(db, {
			runId: "run-1",
			path: "evidence/scrape.json",
			value: { price: 42 },
		});
		// The digest is over the serialized bytes actually persisted.
		expect(created.sha256).toBe(await sha256Hex('{"price":42}'));
		expect(created.contentInline).toBe('{"price":42}');

		const read = await getRunArtifact(db, "run-1", "evidence/scrape.json");
		expect(read?.sha256).toBe(await sha256Hex('{"price":42}'));
	});

	it("re-hashes a mutable path so the digest always describes current bytes", async () => {
		const { db } = fixture();
		await recordRunArtifact(db, {
			runId: "run-1",
			path: "timeline.json",
			value: { events: [] },
		});
		const updated = await recordRunArtifact(db, {
			runId: "run-1",
			path: "timeline.json",
			value: { events: ["step-1"] },
		});
		// Upsert-in-place: one row, digest tracks the new bytes — a stale digest
		// would be worse than none, since it would falsely "prove" old evidence.
		expect(updated.sha256).toBe(await sha256Hex('{"events":["step-1"]}'));
		expect(updated.sha256).not.toBe(await sha256Hex('{"events":[]}'));
	});

	it("persists the caller's digest for R2-spilled bytes it never sees", async () => {
		const { db } = fixture();
		const bytes = "x".repeat(20_000);
		const digest = await sha256Hex(bytes);
		const created = await recordRunArtifact(db, {
			runId: "run-1",
			path: "evidence/large.json",
			value: null,
			r2Key: "run-1/evidence/large.json",
			sizeBytes: bytes.length,
			sha256: digest,
		});
		expect(created.sha256).toBe(digest);
		expect(created.contentInline).toBeNull();
		expect(created.contentR2Key).toBe("run-1/evidence/large.json");
	});
});

describe("skill workflow artifact pages", () => {
	it("selects executed, compatible, and blocked runtime observations", async () => {
		const { db, insert } = fixture();
		const hash = "a".repeat(64);
		const paths = [
			`epochs/0/manifests/${hash}.json`,
			`epochs/0/runtime-compatible/${hash}.json`,
			`epochs/0/runtime-drift/${hash}.json`,
			"epochs/0/runtime-pin.json",
		];
		for (const [index, path] of paths.entries()) {
			insert.run(
				`runtime-${index}`,
				path,
				1,
				`2026-07-12T00:00:0${index}.000Z`,
			);
		}

		expect(
			(await listRunWorkflowRuntimeObservationsForRuns(db, ["run-1"])).map(
				(row) => row.path,
			),
		).toEqual(paths.slice(0, 3));
	});

	it("applies exact step-name filtering before SQL pagination", async () => {
		const { db, insert } = fixture();
		for (let index = 0; index < 600; index++) {
			insert.run(
				`other-${index}`,
				`epochs/0/steps/x:other/1/attempts/${index + 1}.json`,
				index + 1,
				`2026-07-11T00:${String(index).padStart(4, "0")}`,
			);
		}
		insert.run(
			"target-1",
			"epochs/0/steps/x:target/1/attempts/1.json",
			1,
			"2026-07-12T00:00:00.000Z",
		);
		insert.run(
			"target-2",
			"epochs/0/steps/x:target/1/attempts/2.json",
			2,
			"2026-07-12T00:00:01.000Z",
		);

		const first = await listRunWorkflowStepArtifacts(db, "run-1", {
			stepName: "target",
			kind: "attempt",
			limit: 1,
			offset: 0,
		});
		const second = await listRunWorkflowStepArtifacts(db, "run-1", {
			stepName: "target",
			kind: "attempt",
			limit: 1,
			offset: 1,
		});
		expect(first.map((row) => row.path)).toEqual([
			"epochs/0/steps/x:target/1/attempts/1.json",
		]);
		expect(second.map((row) => row.path)).toEqual([
			"epochs/0/steps/x:target/1/attempts/2.json",
		]);
	});

	it("uses the runtime's dot-safe step segment for SQL-first filtering", async () => {
		const { db, insert } = fixture();
		insert.run(
			"dot-step",
			"epochs/0/steps/x:report%2Epublish/1/attempts/1.json",
			1,
			"2026-07-12T00:00:00.000Z",
		);
		insert.run(
			"double-dot-step",
			"epochs/0/steps/x:hidden%2E%2Estep/1/attempts/1.json",
			1,
			"2026-07-12T00:00:01.000Z",
		);

		expect(
			(
				await listRunWorkflowStepArtifacts(db, "run-1", {
					stepName: "report.publish",
				})
			).map((row) => row.path),
		).toEqual(["epochs/0/steps/x:report%2Epublish/1/attempts/1.json"]);
		expect(
			(
				await listRunWorkflowStepArtifacts(db, "run-1", {
					stepName: "hidden..step",
				})
			).map((row) => row.path),
		).toEqual(["epochs/0/steps/x:hidden%2E%2Estep/1/attempts/1.json"]);
	});

	it("applies step and attempt filters before tool-call pagination", async () => {
		const { db, insert } = fixture();
		for (let index = 0; index < 550; index++) {
			insert.run(
				`call-${index}`,
				`epochs/0/steps/x:other/1/attempts/1/calls/run/${index + 1}.json`,
				1,
				`2026-07-11T00:${String(index).padStart(4, "0")}`,
			);
		}
		insert.run(
			"late-call",
			"epochs/0/steps/x:target/1/attempts/3/calls/run/1.json",
			3,
			"2026-07-12T00:00:00.000Z",
		);

		const rows = await listRunWorkflowCallArtifacts(db, "run-1", {
			stepName: "target",
			attempt: 3,
			limit: 10,
		});
		expect(rows.map((row) => row.path)).toEqual([
			"epochs/0/steps/x:target/1/attempts/3/calls/run/1.json",
		]);
	});

	it("does not project timeline summaries as step or call evidence", async () => {
		const { db, insert } = fixture();
		insert.run("timeline", "timeline.json", 1, "2026-07-11T00:00:00.000Z");
		expect(await listRunWorkflowStepArtifacts(db, "run-1")).toEqual([]);
		expect(await listRunWorkflowCallArtifacts(db, "run-1")).toEqual([]);
	});
});
