import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getRunArtifact,
	listRunArtifacts,
	listRunArtifactsPage,
	listRunTimelineArtifacts,
	listRunWorkflowCallArtifacts,
	listRunWorkflowRuntimeObservationsForRuns,
	listRunWorkflowStepArtifacts,
	R2_BODY_THRESHOLD_BYTES,
	recordRunArtifact,
} from "./skill-run-artifacts";
import { sha256Hex } from "@tedix/worker-kit/crypto";

function fixture(onPrepare?: (query: string) => void) {
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
	const binding = createD1Facade(sqlite, { onPrepare });
	return { db: createDbClient(binding), insert, binding, sqlite };
}

describe("skill run artifact overload recovery", () => {
	afterEach(() => vi.useRealTimers());
	const overload = () =>
		new Error("Failed query: select artifact", {
			cause: new Error("D1_ERROR: Database is overloaded"),
		});

	it("continues the artifact read after one overload in a logs store", async () => {
		vi.useFakeTimers();
		const main = fixture();
		let reads = 0;
		const logs = fixture(() => {
			if (++reads === 1) throw overload();
		});
		logs.insert.run("saved", "steps/search.json", 1, "2026-01-01");
		configureLogStore(main.db, { LOGS_DB: logs.binding });
		const result = getRunArtifact(
			main.db,
			{ organizationId: "org-1" },
			"run-1",
			"steps/search.json",
		);
		await vi.advanceTimersByTimeAsync(999);
		expect(reads).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await result)?.id).toBe("saved");
		expect(reads).toBe(2);
	});

	it("recovers the pre-upsert read without repeating the artifact upload", async () => {
		const value = "x".repeat(5_000);
		const sha256 = await sha256Hex(JSON.stringify(value));
		vi.useFakeTimers();
		let reads = 0;
		const { db } = fixture((query) => {
			if (/^select/i.test(query) && ++reads === 1) throw overload();
		});
		const put = vi.fn(async () => null);
		const result = recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "large.json",
				value,
				sha256,
			},
			{ put } as unknown as R2Bucket,
		);
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await result).contentR2Key).toBeTruthy();
		expect(reads).toBe(2);
		expect(put).toHaveBeenCalledTimes(1);
	});

	it("stops a sustained outage with the D1 cause in the engine-visible message", async () => {
		vi.useFakeTimers();
		const read = vi.fn(() => {
			throw overload();
		});
		const { db } = fixture(read);
		// Cloudflare retains only name and message, not Error.cause.
		const result = getRunArtifact(
			db,
			{ organizationId: "org-1" },
			"run-1",
			"steps/search.json",
		).catch((error) => ({
			name: error.name,
			message: error.message,
		}));
		for (const delay of [1_000, 2_000, 4_000, 8_000]) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			const calls = read.mock.calls.length;
			await vi.advanceTimersByTimeAsync(1);
			expect(read).toHaveBeenCalledTimes(calls + 1);
		}
		expect(await result).toEqual({
			name: "Error",
			message:
				"D1_OVERLOADED: artifact read failed after 5 attempts (15 seconds of backoff)",
		});
		expect(read).toHaveBeenCalledTimes(5);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["D1_ERROR: no such table", "upstream overloaded"])(
		"does not retry %s",
		async (message) => {
			vi.useFakeTimers();
			const error = new Error(message);
			const read = vi.fn(() => {
				throw error;
			});
			const { db } = fixture(read);
			await expect(
				getRunArtifact(
					db,
					{ organizationId: "org-1" },
					"run-1",
					"missing.json",
				),
			).rejects.toMatchObject({ cause: error });
			expect(read).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe("skill run artifact content addressing", () => {
	it("content-addresses inline writes without any caller change", async () => {
		const { db } = fixture();
		const created = await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "evidence/scrape.json",
				value: { price: 42 },
			},
		);
		// The digest is over the serialized bytes actually persisted.
		expect(created.sha256).toBe(await sha256Hex('{"price":42}'));
		expect(created.contentInline).toBe('{"price":42}');

		const read = await getRunArtifact(
			db,
			{ organizationId: "org-1" },
			"run-1",
			"evidence/scrape.json",
		);
		expect(read?.sha256).toBe(await sha256Hex('{"price":42}'));
	});

	it("updates the row a concurrent writer saved between the read and the insert", async () => {
		let raced = false;
		let insertRow: ((...args: unknown[]) => unknown) | null = null;
		const { db, insert, binding } = fixture((query) => {
			if (!raced && /^insert into "skill_run_artifacts"/i.test(query.trim())) {
				raced = true;
				insertRow?.("art-other", "steps/judge.json", 1, "2026-11-05 21:44:00");
			}
		});
		insertRow = (...args) =>
			insert.run(...(args as [string, string, number, string]));
		const saved = await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "steps/judge.json",
				value: { ok: true },
				attempt: 2,
			},
		);
		expect(saved.id).toBe("art-other");
		expect(saved.contentInline).toBe('{"ok":true}');
		expect(saved.attempt).toBe(2);
		void binding;
	});

	it("re-hashes a mutable path so the digest always describes current bytes", async () => {
		const { db } = fixture();
		await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "timeline.json",
				value: { events: [] },
			},
		);
		const updated = await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "timeline.json",
				value: { events: ["step-1"] },
			},
		);
		// Upsert-in-place: one row, digest tracks the new bytes — a stale digest
		// would be worse than none, since it would falsely "prove" old evidence.
		expect(updated.sha256).toBe(await sha256Hex('{"events":["step-1"]}'));
		expect(updated.sha256).not.toBe(await sha256Hex('{"events":[]}'));
	});

	it("persists the caller's digest for R2-spilled bytes it never sees", async () => {
		const { db } = fixture();
		const bytes = "x".repeat(20_000);
		const digest = await sha256Hex(bytes);
		const created = await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "run-1",
				path: "evidence/large.json",
				value: null,
				r2Key: "run-1/evidence/large.json",
				sizeBytes: bytes.length,
				sha256: digest,
			},
		);
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
			(
				await listRunWorkflowRuntimeObservationsForRuns(
					db,
					{ organizationId: "org-1" },
					["run-1"],
				)
			).map((row) => row.path),
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

		const first = await listRunWorkflowStepArtifacts(
			db,
			{ organizationId: "org-1" },
			"run-1",
			{
				stepName: "target",
				kind: "attempt",
				limit: 1,
				offset: 0,
			},
		);
		const second = await listRunWorkflowStepArtifacts(
			db,
			{ organizationId: "org-1" },
			"run-1",
			{
				stepName: "target",
				kind: "attempt",
				limit: 1,
				offset: 1,
			},
		);
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
				await listRunWorkflowStepArtifacts(
					db,
					{ organizationId: "org-1" },
					"run-1",
					{
						stepName: "report.publish",
					},
				)
			).map((row) => row.path),
		).toEqual(["epochs/0/steps/x:report%2Epublish/1/attempts/1.json"]);
		expect(
			(
				await listRunWorkflowStepArtifacts(
					db,
					{ organizationId: "org-1" },
					"run-1",
					{
						stepName: "hidden..step",
					},
				)
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

		const rows = await listRunWorkflowCallArtifacts(
			db,
			{ organizationId: "org-1" },
			"run-1",
			{
				stepName: "target",
				attempt: 3,
				limit: 10,
			},
		);
		expect(rows.map((row) => row.path)).toEqual([
			"epochs/0/steps/x:target/1/attempts/3/calls/run/1.json",
		]);
	});

	it("does not project timeline summaries as step or call evidence", async () => {
		const { db, insert } = fixture();
		insert.run("timeline", "timeline.json", 1, "2026-07-11T00:00:00.000Z");
		expect(
			await listRunWorkflowStepArtifacts(
				db,
				{ organizationId: "org-1" },
				"run-1",
			),
		).toEqual([]);
		expect(
			await listRunWorkflowCallArtifacts(
				db,
				{ organizationId: "org-1" },
				"run-1",
			),
		).toEqual([]);
	});
});

