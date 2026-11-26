import { readMigrationFiles } from "drizzle-orm/migrator";
import { fileURLToPath } from "node:url";
import { coreTable } from "../core-store/client";
import { createWorkItem } from "./work-items/crud";
import { createPGliteFacade } from "../test/pglite-facade";
import { gitCommitAliases } from "../schema/git-commit-aliases";
import {
	createCommitResolver,
	canonicalSettlementMetadata,
} from "./git-commit-aliases";
import {
	findRepositoryPushObservations,
	findWorkImplementationPushes,
} from "./repository-observer";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	workItems,
	workItemComments,
	workAttempts,
} from "../schema/work-items";
import { workInteractions } from "../schema/work-factory";
import {
	createRepositoryObservation,
	getRepositoryObservation,
	reportRepositoryObservation,
	claimRepositoryRepair,
	claimRepositoryRetryDelivery,
	overdueRepositoryObservations,
	finishRepositoryObserverEscalation,
	settleAgedRepositoryPushObservations,
	settleRecoveredRepositoryShipObservations,
	pendingRepositoryObservations,
} from "./repository-observer";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [
		gitCommitAliases,
		workItems,
		workItemComments,
		workAttempts,
		workInteractions,
	])
		sqlite.exec(schemaDdl(table));
	const migration = readFileSync(
		new URL(
			"../../drizzle/20260821020828_work_factory_external_session_fences/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	const guard = migration
		.split("--> statement-breakpoint")
		.find((statement) =>
			statement.includes(
				"CREATE TRIGGER `work_items_admission_revision_insert_guard`",
			),
		);
	if (!guard) throw new Error("Work admission revision insert guard missing");
	sqlite.exec(guard);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const event = {
	id: "observation-a",
	orgId: "org-example",
	projectId: "project-example",
	objectiveId: "objective-example",
	ownerTediId: "tedi-example",
	title: "Red Ship abcdef123",
	summary: "Provider failed",
	deadline: "2026-10-17T12:30:00Z",
	now: "2026-10-17T12:00:00Z",
	metadata: {
		repositoryObserver: 1,
		event: {
			kind: "ship_red",
			evidenceUrl: "https://github.com/example/ops/actions/runs/123",
		},
	},
};
describe("repository observation D1 effects", () => {
	it("deduplicates observations, scopes tenant reads, and atomically keeps one comment and diagnosis", async () => {
		const { db, sqlite } = fixture();
		await createRepositoryObservation(db, event);
		await createRepositoryObservation(db, { ...event, summary: "redelivery" });
		expect(
			await getRepositoryObservation(db, "another-org", event.id),
		).toBeNull();
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.description,
		).toBe("Provider failed");
		const report = {
			orgId: event.orgId,
			id: event.id,
			workItemId: event.id,
			authorId: event.ownerTediId,
			body: "First diagnosis",
			report: { diagnosis: "Provider outage", stillRed: true },
			now: event.now,
		};
		await reportRepositoryObservation(db, report);
		await reportRepositoryObservation(db, {
			...report,
			body: "Changed diagnosis",
			report: { diagnosis: "other", stillRed: false },
		});
		expect(sqlite.prepare("SELECT body FROM work_item_comments").all()).toEqual(
			[{ body: "First diagnosis" }],
		);
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.metadata
				?.report,
		).toEqual(report.report);
	});
	it("allows one repair lineage across deliveries and rejects another lesson or tenant", async () => {
		const { db } = fixture();
		await createRepositoryObservation(db, event);
		expect(
			await claimRepositoryRepair(db, event.orgId, event.id, "lesson-a"),
		).toBe(true);
		expect(
			await claimRepositoryRepair(db, event.orgId, event.id, "lesson-a"),
		).toBe(true);
		expect(
			await claimRepositoryRepair(db, event.orgId, event.id, "lesson-b"),
		).toBe(false);
		expect(
			await claimRepositoryRepair(db, "another-org", event.id, "lesson-a"),
		).toBe(false);
	});
	it("finds a missed 30-minute diagnosis and retains red incidents after diagnosis", async () => {
		const { db } = fixture();
		await createRepositoryObservation(db, event);
		expect(
			await overdueRepositoryObservations(db, "2026-10-17T12:29:59Z"),
		).toHaveLength(0);
		expect(
			await overdueRepositoryObservations(db, "2026-10-17T12:30:00Z"),
		).toHaveLength(1);
		await reportRepositoryObservation(db, {
			orgId: event.orgId,
			id: event.id,
			workItemId: event.id,
			authorId: event.ownerTediId,
			body: "Recovered",
			report: { stillRed: false },
			now: event.now,
		});
		expect(
			await overdueRepositoryObservations(db, "2026-10-17T12:31:00Z"),
		).toHaveLength(0);
	});
});

