import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { addWorkItemCorroboration } from "./comments";

/**
 * The ledger began as duplicate suppression — "I hit this too" — so every row
 * meant one thing and the table had no stance. After-the-fact correctness
 * ("a settled outcome that turns out to be false is fixed when someone
 * notices") needs `tedix work confirm` to record a contradiction too; a table
 * that can only agree cannot carry that.
 */
const ORG = "org-1";
const ITEM = "item-1";

const DDL = `
CREATE TABLE work_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, project_id TEXT, objective_id TEXT,
 attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL,
 occurred_at TEXT NOT NULL);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbQueryClient>;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
});

afterEach(() => sqlite.close());

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: crypto.randomUUID(),
		orgId: ORG,
		workItemId: ITEM,
		principalType: "external_agent" as const,
		principalId: "agent-a",
		evidenceRef: "commit:abc1234",
		body: "checked independently",
		occurredAt: "2026-09-18T12:00:00.000Z",
		...overrides,
	};
}

describe("corroboration stance", () => {
	it("keeps one row per principal — stance is not part of dedup", async () => {
		// A principal that agreed and then changed its mind must not count twice;
		// the ledger's whole value is that a stable principal counts once.
		const first = await addWorkItemCorroboration(db, row());
		expect(first.inserted).toBe(true);
		const second = await addWorkItemCorroboration(
			db,
			row({ stance: "contradicts" }),
		);
		expect(second.inserted).toBe(false);
		expect(second.corroboration.id).toBe(first.corroboration.id);
		expect(second.corroboration.stance).toBe("contradicts");
	});

	it("corrects changed observations while retaining their identity and creation time", async () => {
		const first = await addWorkItemCorroboration(
			db,
			row({
				id: "first",
				sessionId: "session-1",
				createdAt: "2026-09-18T12:00:00.000Z",
			}),
		);
		const corrected = await addWorkItemCorroboration(
			db,
			row({
				id: "retry",
				stance: "contradicts",
				evidenceRef: "commit:def5678",
				body: "the settled claim does not hold",
				sessionId: "session-2",
				occurredAt: "2026-09-18T13:00:00.000Z",
				createdAt: "2026-09-18T13:00:00.000Z",
			}),
		);
		expect(corrected).toMatchObject({ inserted: false });
		expect(corrected.corroboration).toMatchObject({
			id: first.corroboration.id,
			orgId: ORG,
			workItemId: ITEM,
			principalType: "external_agent",
			principalId: "agent-a",
			stance: "contradicts",
			evidenceRef: "commit:def5678",
			body: "the settled claim does not hold",
			sessionId: "session-2",
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.corroboration.createdAt,
		});
	});

	it("leaves a replay unchanged and clears session when it is omitted", async () => {
		const first = await addWorkItemCorroboration(
			db,
			row({
				id: "first",
				sessionId: "session-1",
				occurredAt: "2026-09-18T12:00:00.000Z",
				createdAt: "2026-09-18T11:00:00.000Z",
			}),
		);
		const cleared = await addWorkItemCorroboration(
			db,
			row({ id: "clear", occurredAt: "2026-09-18T13:00:00.000Z" }),
		);
		expect(cleared.corroboration).toMatchObject({
			id: first.corroboration.id,
			sessionId: null,
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.corroboration.createdAt,
		});
		const replay = await addWorkItemCorroboration(
			db,
			row({
				id: "replay",
				stance: "corroborates",
				occurredAt: "2026-09-18T14:00:00.000Z",
			}),
		);
		expect(replay).toMatchObject({ inserted: false });
		expect(replay.corroboration).toMatchObject({
			id: first.corroboration.id,
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.corroboration.createdAt,
		});
	});

	it("rejects a concurrent correction based on a stale history revision", async () => {
		await addWorkItemCorroboration(db, row());
		const results = await Promise.allSettled([
			addWorkItemCorroboration(
				db,
				row({ stance: "contradicts", body: "First correction" }),
			),
			addWorkItemCorroboration(
				db,
				row({ stance: "contradicts", body: "Other correction" }),
			),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.find((result) => result.status === "rejected"),
		).toMatchObject({ reason: { code: "CONFLICT" } });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_events").get(),
		).toEqual({ n: 2 });
	});

	it("counts a different principal separately", async () => {
		await addWorkItemCorroboration(db, row());
		const other = await addWorkItemCorroboration(
			db,
			row({ principalId: "agent-b", stance: "contradicts" }),
		);
		expect(other.inserted).toBe(true);
		expect(other.corroboration.stance).toBe("contradicts");
	});

	it("keeps every corroboration identity dimension isolated", async () => {
		await addWorkItemCorroboration(db, row());
		for (const override of [
			{ orgId: "org-2" },
			{ workItemId: "item-2" },
			{ principalType: "user" as const },
			{ principalType: "organization" as const },
			{ principalId: "agent-b" },
		]) {
			const result = await addWorkItemCorroboration(db, row(override));
			expect(result.inserted).toBe(true);
		}
	});
});
