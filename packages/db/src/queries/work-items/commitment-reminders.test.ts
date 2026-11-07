import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workInteractions } from "../../schema/work-factory";
import { workEvents, workItems } from "../../schema/work-items";
import {
	closeSettledCommitmentReminders,
	dismissCommitmentReminders,
} from "./commitment-reminders";

const filed = "2026-11-06T08:00:00.000Z";
const now = "2026-11-07T12:00:00.000Z";
const reminder = JSON.stringify({ source: "commitment_followup" });

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(workItems, workEvents, workInteractions));
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const ask = (id: string, work: string, target: string, metadata = reminder) =>
		`INSERT INTO work_interactions(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,version,metadata)
		VALUES ('${id}','org-one','${work}','question','open','Follow up: ${work}','Status?','tedi','personal','user','${target}','${filed}',1,'${metadata}');`;
	sqlite.exec(`
		INSERT INTO work_items(id,org_id,title,created_at,disposition) VALUES
			('idle','org-one','Idle','2026-11-01T00:00:00.000Z','accepted'),
			('done','org-one','Done','2026-11-01T00:00:00.000Z','completed'),
			('started','org-one','Started','2026-11-01T00:00:00.000Z','accepted'),
			('earlier','org-one','Earlier','2026-11-01T00:00:00.000Z','accepted');
		INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES
			('e1','org-one','started','attempt.started','tedi','personal','2026-11-07T09:00:00.000Z'),
			('e2','org-one','earlier','attempt.started','tedi','personal','2026-11-05T09:00:00.000Z'),
			('e3','org-one','idle','work.item.commented','user','human','2026-11-07T09:00:00.000Z');
		${ask("r-idle", "idle", "human")}
		${ask("r-done", "done", "human")}
		${ask("r-started", "started", "human")}
		${ask("r-earlier", "earlier", "human")}
		${ask("r-other", "idle", "someone-else")}
		${ask("decision", "done", "human", "{}")}
	`);
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const status = () =>
		Object.fromEntries(
			(
				sqlite
					.prepare("SELECT id, status FROM work_interactions ORDER BY id")
					.all() as Array<{ id: string; status: string }>
			).map((row) => [row.id, row.status]),
		);
	return { db, status };
}

describe("commitment reminders", () => {
	it("dismisses only the caller's own open reminders", async () => {
		const { db, status } = fixture();
		const dismissed = await dismissCommitmentReminders(db, {
			orgId: "org-one",
			targetType: "user",
			targetId: "human",
			ids: ["r-idle", "r-other", "decision", "r-done"],
			now,
		});
		expect(dismissed.sort()).toEqual(["r-done", "r-idle"]);
		expect(status()).toMatchObject({
			"r-idle": "cancelled",
			"r-done": "cancelled",
			"r-other": "open",
			decision: "open",
		});
	});

	it("closes reminders once their Work finished or changed state after filing", async () => {
		const { db, status } = fixture();
		const closed = await closeSettledCommitmentReminders(db, { now });
		expect(closed.sort()).toEqual(["r-done", "r-started"]);
		expect(status()).toEqual({
			decision: "open",
			"r-done": "cancelled",
			"r-earlier": "open",
			"r-idle": "open",
			"r-other": "open",
			"r-started": "cancelled",
		});
		expect(await closeSettledCommitmentReminders(db, { now })).toEqual([]);
	});
});
