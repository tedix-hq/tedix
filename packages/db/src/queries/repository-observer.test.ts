import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
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
	settleRecoveredRepositoryObservation,
	pendingRepositoryObservations,
	claimRepositoryObserverWake,
	deferRepositoryObserverWake,
	deferredRepositoryPushObservations,
	releaseRepositoryObserverWake,
} from "./repository-observer";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [
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
it("settles recovery idempotently and scopes it to the observer tenant", async () => {
	const { db } = fixture();
	await createRepositoryObservation(db, event);
	await settleRecoveredRepositoryObservation(
		db,
		"other-org",
		event.id,
		event.now,
	);
	expect(
		(await getRepositoryObservation(db, event.orgId, event.id))?.disposition,
	).toBe("proposed");
	await settleRecoveredRepositoryObservation(
		db,
		event.orgId,
		event.id,
		event.now,
	);
	await settleRecoveredRepositoryObservation(
		db,
		event.orgId,
		event.id,
		event.now,
	);
	const row = await getRepositoryObservation(db, event.orgId, event.id);
	expect(row?.disposition).toBe("cancelled");
	expect(row?.version).toBe(2);
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

it("bounds concurrent push wakes per project, atomically and across redeliveries", async () => {
	const { db } = fixture();
	const now = "2026-10-25T16:00:00.000Z";
	const later = "2026-10-25T16:10:00.000Z";
	for (const id of ["push-a", "push-b", "push-c"])
		await createRepositoryObservation(db, {
			...event,
			id,
			now: new Date().toISOString(),
			deadline: null,
			metadata: pushMetadata,
		});
	const claim = (id: string, at = now, limit: number | null = 2) =>
		claimRepositoryObserverWake(db, {
			orgId: event.orgId,
			projectId: event.projectId,
			id,
			now: at,
			limit,
		});
	const [a, b, c] = await Promise.all([
		claim("push-a"),
		claim("push-b"),
		claim("push-c"),
	]);
	expect([a, b, c].filter(Boolean)).toHaveLength(2);
	const waiting = !a ? "push-a" : !b ? "push-b" : "push-c";
	const holder = waiting === "push-a" ? "push-b" : "push-a";
	// A redelivery of a woken observation keeps its slot.
	expect(await claim(holder, later)).toBe(true);
	expect(await claim(waiting, later)).toBe(false);
	await deferRepositoryObserverWake(db, {
		orgId: event.orgId,
		id: waiting,
		now: later,
	});
	expect(
		(await deferredRepositoryPushObservations(db)).map((row) => row.id),
	).toEqual([waiting]);
	// Red incidents are never deferred, and their turns take a slot too.
	await createRepositoryObservation(db, { ...event, id: "red" });
	expect(await claim("red", later, null)).toBe(true);
	await reportRepositoryObservation(db, reportInput(holder, {}));
	expect(await claim(waiting, later)).toBe(false);
	// A report frees the slot for the deferred push.
	await reportRepositoryObservation(db, reportInput("red", { stillRed: true }));
	expect(await claim(waiting, later)).toBe(true);
	expect(await deferredRepositoryPushObservations(db)).toEqual([]);
	// Slots of turns that never reported expire after the wake window.
	await createRepositoryObservation(db, {
		...event,
		id: "push-d",
		now: new Date().toISOString(),
		deadline: null,
		metadata: pushMetadata,
	});
	expect(await claim("push-d", later)).toBe(false);
	expect(await claim("push-d", "2026-10-25T16:41:00.000Z")).toBe(true);
	// A wake that never reached the owner gives its slot back and stays deferred.
	await releaseRepositoryObserverWake(db, {
		orgId: event.orgId,
		id: "push-d",
		now: later,
	});
	expect(
		(await deferredRepositoryPushObservations(db)).map((row) => row.id),
	).toEqual(["push-d"]);
	expect(
		await claimRepositoryObserverWake(db, {
			orgId: "other-org",
			projectId: event.projectId,
			id: "push-d",
			now: later,
			limit: 2,
		}),
	).toBe(false);
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
	await deferRepositoryObserverWake(db, {
		orgId: event.orgId,
		id: event.id,
		now: event.now,
	});
	expect(await deferredRepositoryPushObservations(db)).toEqual([]);
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