it("delivers a diagnosed retry once, and a changed recipe cannot acquire another attempt", async () => {
	const { db } = fixture();
	await createRepositoryObservation(db, event);
	await reportRepositoryObservation(db, {
		orgId: event.orgId,
		id: event.id,
		workItemId: event.id,
		authorId: event.ownerTediId,
		body: "Known transient failure",
		report: { stillRed: true },
		now: event.now,
	});
	await claimRepositoryRepair(
		db,
		event.orgId,
		event.id,
		"lesson-a",
		"recipe-a",
		"retry",
	);
	expect(
		await claimRepositoryRepair(
			db,
			event.orgId,
			event.id,
			"lesson-a",
			"recipe-b",
			"retry",
		),
	).toBe(false);
	expect(
		await claimRepositoryRetryDelivery(db, "another-org", event.id),
	).toBeNull();
	const delivered = await claimRepositoryRetryDelivery(
		db,
		event.orgId,
		event.id,
	);
	expect(delivered).toBe("https://github.com/example/ops/actions/runs/123");
	expect(
		await claimRepositoryRetryDelivery(db, event.orgId, event.id),
	).toBeNull();
});

const pushMetadata = {
	repositoryObserver: 1,
	event: {
		kind: "push",
		repository: "example/repo",
		branch: "main",
		sha: "a".repeat(40),
	},
};
const reportInput = (id: string, report: { stillRed?: boolean }) => ({
	orgId: event.orgId,
	id,
	workItemId: id,
	authorId: event.ownerTediId,
	body: "Diagnosis",
	report,
	now: event.now,
});
it.each(["ship_red", "ci_red"])(
	"settles %s only on a clear report and preserves first diagnosis",
	async (kind) => {
		const { db } = fixture();
		await createRepositoryObservation(db, {
			...event,
			metadata: { ...pushMetadata, event: { ...pushMetadata.event, kind } },
		});
		await reportRepositoryObservation(
			db,
			reportInput(event.id, { stillRed: true }),
		);
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
		).toBe("proposed");
		await reportRepositoryObservation(db, reportInput(event.id, {}));
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
		).toBe("proposed");
		await reportRepositoryObservation(
			db,
			reportInput(event.id, { stillRed: false }),
		);
		const settled = await getRepositoryObservation(db, event.orgId, event.id);
		expect(settled?.disposition).toBe("cancelled");
		expect(settled?.cancelledAt).toBe(event.now);
		expect(settled?.metadata?.settleReason).toContain("no action needed");
		expect(settled?.metadata?.report).toEqual({ stillRed: true });
		await reportRepositoryObservation(
			db,
			reportInput(event.id, { stillRed: false }),
		);
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.version,
		).toBe(settled?.version);
	},
);
it.each([{}, { stillRed: false }, { stillRed: true }])(
	"settles any push report: %j",
	async (report) => {
		const { db } = fixture();
		await createRepositoryObservation(db, { ...event, metadata: pushMetadata });
		await createRepositoryObservation(db, { ...event, id: "red-incident" });
		await reportRepositoryObservation(db, reportInput(event.id, report));
		expect(
			(await getRepositoryObservation(db, event.orgId, "red-incident"))
				?.disposition,
		).toBe("proposed");
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.metadata
				?.report,
		).toEqual(report);
		expect(
			(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
		).toBe("cancelled");
	},
);
it("reuses Ship surface and step alerts across commits and closes them on recovery", async () => {
	const { db, sqlite } = fixture();
	const runUrl = (run: number) =>
		`https://github.com/example/ops/actions/runs/${run}`;
	const red = (run: number) => ({
		...event,
		id: `ship-${run}`,
		now: `2026-10-17T12:0${run}:00.000Z`,
		metadata: {
			repositoryObserver: 1,
			event: {
				kind: "ship_red",
				repository: "example/repo",
				branch: "main",
				surface: "all",
				sha: String(run).repeat(40),
				evidenceUrl: runUrl(run),
				occurredAt: `2026-10-17T12:0${run}:00.000Z`,
			},
		},
	});
	const step = (run: number, failedJob: string) =>
		createWorkItem(db, {
			id: `${failedJob}-${run}`,
			orgId: event.orgId,
			title: `Investigate ship ${failedJob}`,
			workKind: "incident",
			accountableOwnerType: "tedi",
			accountableOwnerId: event.ownerTediId,
			sourceIntentId: `ship:${failedJob}:${run}`,
			createdAt: red(run).now,
			metadata: {
				source: "cloud-ops-ship",
				failedJob,
				productSha: String(run).repeat(40),
				runUrl: runUrl(run),
			},
		});
	for (const run of [1, 2]) {
		expect((await createRepositoryObservation(db, red(run)))?.id).toBe(
			"ship-1",
		);
		for (const name of ["deploy:api", "contracts"])
			expect((await step(run, name)).id).toBe(`${name}-1`);
	}
	await createRepositoryObservation(db, red(2));
	await step(2, "deploy:api");
	expect(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM work_items WHERE disposition = 'proposed'",
			)
			.get(),
	).toEqual({ n: 3 });
	expect(
		sqlite
			.prepare(
				"SELECT body FROM work_item_comments WHERE work_item_id = 'deploy:api-1'",
			)
			.all(),
	).toEqual([
		{ body: `Ship failed again at ${"2".repeat(40)}.\nRun: ${runUrl(2)}` },
	]);
	const green = {
		orgId: event.orgId,
		projectId: event.projectId,
		repository: "example/repo",
		branch: "main",
		surface: "all",
		shipRepository: "example/ops",
		evidenceUrl: runUrl(3),
		now: "2026-10-17T12:03:00.000Z",
	};
	await settleRecoveredRepositoryShipObservations(db, {
		...green,
		occurredAt: red(1).now,
	});
	expect(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM work_items WHERE disposition = 'proposed'",
			)
			.get(),
	).toEqual({ n: 3 });
	await settleRecoveredRepositoryShipObservations(db, {
		...green,
		green: false,
		recoveredSteps: ["contracts"],
	});
	expect(
		sqlite
			.prepare("SELECT id FROM work_items WHERE disposition = 'cancelled'")
			.all(),
	).toEqual([{ id: "contracts-1" }]);
	await settleRecoveredRepositoryShipObservations(db, green);
	expect(
		sqlite
			.prepare(
				"SELECT count(*) AS n FROM work_items WHERE disposition = 'proposed'",
			)
			.get(),
	).toEqual({ n: 0 });
	await createRepositoryObservation(db, red(4));
	expect((await step(4, "deploy:api")).id).toBe("deploy:api-4");
});
it("appends to the newest open Ship alert within its tenant and failure scope", async () => {
	const { db, sqlite } = fixture();
	const shipEvent = {
		kind: "ship_red",
		repository: "example/repo",
		branch: "main",
		surface: "api",
		sha: "a".repeat(40),
		evidenceUrl: "https://github.com/example/ops/actions/runs/1",
	};
	for (const [id, orgId, metadata, createdAt] of [
		[
			"older",
			event.orgId,
			{ repositoryObserver: 1, event: shipEvent },
			"2026-10-17T10:00:00Z",
		],
		[
			"newest",
			event.orgId,
			{ repositoryObserver: 1, event: shipEvent },
			"2026-10-17T11:00:00Z",
		],
		[
			"other-tenant",
			"other",
			{ repositoryObserver: 1, event: shipEvent },
			"2026-10-17T12:00:00Z",
		],
		[
			"other-surface",
			event.orgId,
			{ repositoryObserver: 1, event: { ...shipEvent, surface: "os" } },
			"2026-10-17T12:00:00Z",
		],
		[
			"older-step",
			event.orgId,
			{
				source: "cloud-ops-ship",
				failedJob: "deploy:api",
				runUrl: shipEvent.evidenceUrl,
			},
			"2026-10-17T10:00:00Z",
		],
		[
			"newest-step",
			event.orgId,
			{
				source: "cloud-ops-ship",
				failedJob: "deploy:api",
				runUrl: shipEvent.evidenceUrl,
			},
			"2026-10-17T11:00:00Z",
		],
		[
			"other-repository",
			event.orgId,
			{
				source: "cloud-ops-ship",
				failedJob: "deploy:api",
				runUrl: "https://github.com/example/other/actions/runs/1",
			},
			"2026-10-17T12:00:00Z",
		],
	] as const)
		await db
			.insert(workItems)
			.values({
				id,
				orgId,
				projectId: event.projectId,
				title: id,
				admissionSpecRevision: crypto.randomUUID(),
				metadata,
				createdAt,
			});
	expect(
		(
			await createRepositoryObservation(db, {
				...event,
				id: "incoming",
				metadata: {
					repositoryObserver: 1,
					event: { ...shipEvent, sha: "b".repeat(40) },
				},
			})
		)?.id,
	).toBe("newest");
	expect(
		(
			await createWorkItem(db, {
				id: "incoming-step",
				orgId: event.orgId,
				title: "Step failure",
				workKind: "incident",
				accountableOwnerType: "tedi",
				accountableOwnerId: event.ownerTediId,
				createdAt: event.now,
				metadata: {
					source: "cloud-ops-ship",
					failedJob: "deploy:api",
					productSha: "b".repeat(40),
					runUrl: shipEvent.evidenceUrl,
				},
			})
		).id,
	).toBe("newest-step");
	expect(
		sqlite
			.prepare(
				"SELECT work_item_id AS id FROM work_item_comments ORDER BY work_item_id",
			)
			.all(),
	).toEqual([{ id: "newest" }, { id: "newest-step" }]);
});
it("closes older red Ship records and shift fixes on the recovered surface", async () => {
	const { db } = fixture();
	const eventFields = {
		kind: "ship_red",
		repository: "example/repo",
		branch: "main",
		surface: "api",
		sha: "a".repeat(40),
		occurredAt: "2026-10-17T11:00:00Z",
	};
	for (const [id, metadata] of [
		["older-red", { repositoryObserver: 1, event: eventFields }],
		[
			"shift-fix",
			{
				repositoryObserver: 1,
				event: { ...eventFields, sha: "b".repeat(40) },
				engShift: { kind: "ci-fix", surface: "ship" },
			},
		],
		[
			"other-surface",
			{
				repositoryObserver: 1,
				event: { ...eventFields, surface: "os" },
			},
		],
		[
			"later-red",
			{
				repositoryObserver: 1,
				event: { ...eventFields, occurredAt: "2026-10-17T13:00:00Z" },
			},
		],
	] as const)
		await createRepositoryObservation(db, { ...event, id, metadata });
	const green = {
		orgId: event.orgId,
		projectId: event.projectId,
		repository: "example/repo",
		branch: "main",
		surface: "api",
		occurredAt: "2026-10-17T12:00:00Z",
		now: event.now,
	};
	await settleRecoveredRepositoryShipObservations(db, {
		...green,
		orgId: "other-org",
	});
	await settleRecoveredRepositoryShipObservations(db, green);
	await settleRecoveredRepositoryShipObservations(db, green);
	for (const id of ["older-red", "shift-fix"])
		expect(
			(await getRepositoryObservation(db, event.orgId, id))?.disposition,
		).toBe("cancelled");
	for (const id of ["other-surface", "later-red"])
		expect(
			(await getRepositoryObservation(db, event.orgId, id))?.disposition,
		).toBe("proposed");
	expect(
		(await getRepositoryObservation(db, event.orgId, "older-red"))?.version,
	).toBe(2);
});
it("ages reported and unreported pushes, excludes red follow-ups and other work, and caps each tick at 100", async () => {
	const { db, sqlite } = fixture();
	for (let i = 0; i < 102; i++)
		await createRepositoryObservation(db, {
			...event,
			id: `push-${i}`,
			metadata: pushMetadata,
		});
	// Legacy reports predate settlement and must drain too.
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = json_set(metadata, '$.report', json('{}')) WHERE id = ?",
		)
		.run("push-1");
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = json_set(metadata, '$.report', json('{\"stillRed\":true}')) WHERE id = ?",
		)
		.run("push-0");
	await createRepositoryObservation(db, {
		...event,
		id: "blocked",
		metadata: {
			...pushMetadata,
			event: { ...pushMetadata.event, sha: "b".repeat(40) },
		},
	});
	await createRepositoryObservation(db, {
		...event,
		id: "red",
		metadata: {
			...pushMetadata,
			event: { ...pushMetadata.event, kind: "ci_red", sha: "b".repeat(40) },
		},
	});
	await createRepositoryObservation(db, {
		...event,
		id: "foreign-red",
		orgId: "other-org",
		metadata: {
			...pushMetadata,
			event: { ...pushMetadata.event, kind: "ship_red" },
		},
	});
	await createRepositoryObservation(db, {
		...event,
		id: "ordinary",
		metadata: {},
	});
	await createRepositoryObservation(db, {
		...event,
		id: "active",
		metadata: pushMetadata,
	});
	// Reproduce rows created before advisory pushes were settled at insertion.
	sqlite.exec(
		"UPDATE work_items SET disposition = 'proposed', cancelled_at = NULL",
	);
	sqlite
		.prepare(
			"INSERT INTO work_attempts (id, org_id, work_item_id, attempt_number, runtime_state, started_at, heartbeat_at, executor_type, executor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run(
			"attempt",
			event.orgId,
			"active",
			1,
			"running",
			event.now,
			event.now,
			"tedi",
			event.ownerTediId,
		);
	expect(
		await settleAgedRepositoryPushObservations(db, "2026-10-18T11:59:59Z"),
	).toHaveLength(0);
	expect(
		await settleAgedRepositoryPushObservations(db, "2026-10-18T12:00:01Z"),
	).toHaveLength(100);
	expect(
		await settleAgedRepositoryPushObservations(db, "2026-10-18T12:00:01Z"),
	).toHaveLength(1);
	expect(
		await settleAgedRepositoryPushObservations(db, "2026-10-18T12:00:01Z"),
	).toHaveLength(0);
	for (const id of ["push-0", "blocked", "red", "ordinary", "active"])
		expect(
			(await getRepositoryObservation(db, event.orgId, id))?.disposition ??
				"proposed",
		).toBe("proposed");
	const row = await getRepositoryObservation(db, event.orgId, "push-1");
	expect(row?.metadata?.settleReason).toContain("24 hours");
	expect(
		(await pendingRepositoryObservations(db, event.orgId, event.projectId)).map(
			(r) => r.id,
		),
	).not.toContain("push-1");
});

