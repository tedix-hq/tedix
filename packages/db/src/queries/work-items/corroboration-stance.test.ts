import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { recordWorkConfirmation } from "./comments";

/** Work event corrections retain identity, history and a single current stance. */
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
		const first = await recordWorkConfirmation(db, row());
		expect(first.inserted).toBe(true);
		const second = await recordWorkConfirmation(
			db,
			row({ stance: "contradicts" }),
		);
		expect(second.inserted).toBe(false);
		expect(second.confirmation.id).toBe(first.confirmation.id);
		expect(second.confirmation.stance).toBe("contradicts");
	});

	it("corrects changed observations while retaining their identity and creation time", async () => {
		const first = await recordWorkConfirmation(
			db,
			row({
				id: "first",
				sessionId: "session-1",
				createdAt: "2026-09-18T12:00:00.000Z",
			}),
		);
		const corrected = await recordWorkConfirmation(
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
		expect(corrected.confirmation).toMatchObject({
			id: first.confirmation.id,
			orgId: ORG,
			workItemId: ITEM,
			principalType: "external_agent",
			principalId: "agent-a",
			stance: "contradicts",
			evidenceRef: "commit:def5678",
			body: "the settled claim does not hold",
			sessionId: "session-2",
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.confirmation.createdAt,
		});
	});

	it("leaves a replay unchanged and clears session when it is omitted", async () => {
		const first = await recordWorkConfirmation(
			db,
			row({
				id: "first",
				sessionId: "session-1",
				occurredAt: "2026-09-18T12:00:00.000Z",
				createdAt: "2026-09-18T11:00:00.000Z",
			}),
		);
		const cleared = await recordWorkConfirmation(
			db,
			row({ id: "clear", occurredAt: "2026-09-18T13:00:00.000Z" }),
		);
		expect(cleared.confirmation).toMatchObject({
			id: first.confirmation.id,
			sessionId: null,
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.confirmation.createdAt,
		});
		const replay = await recordWorkConfirmation(
			db,
			row({
				id: "replay",
				stance: "corroborates",
				occurredAt: "2026-09-18T14:00:00.000Z",
			}),
		);
		expect(replay).toMatchObject({ inserted: false });
		expect(replay.confirmation).toMatchObject({
			id: first.confirmation.id,
			occurredAt: "2026-09-18T13:00:00.000Z",
			createdAt: first.confirmation.createdAt,
		});
	});

	it("rejects a concurrent correction based on a stale history revision", async () => {
		await recordWorkConfirmation(db, row());
		const results = await Promise.allSettled([
			recordWorkConfirmation(
				db,
				row({ stance: "contradicts", body: "First correction" }),
			),
			recordWorkConfirmation(
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
		await recordWorkConfirmation(db, row());
		const other = await recordWorkConfirmation(
			db,
			row({ principalId: "agent-b", stance: "contradicts" }),
		);
		expect(other.inserted).toBe(true);
		expect(other.confirmation.stance).toBe("contradicts");
	});

	it("keeps every corroboration identity dimension isolated", async () => {
		await recordWorkConfirmation(db, row());
		for (const override of [
			{ orgId: "org-2" },
			{ workItemId: "item-2" },
			{ principalType: "user" as const },
			{ principalType: "organization" as const },
			{ principalId: "agent-b" },
		]) {
			const result = await recordWorkConfirmation(db, row(override));
			expect(result.inserted).toBe(true);
		}
	});
});
