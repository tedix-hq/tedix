import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { organizations } from "@tedix/db/schema/organizations";
import { projects } from "@tedix/db/schema/projects";
import { tediObjectives } from "@tedix/db/schema/tedi-objectives";
import { tedis } from "@tedix/db/schema/tedis";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { fileRecurringWork, recurringWorkPeriod } from "./recurring-work";

const ORG = "org-fictional-books";

function fixture(recurringWork: unknown[]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			organizations,
			projects,
			tediObjectives,
			tedis,
			workItems,
			workEvents,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
		.run(ORG, "Fictional Books", "fictional-books");
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			"project-books",
			ORG,
			"books",
			"Books",
			"active",
			JSON.stringify({ recurringWork }),
			"2026-09-01T00:00:00.000Z",
		);
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			"project-plain",
			ORG,
			"plain",
			"Plain",
			"active",
			"{}",
			"2026-09-01T00:00:00.000Z",
		);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

const receipts = {
	key: "meal-receipts",
	title: "Meal receipts {month}",
	description: "Collect the month's meal receipts.",
	doneWhen: "Every receipt has an occasion and guests.",
	owner: { type: "tedi", id: "tedi-books" },
	cadence: "monthly",
	dayOfMonth: 3,
};

afterEach(() => vi.restoreAllMocks());

describe("recurring work", () => {
	it("is due from its day of the month", () => {
		expect(
			recurringWorkPeriod(new Date("2026-11-02T23:00:00.000Z"), 3),
		).toBeNull();
		expect(
			recurringWorkPeriod(new Date("2026-11-03T00:00:00.000Z"), 3),
		).toEqual({
			key: "2026-11",
			label: "November 2026",
			endsAt: "2026-12-01T00:00:00.000Z",
		});
	});

	it("files one item per template and month, never twice", async () => {
		const { sqlite, db } = fixture([receipts]);
		try {
			const early = await fileRecurringWork(
				db,
				new Date("2026-11-02T10:00:00.000Z"),
			);
			expect(early).toEqual({ filed: 0, existing: 0, failed: 0 });

			const first = await fileRecurringWork(
				db,
				new Date("2026-11-03T10:00:00.000Z"),
			);
			const again = await fileRecurringWork(
				db,
				new Date("2026-11-20T10:00:00.000Z"),
			);
			expect(first).toEqual({ filed: 1, existing: 0, failed: 0 });
			expect(again).toEqual({ filed: 0, existing: 1, failed: 0 });

			const rows = sqlite
				.prepare(
					"SELECT title, description, disposition, project_id, accountable_owner_type, accountable_owner_id, source_intent_id, work_class FROM work_items",
				)
				.all();
			expect(rows).toEqual([
				{
					title: "Meal receipts November 2026",
					description:
						"Collect the month's meal receipts.\n\nDone when: Every receipt has an occasion and guests.",
					disposition: "proposed",
					project_id: "project-books",
					accountable_owner_type: "tedi",
					accountable_owner_id: "tedi-books",
					source_intent_id: "recurring:project-books:meal-receipts:2026-11",
					work_class: "maintenance",
				},
			]);

			const next = await fileRecurringWork(
				db,
				new Date("2026-12-05T10:00:00.000Z"),
			);
			expect(next.filed).toBe(1);
			expect(
				sqlite.prepare("SELECT title FROM work_items ORDER BY title").all(),
			).toEqual([
				{ title: "Meal receipts December 2026" },
				{ title: "Meal receipts November 2026" },
			]);
		} finally {
			sqlite.close();
		}
	});

	it("skips disabled templates and counts invalid metadata", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const disabled = fixture([{ ...receipts, enabled: false }]);
		try {
			expect(
				await fileRecurringWork(
					disabled.db,
					new Date("2026-11-03T10:00:00.000Z"),
				),
			).toEqual({ filed: 0, existing: 0, failed: 0 });
		} finally {
			disabled.sqlite.close();
		}
		const invalid = fixture([{ ...receipts, cadence: "weekly" }]);
		try {
			expect(
				await fileRecurringWork(
					invalid.db,
					new Date("2026-11-03T10:00:00.000Z"),
				),
			).toEqual({ filed: 0, existing: 0, failed: 1 });
			expect(warn).toHaveBeenCalledWith(
				"[recurring-work] project metadata is invalid",
				{ projectId: "project-books" },
			);
		} finally {
			invalid.sqlite.close();
		}
	});
});