it("claims five incidents without overlap and retries failures behind untouched work", async () => {
	const { db } = fixture();
	for (let n = 0; n < 12; n++)
		await createRepositoryObservation(db, { ...event, id: `incident-${n}` });
	const now = "2026-10-17T13:00:00.000Z";
	const first = await overdueRepositoryObservations(db, now);
	expect(first).toHaveLength(5);
	await finishRepositoryObserverEscalation(db, first[0]!, now, "delivered");
	await finishRepositoryObserverEscalation(
		db,
		first[1]!,
		now,
		"observer_timeout",
	);
	expect(
		(await getRepositoryObservation(db, event.orgId, first[1]!.id))?.metadata
			?.observerMaintenanceReason,
	).toBe("observer_timeout");
	const second = await overdueRepositoryObservations(db, now);
	expect(second).toHaveLength(5);
	expect(
		second.some((row) => first.some((previous) => previous.id === row.id)),
	).toBe(false);
	const next = await overdueRepositoryObservations(
		db,
		"2026-10-17T13:05:00.000Z",
	);
	expect(next).toHaveLength(5);
	expect(next.some((row) => row.id === first[0]!.id)).toBe(false);
	expect(
		next.filter(
			(row) => !first.concat(second).some((previous) => previous.id === row.id),
		),
	).toHaveLength(2);
	expect(
		(await getRepositoryObservation(db, event.orgId, first[1]!.id))?.metadata
			?.observerMaintenanceReason,
	).toBe("in_progress");
});

