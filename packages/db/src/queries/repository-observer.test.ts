import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { workItems, workItemComments } from "../schema/work-items";
import {
	createRepositoryObservation,
	getRepositoryObservation,
	reportRepositoryObservation,
	claimRepositoryRepair,
	claimRepositoryRetryDelivery,
	overdueRepositoryObservations,
} from "./repository-observer";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [workItems, workItemComments])
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
