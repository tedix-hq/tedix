import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	clearReadMarkCache,
	freshReadMarkExists,
	getReadMarkDates,
	markRowsRead,
} from "./read-marks";
import { readMarks } from "../schema/read-marks";

const DAY = new Date("2026-11-25T12:00:00.000Z");

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations VALUES ('org-1');
		CREATE TABLE read_marks (
			organization_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			row_id TEXT NOT NULL,
			last_read_on TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (organization_id, kind, row_id)
		);
	`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}

beforeEach(() => clearReadMarkCache());

describe("markRowsRead", () => {
	it("writes one row per id and reads the date back", async () => {
		const { db } = fixture();
		await markRowsRead(db, "org-1", "skill", ["s-1", "s-2"], {
			now: DAY,
		});
		const marks = await getReadMarkDates(db, "org-1", "skill", [
			"s-1",
			"s-2",
			"s-3",
		]);
		expect(marks.get("s-1")).toBe("2026-11-25");
		expect(marks.get("s-2")).toBe("2026-11-25");
		expect(marks.has("s-3")).toBe(false);
	});

	it("does not rewrite within the same UTC day, even across calls", async () => {
		const { sqlite, db } = fixture();
		await markRowsRead(db, "org-1", "lesson", ["f-1"], { now: DAY });
		await markRowsRead(db, "org-1", "lesson", ["f-1"], {
			now: new Date("2026-11-25T23:59:00.000Z"),
		});
		const rows = sqlite
			.prepare("SELECT COUNT(*) AS n FROM read_marks")
			.get() as { n: number };
		expect(rows.n).toBe(1);
	});

	it("moves last_read_on forward on a later day but never backward", async () => {
		const { db } = fixture();
		await markRowsRead(db, "org-1", "output", ["o-1"], {
			now: new Date("2026-11-20T00:00:00.000Z"),
		});
		await markRowsRead(db, "org-1", "output", ["o-1"], { now: DAY });
		await markRowsRead(db, "org-1", "output", ["o-1"], {
			now: new Date("2026-11-22T00:00:00.000Z"),
		});
		const marks = await getReadMarkDates(db, "org-1", "output", ["o-1"]);
		expect(marks.get("o-1")).toBe("2026-11-25");
	});

	it("scopes marks by organization and kind", async () => {
		const { db } = fixture();
		await markRowsRead(db, "org-1", "skill", ["same-id"], { now: DAY });
		expect(
			(await getReadMarkDates(db, "org-1", "lesson", ["same-id"])).size,
		).toBe(0);
	});
});

describe("freshReadMarkExists", () => {
	it("is true only for marks on or after the cutoff date", async () => {
		const { db } = fixture();
		await markRowsRead(db, "org-1", "policy_pack", ["p-1"], { now: DAY });
		const fresh = await db
			.select({ id: readMarks.rowId })
			.from(readMarks)
			.where(
				freshReadMarkExists({
					organizationId: "org-1",
					kind: "policy_pack",
					rowId: readMarks.rowId,
					sinceDate: "2026-11-25",
				}),
			);
		expect(fresh).toHaveLength(1);
		const stale = await db
			.select({ id: readMarks.rowId })
			.from(readMarks)
			.where(
				freshReadMarkExists({
					organizationId: "org-1",
					kind: "policy_pack",
					rowId: readMarks.rowId,
					sinceDate: "2026-11-26",
				}),
			);
		expect(stale).toHaveLength(0);
	});
});