it("skips legacy escalations without closing unresolved red Work", async () => {
	const { db } = fixture();
	await createRepositoryObservation(db, event);
	await db.insert(workInteractions).values({
		id: "legacy-escalation",
		createdAt: event.now,
		orgId: event.orgId,
		workItemId: event.id,
		kind: "coordination",
		subject: "Red Ship",
		prompt: "Decision needed",
		creatorType: "tedi",
		creatorId: event.ownerTediId,
		targetType: "user",
		targetId: "user-example",
		metadata: {
			reason:
				"Red Ship needs a decision after diagnosis or the single repair attempt",
		},
	});
	expect(
		await overdueRepositoryObservations(db, "2026-10-17T13:00:00.000Z"),
	).toHaveLength(0);
	expect(
		(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
	).toBe("proposed");
});

it.each(["completed", "cancelled"])(
	"ages a push after its red follow-up is %s",
	async (disposition) => {
		const { db, sqlite } = fixture();
		await createRepositoryObservation(db, { ...event, metadata: pushMetadata });
		await createRepositoryObservation(db, {
			...event,
			id: "red-follow-up",
			metadata: {
				...pushMetadata,
				event: { ...pushMetadata.event, kind: "ci_red" },
			},
		});
		sqlite.exec(
			"UPDATE work_items SET disposition = 'proposed', cancelled_at = NULL",
		);
		const now = "2026-10-19T12:00:00Z";
		expect(await settleAgedRepositoryPushObservations(db, now)).toHaveLength(0);
		sqlite
			.prepare("UPDATE work_items SET disposition = ? WHERE id = ?")
			.run(disposition, "red-follow-up");
		expect(await settleAgedRepositoryPushObservations(db, now)).toEqual([
			{ id: event.id },
		]);
		expect(
			(await getRepositoryObservation(db, event.orgId, "red-follow-up"))
				?.disposition,
		).toBe(disposition);
		expect(await settleAgedRepositoryPushObservations(db, now)).toHaveLength(0);
	},
);

it("closes the observation beside a report on another Work item, preserving the target", async () => {
	const { db, sqlite } = fixture();
	await createRepositoryObservation(db, {
		...event,
		id: "source-work",
		metadata: {},
	});
	await createRepositoryObservation(db, {
		...event,
		metadata: { ...pushMetadata, targetWorkItemId: "source-work" },
	});
	await reportRepositoryObservation(db, {
		...reportInput(event.id, {}),
		workItemId: "source-work",
	});
	expect(
		(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
	).toBe("cancelled");
	expect(
		sqlite
			.prepare("SELECT disposition FROM work_items WHERE id = ?")
			.get("source-work"),
	).toEqual({ disposition: "proposed" });
	expect(
		sqlite.prepare("SELECT work_item_id FROM work_item_comments").all(),
	).toEqual([{ work_item_id: "source-work" }]);
});

it("records and deduplicates pushes off the open board while preserving pending reviews", async () => {
	const { db, sqlite } = fixture();
	const now = new Date().toISOString();
	const push = { ...event, now, deadline: null, metadata: pushMetadata };
	await createRepositoryObservation(db, push);
	await createRepositoryObservation(db, push);
	await createRepositoryObservation(db, { ...event, id: "red" });
	expect(
		sqlite
			.prepare(
				"SELECT id FROM work_items WHERE disposition IN ('proposed','accepted')",
			)
			.all(),
	).toEqual([{ id: "red" }]);
	const row = await getRepositoryObservation(db, event.orgId, event.id);
	expect(row?.cancelledAt).toBe(now);
	expect(row?.metadata?.event).toEqual(pushMetadata.event);
	expect(
		(await pendingRepositoryObservations(db, event.orgId, event.projectId)).map(
			(r) => r.id,
		),
	).toContain(event.id);
	expect(
		await pendingRepositoryObservations(db, "other-org", event.projectId),
	).toEqual([]);
	await reportRepositoryObservation(db, reportInput(event.id, {}));
	expect(
		(await pendingRepositoryObservations(db, event.orgId, event.projectId)).map(
			(r) => r.id,
		),
	).not.toContain(event.id);
});

it.each(["applied", "not_applicable", "unknown", "not_applied"])(
	"opens push Work only for an unapplied lesson: %s",
	async (verdict) => {
		const { db } = fixture();
		await createRepositoryObservation(db, { ...event, metadata: pushMetadata });
		const report = {
			...reportInput(event.id, {}),
			report: { stillRed: false, lessons: [{ lessonId: "lesson-a", verdict }] },
		};
		await reportRepositoryObservation(db, report);
		await reportRepositoryObservation(db, report);
		const row = await getRepositoryObservation(db, event.orgId, event.id);
		expect(row?.disposition).toBe(
			verdict === "not_applied" ? "proposed" : "cancelled",
		);
		if (verdict === "not_applied") {
			expect(row?.cancelledAt).toBeNull();
			expect(row?.version).toBe(2);
			expect(
				await settleAgedRepositoryPushObservations(db, "2026-10-20T12:00:00Z"),
			).toEqual([]);
		}
	},
);

it("does not revive manually cancelled pushes or review expired advisory records", async () => {
	const { db, sqlite } = fixture();
	await createRepositoryObservation(db, { ...event, metadata: pushMetadata });
	expect(
		await pendingRepositoryObservations(db, event.orgId, event.projectId),
	).toEqual([]);
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = json_set(metadata, '$.settleReason', 'owner cancelled') WHERE id = ?",
		)
		.run(event.id);
	await reportRepositoryObservation(db, {
		...reportInput(event.id, {}),
		report: { lessons: [{ lessonId: "lesson-a", verdict: "not_applied" }] },
	});
	expect(
		(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
	).toBe("cancelled");
});

it("matches two-hop settlement aliases in both push readers without rewriting stored proof", async () => {
	const { db, sqlite } = fixture();
	const oldSha = "a".repeat(40),
		midSha = "e".repeat(40),
		newSha = "b".repeat(40);
	await db.insert(gitCommitAliases).values([
		{ oldSha, newSha: midSha, repository: "example/product" },
		{ oldSha: midSha, newSha, repository: "example/product" },
	]);
	const metadata = { settlement: { mode: "commit", commitShas: [oldSha] } };
	const resolver = createCommitResolver(db);
	expect(await resolver.canonicalCommit(oldSha.slice(0, 7))).toBe(newSha);
	expect(await resolver.canonicalCommit(midSha.slice(0, 7))).toBe(newSha);
	expect(await resolver.aliasesFor(newSha.slice(0, 12))).toEqual([
		newSha,
		midSha,
		oldSha,
	]);
	expect(await canonicalSettlementMetadata(resolver, metadata)).toEqual({
		settlement: { mode: "commit", commitShas: [newSha] },
	});
	expect(metadata.settlement.commitShas).toEqual([oldSha]);
	await createRepositoryObservation(db, {
		...event,
		id: "push",
		metadata: {
			repositoryObserver: 1,
			event: {
				kind: "push",
				sha: newSha,
				commitShas: [newSha],
				workItemId: "delivered",
				branch: "main",
			},
		},
	});
	expect(
		await findWorkImplementationPushes(db, {
			orgId: event.orgId,
			workItemId: "delivered",
			commitShas: metadata.settlement.commitShas,
			since: event.now,
		}),
	).toHaveLength(1);
	expect(
		await findRepositoryPushObservations(db, {
			orgId: event.orgId,
			projectId: event.projectId,
			shas: metadata.settlement.commitShas,
			since: event.now,
		}),
	).toMatchObject([{ sha: newSha, commitShas: [newSha] }]);
	// Reverse direction: old observations remain usable after the rewrite.
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = json_set(metadata, '$.event.sha', ?, '$.event.commitShas', json(?)) WHERE id = 'push'",
		)
		.run(oldSha, JSON.stringify([oldSha]));
	expect(
		await findRepositoryPushObservations(db, {
			orgId: event.orgId,
			projectId: event.projectId,
			shas: [newSha],
			since: event.now,
		}),
	).toMatchObject([{ sha: newSha, commitShas: [newSha] }]);
	await db.insert(gitCommitAliases).values({
		oldSha: "a".repeat(39) + "c",
		newSha: "d".repeat(40),
		repository: "example/product",
	});
	await expect(
		createCommitResolver(db).resolveMany([newSha, oldSha.slice(0, 7)]),
	).rejects.toThrow("Ambiguous");
	sqlite.close();
});

it("resolves a page of two-hop aliases in one read and preserves missing ids", async () => {
	const { db, sqlite } = fixture();
	try {
		const ids = Array.from({ length: 200 }, (_, i) =>
			["a", "b", "c"].map(
				(stage) => stage.repeat(36) + i.toString(16).padStart(4, "0"),
			),
		);
		const insert = sqlite.prepare(
			"INSERT INTO git_commit_aliases(old_sha,new_sha,repository,created_at) VALUES (?,?,?,'2026-01-01')",
		);
		for (const [old, mid, final] of ids) {
			insert.run(old!, mid!, "example/project");
			insert.run(mid!, final!, "example/project");
		}
		const missing = "d".repeat(40);
		const reads = vi.spyOn(db.$client, "prepare");
		const resolver = createCommitResolver(db);
		expect(
			await resolver.resolveMany([...ids.map(([old]) => old!), missing]),
		).toEqual([...ids.map(([, , final]) => final!), missing]);
		expect(reads).toHaveBeenCalledTimes(1);
		expect(await resolver.resolveMany(ids.map(([, mid]) => mid!))).toEqual(
			ids.map(([, , final]) => final!),
		);
		expect(reads).toHaveBeenCalledTimes(1);
	} finally {
		vi.restoreAllMocks();
		sqlite.close();
	}
});

it("bounds alias traversal to four hops, rejects cycles and resolves a dropped chain", async () => {
	const { db, sqlite } = fixture();
	try {
		const ids = ["1", "2", "3", "4", "5", "6"].map((id) => id.repeat(40));
		const insert = sqlite.prepare(
			"INSERT INTO git_commit_aliases(old_sha,new_sha,repository,created_at) VALUES (?,?,?,'2026-01-01')",
		);
		for (let i = 0; i < ids.length - 1; i++)
			insert.run(ids[i]!, ids[i + 1]!, "example/project");
		const reads = vi.spyOn(db.$client, "prepare");
		expect(await createCommitResolver(db).resolveMany([ids[0]!])).toEqual([
			ids[4],
		]);
		expect(reads).toHaveBeenCalledTimes(1);
		insert.run("a".repeat(40), "b".repeat(40), "example/project");
		insert.run("b".repeat(40), "0".repeat(40), "example/project");
		expect(await createCommitResolver(db).canonicalCommit("a".repeat(40))).toBe(
			"0".repeat(40),
		);
		sqlite
			.prepare("UPDATE git_commit_aliases SET new_sha=? WHERE old_sha=?")
			.run("a".repeat(40), "b".repeat(40));
		await expect(
			createCommitResolver(db).resolveMany(["a".repeat(40)]),
		).rejects.toThrow("Cyclic");
	} finally {
		vi.restoreAllMocks();
		sqlite.close();
	}
});

it("preserves observer diagnosis, tenant fences and retry claims on faithful Postgres DDL", async () => {
	const fixture = await createPGliteFacade();
	const { db, engine } = fixture;
	try {
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await engine.exec(ddl);
		await engine.query(
			"INSERT INTO organizations(id,name,slug) VALUES ($1,'Example','example'),('other','Other','other')",
			[event.orgId],
		);
		await engine.query(
			"INSERT INTO projects(id,org_id,key,name,created_at) VALUES ($1,$2,'EX','Example',$3)",
			[event.projectId, event.orgId, event.now],
		);
		await createRepositoryObservation(db, { ...event, objectiveId: null });
		expect(
			await pendingRepositoryObservations(db, event.orgId, event.projectId),
		).toHaveLength(1);
		expect(
			await pendingRepositoryObservations(db, "other", event.projectId),
		).toEqual([]);
		expect(
			await overdueRepositoryObservations(db, "2026-10-17T12:30:00Z"),
		).toHaveLength(1);
		const report = {
			orgId: event.orgId,
			id: event.id,
			workItemId: event.id,
			authorId: event.ownerTediId,
			body: "First diagnosis",
			report: { stillRed: true, diagnosis: "Provider outage" },
			now: event.now,
		};
		const batches = vi.spyOn(db, "batch");
		await reportRepositoryObservation(db, report);
		expect(batches).toHaveBeenCalledTimes(1);
		expect(await claimRepositoryRepair(db, "other", event.id, "lesson")).toBe(
			false,
		);
		expect(
			await claimRepositoryRepair(
				db,
				event.orgId,
				event.id,
				"lesson",
				"recipe",
				"retry",
			),
		).toBe(true);
		expect(
			await claimRepositoryRepair(db, event.orgId, event.id, "other-lesson"),
		).toBe(false);
		await reportRepositoryObservation(db, {
			...report,
			body: "Second diagnosis",
			report: { stillRed: false },
		});
		const row = await getRepositoryObservation(db, event.orgId, event.id);
		expect(row?.metadata?.report).toEqual(report.report);
		expect(row?.metadata?.latestReport).toEqual({ stillRed: false });
		expect(row?.metadata?.repairKey).toBe("recipe");
		expect(row?.disposition).toBe("cancelled");
		expect(
			await db.select().from(coreTable(db, workItemComments)),
		).toMatchObject([{ body: "First diagnosis" }]);
		expect(
			await overdueRepositoryObservations(db, "2026-10-17T12:36:00Z"),
		).toEqual([]);
		await createRepositoryObservation(db, {
			...event,
			id: "json-null",
			objectiveId: null,
			metadata: { ...event.metadata, report: null },
		});
		expect(
			(
				await pendingRepositoryObservations(db, event.orgId, event.projectId)
			).map((row) => row.id),
		).toEqual(["json-null"]);
		const pushed = {
			kind: "push",
			repository: "example/app",
			branch: "main",
			sha: "a".repeat(40),
		};
		await createRepositoryObservation(db, {
			...event,
			id: "old-push",
			objectiveId: null,
			metadata: { repositoryObserver: 1, event: pushed },
		});
		await engine.query(
			"UPDATE work_items SET disposition='proposed' WHERE id='old-push'",
		);
		await createRepositoryObservation(db, {
			...event,
			id: "red-followup",
			objectiveId: null,
			metadata: {
				repositoryObserver: 1,
				event: { ...pushed, kind: "ship_red", surface: "api" },
			},
		});
		expect(
			await settleAgedRepositoryPushObservations(db, "2026-10-19T12:00:00Z"),
		).toEqual([]);
		expect(
			await settleRecoveredRepositoryShipObservations(db, {
				orgId: event.orgId,
				projectId: event.projectId,
				repository: "example/app",
				branch: "main",
				surface: "api",
				now: "2026-10-19T12:00:00Z",
			}),
		).toEqual([{ id: "red-followup" }]);
		expect(
			await settleAgedRepositoryPushObservations(db, "2026-10-19T12:00:00Z"),
		).toEqual([{ id: "old-push" }]);
	} finally {
		vi.restoreAllMocks();
		await fixture.close();
	}
}, 30000);