it("keeps small bodies inline and uploads bodies over 4 KiB before committing a pointer", async () => {
	const { db } = fixture();
	const objects = new Map<string, string>();
	const bucket = {
		put: async (key: string, value: string) => {
			objects.set(key, value);
		},
	} as unknown as R2Bucket;
	const small = await recordRunArtifact(
		db,
		{ organizationId: "org-1" },
		{ runId: "run-1", path: "small.json", value: { ok: true } },
		bucket,
	);
	expect(small.contentInline).toBe('{"ok":true}');
	expect(small.contentR2Key).toBeNull();
	expect(objects.size).toBe(0);
	const body = { text: "x".repeat(R2_BODY_THRESHOLD_BYTES) };
	const large = await recordRunArtifact(
		db,
		{ organizationId: "org-1" },
		{ runId: "run-1", path: "large.json", value: body },
		bucket,
	);
	expect(large.contentInline).toBeNull();
	expect(large.sizeBytes).toBeGreaterThan(R2_BODY_THRESHOLD_BYTES);
	expect(objects.get(large.contentR2Key!)).toBe(JSON.stringify(body));
	expect(large.sha256).toBe(await sha256Hex(JSON.stringify(body)));
	await expect(
		recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{ runId: "run-1", path: "failed.json", value: body },
			{
				put: async () => {
					throw new Error("unavailable");
				},
			} as unknown as R2Bucket,
		),
	).rejects.toThrow("unavailable");
	expect(
		await getRunArtifact(
			db,
			{ organizationId: "org-1" },
			"run-1",
			"failed.json",
		),
	).toBeNull();
});

