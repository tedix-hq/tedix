import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listWorkAgentSessions,
	reportWorkAgentSessionStatus,
	WORK_AGENT_SESSION_LIST_LIMIT,
} from "./work-agent-sessions";

const ORG = "org-example";
const OTHER_ORG = "org-other";
const USER = "user-ada";
const OTHER_USER = "user-grace";
const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:05:00.000Z";
const T2 = "2026-10-06T10:10:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(workAgentSessions));
	return createDbQueryClient(createD1Facade(sqlite));
}

function report(
	db: ReturnType<typeof fixture>,
	overrides: Partial<Parameters<typeof reportWorkAgentSessionStatus>[1]> = {},
) {
	return reportWorkAgentSessionStatus(db, {
		organizationId: ORG,
		userId: USER,
		harness: "claude-code",
		sessionKey: "session-1",
		state: "working",
		summary: "Editing the router",
		label: "tedix main",
		now: T0,
		...overrides,
	});
}

describe("reportWorkAgentSessionStatus", () => {
	it("creates a session and reports it as changed", async () => {
		const db = fixture();
		const { row, changed } = await report(db);
		expect(changed).toBe(true);
		expect(row).toMatchObject({
			organizationId: ORG,
			userId: USER,
			state: "working",
			stateSince: T0,
			lastEventAt: T0,
			label: "tedix main",
		});
	});

	it("keeps state_since while the state is unchanged and moves it on change", async () => {
		const db = fixture();
		const first = await report(db);
		const same = await report(db, { now: T1, summary: "Still editing" });
		expect(same.changed).toBe(false);
		expect(same.row.id).toBe(first.row.id);
		expect(same.row).toMatchObject({
			stateSince: T0,
			lastEventAt: T1,
			summary: "Still editing",
		});

		const next = await report(db, { now: T2, state: "needs_you" });
		expect(next.changed).toBe(true);
		expect(next.row).toMatchObject({
			state: "needs_you",
			stateSince: T2,
			lastEventAt: T2,
		});
	});

	it("keeps the stored label when a report omits it", async () => {
		const db = fixture();
		await report(db);
		const { row } = await report(db, { now: T1, label: "" });
		expect(row.label).toBe("tedix main");
	});

	it("keys sessions by organization, user, harness and session key", async () => {
		const db = fixture();
		await report(db);
		for (const overrides of [
			{ organizationId: OTHER_ORG },
			{ userId: OTHER_USER },
			{ harness: "codex" as const },
			{ sessionKey: "session-2" },
		]) {
			expect((await report(db, overrides)).changed).toBe(true);
		}
	});
});

describe("listWorkAgentSessions", () => {
	it("returns only the caller's sessions, newest first", async () => {
		const db = fixture();
		await report(db, { sessionKey: "a", now: T0 });
		await report(db, { sessionKey: "b", now: T1 });
		await report(db, { sessionKey: "c", now: T2, userId: OTHER_USER });
		await report(db, { sessionKey: "d", now: T2, organizationId: OTHER_ORG });
		const rows = await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: USER,
			includeEnded: false,
			now: T2,
		});
		expect(rows.map((row) => row.sessionKey)).toEqual(["b", "a"]);
	});

	it("excludes ended sessions unless asked, and always after 24 hours", async () => {
		const db = fixture();
		await report(db, { sessionKey: "live", now: T0 });
		await report(db, { sessionKey: "recent", state: "ended", now: T1 });
		await report(db, {
			sessionKey: "old",
			state: "ended",
			now: "2026-10-05T09:00:00.000Z",
		});
		const params = { organizationId: ORG, userId: USER, now: T2 };
		expect(
			(await listWorkAgentSessions(db, { ...params, includeEnded: false })).map(
				(row) => row.sessionKey,
			),
		).toEqual(["live"]);
		expect(
			(await listWorkAgentSessions(db, { ...params, includeEnded: true })).map(
				(row) => row.sessionKey,
			),
		).toEqual(["recent", "live"]);
	});

	it("bounds the result", async () => {
		const db = fixture();
		for (let i = 0; i < WORK_AGENT_SESSION_LIST_LIMIT + 5; i++) {
			await report(db, {
				sessionKey: `s-${i}`,
				now: new Date(Date.parse(T0) + i * 1000).toISOString(),
			});
		}
		const rows = await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: USER,
			includeEnded: false,
			now: T2,
		});
		expect(rows).toHaveLength(WORK_AGENT_SESSION_LIST_LIMIT);
	});
});