describe("compact timeline artifact reads", () => {
	it("reads over 128 inline rows in one query and filters the run and exact epoch", async () => {
		const { db, insert } = fixture();
		const createdAt = "2026-01-01T00:00:00Z";
		for (let index = 0; index < 300; index++) {
			insert.run(
				`event-${index}`,
				`timeline/epochs/3/steps/${index}.json`,
				1,
				createdAt,
			);
		}
		insert.run("marker", "timeline/epochs/3/coverage.json", 1, createdAt);
		insert.run("previous", "timeline/epochs/2/steps/old.json", 1, createdAt);
		insert.run(
			"next-prefix",
			"timeline/epochs/30/steps/other.json",
			1,
			createdAt,
		);
		insert.run("original", "epochs/3/steps/original.json", 1, createdAt);
		await recordRunArtifact(
			db,
			{ organizationId: "org-1" },
			{
				runId: "other-run",
				path: "timeline/epochs/3/steps/other.json",
				value: { other: true },
			},
		);
		const rows = await listRunTimelineArtifacts(
			db,
			{ organizationId: "org-1" },
			"run-1",
			3,
		);
		expect(rows).toHaveLength(301);
		expect(
			rows.every(
				(row) => row.contentInline === "{}" && row.contentR2Key === null,
			),
		).toBe(true);
		expect(rows.some((row) => row.path.endsWith("coverage.json"))).toBe(true);
		expect(
			rows.every(
				(row) =>
					row.runId === "run-1" && row.path.startsWith("timeline/epochs/3/"),
			),
		).toBe(true);
		expect(
			await listRunTimelineArtifacts(
				db,
				{ organizationId: "org-1" },
				"run-1",
				4,
			),
		).toEqual([]);
	});
});

describe("artifact reads across retention stores", () => {
	it.each([
		{ timing: "same second", order: [0, 1, 2, 3, 4, 5] },
		{ timing: "crosses a second boundary", order: [0, 1, 5, 2, 3, 4] },
	])(
		"merges five moved artifacts, preserves R2 pointers and paginates after deduplication ($timing)",
		async ({ timing, order }) => {
			const main = fixture();
			const logs = fixture();
			let createdAt = "2026-01-01 00:00:00";
			// SQLite owns CURRENT_TIMESTAMP; JavaScript fake timers do not control it.
			logs.sqlite.function("current_timestamp", () => createdAt);
			const moved = [];
			for (let index = 0; index < 5; index++) {
				if (timing === "crosses a second boundary" && index === 2) {
					createdAt = "2026-01-01 00:00:01";
				}
				moved.push(
					await recordRunArtifact(
						logs.db,
						{ organizationId: "org-1" },
						{
							runId: "run-1",
							path: `evidence/${index}.json`,
							value: null,
							r2Key: `run-1/bodies/moved-${index}`,
							sizeBytes: 8192,
							sha256: "a".repeat(64),
						},
					),
				);
			}
			main.insert.run(moved[0]!.id, "evidence/0.json", 1, moved[0]!.createdAt);
			// This row shares the first write's timestamp, even if later writes cross a second.
			main.insert.run("main-only", "evidence/5.json", 1, moved[0]!.createdAt);
			configureLogStore(main.db, { LOGS_DB: logs.binding });
			const all = await listRunArtifacts(
				main.db,
				{ organizationId: "org-1" },
				"run-1",
			);
			expect(all.map((row) => row.path)).toEqual(
				order.map((index) => `evidence/${index}.json`),
			);
			expect(all[0]?.contentInline).toBe("{}");
			for (const artifact of moved) {
				const read = await getRunArtifact(
					main.db,
					{ organizationId: "org-1" },
					"run-1",
					artifact.path,
				);
				expect(read?.id).toBe(artifact.id);
				if (artifact !== moved[0]) {
					expect(read?.contentR2Key).toBe(artifact.contentR2Key);
					expect(read?.sha256).toBe(artifact.sha256);
				}
			}
			expect(
				(
					await listRunArtifactsPage(
						main.db,
						{ organizationId: "org-1" },
						"run-1",
						{ limit: 3, offset: 2 },
					)
				).map((row) => row.path),
			).toEqual(order.slice(2, 5).map((index) => `evidence/${index}.json`));
			expect(
				await listRunArtifacts(
					main.db,
					{ organizationId: "org-1" },
					"run-other",
				),
			).toEqual([]);
		},
	);
});
