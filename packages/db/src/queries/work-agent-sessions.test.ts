import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { projects } from "../schema/projects";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { workAttempts, workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listWorkAgentSessions,
	listWorkProjectContributorSources,
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
	sqlite.exec(schemaDdl(workItems));
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
	it("retires only the same owner's previous host key and keeps the canonical lane once", async () => {
		const db = fixture();
		await report(db, { sessionKey: "host" });
		await report(db, { sessionKey: "host", userId: OTHER_USER });
		await report(db, { sessionKey: "host", organizationId: OTHER_ORG });
		await report(db, { sessionKey: "host", harness: "codex" });
		await report(db, {
			sessionKey: "claude-code:claim",
			replacesSessionKey: "host",
			now: T1,
		});
		const rows = await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: USER,
			includeEnded: false,
			now: T1,
		});
		expect(rows.map((r) => r.sessionKey).sort()).toEqual([
			"claude-code:claim",
			"host",
		]);
		expect(rows.find((r) => r.sessionKey === "host")?.harness).toBe("codex");
		for (const scope of [
			{ userId: OTHER_USER, organizationId: ORG },
			{ userId: USER, organizationId: OTHER_ORG },
		]) {
			const peers = await listWorkAgentSessions(db, {
				...scope,
				includeEnded: false,
				now: T1,
			});
			expect(peers[0]?.state).toBe("working");
		}
	});
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

describe("project contributors", () => {
	const PROJECT = "11111111-1111-4111-8111-111111111111";
	const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
	const ITEM = "33333333-3333-4333-8333-333333333333";
	const OTHER_ITEM = "44444444-4444-4444-8444-444444444444";
	const SECOND_ITEM = "55555555-5555-4555-8555-555555555555";

	function projectFixture() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		for (const table of [workAgentSessions, projects, workItems, workAttempts])
			sqlite.exec(schemaDdl(table));
		const db = createDbQueryClient(createD1Facade(sqlite));
		return { sqlite, db };
	}

	async function seed(db: ReturnType<typeof fixture>) {
		await db.insert(projects).values([
			{ id: PROJECT, orgId: ORG, key: "ALPHA", name: "Alpha", createdAt: T0 },
			{
				id: OTHER_PROJECT,
				orgId: OTHER_ORG,
				key: "BETA",
				name: "Beta",
				createdAt: T0,
			},
		]);
		await db.insert(workItems).values([
			{
				id: ITEM,
				orgId: ORG,
				title: "Ship alpha",
				projectId: PROJECT,
				createdAt: T0,
			},
			{
				id: SECOND_ITEM,
				orgId: ORG,
				title: "Review alpha",
				projectId: PROJECT,
				createdAt: T0,
			},
			{ id: OTHER_ITEM, orgId: OTHER_ORG, title: "Elsewhere", createdAt: T0 },
		] as never);
	}

	it("binds a session only to its own organization's project and item", async () => {
		const { db } = projectFixture();
		await seed(db);
		const bound = await report(db, { projectId: PROJECT, workItemId: ITEM });
		expect(bound.row).toMatchObject({ projectId: PROJECT, workItemId: ITEM });

		const foreign = await report(db, {
			sessionKey: "session-2",
			projectId: OTHER_PROJECT,
			workItemId: OTHER_ITEM,
		});
		expect(foreign.row).toMatchObject({ projectId: null, workItemId: null });
		const listed = await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: USER,
			includeEnded: false,
			now: T1,
		});
		expect(listed.find((row) => row.id === bound.row.id)?.workItemTitle).toBe(
			"Ship alpha",
		);
		expect(
			listed.find((row) => row.id === foreign.row.id)?.workItemTitle,
		).toBeNull();

		const unbound = await report(db, { now: T1, state: "done" });
		expect(unbound.row).toMatchObject({ projectId: PROJECT, workItemId: ITEM });
	});

	it("lists bound reports, Attempt sessions and their reports, including ended ones", async () => {
		const { db } = projectFixture();
		await seed(db);
		await report(db, { projectId: PROJECT, state: "ended", now: T0 });
		await report(db, {
			userId: OTHER_USER,
			harness: "codex",
			sessionKey: "thread-9",
			label: "Reviewer",
		});
		await report(db, { sessionKey: "unrelated" });
		await db.insert(workAttempts).values([
			{
				id: "attempt-1",
				workItemId: ITEM,
				orgId: ORG,
				executorType: "external_agent",
				executorId: "principal-1",
				executorSessionId: "session-row-1",
				externalSessionKey: "codex:thread-9",
				attemptNumber: 1,
				startedAt: T0,
				heartbeatAt: T2,
				runtimeState: "expired",
				outcome: "expired",
				finishedAt: T2,
			},
			{
				id: "attempt-2",
				workItemId: SECOND_ITEM,
				orgId: ORG,
				executorType: "external_agent",
				executorId: "principal-1",
				executorSessionId: "session-row-2",
				externalSessionKey: "claude-code:only-attempts",
				attemptNumber: 1,
				startedAt: T0,
				heartbeatAt: T1,
				runtimeState: "finished",
				outcome: "succeeded",
				finishedAt: T1,
			},
		] as never);

		const { reports, attempts } = await listWorkProjectContributorSources(db, {
			organizationId: ORG,
			projectId: PROJECT,
		});
		expect(reports.map((row) => row.sessionKey).sort()).toEqual([
			"session-1",
			"thread-9",
		]);
		expect(attempts.map((row) => row.externalSessionKey)).toEqual([
			"codex:thread-9",
			"claude-code:only-attempts",
		]);
		expect(attempts[0]).toMatchObject({ workItemTitle: "Ship alpha" });
		expect(reports.every((row) => row.summary === "")).toBe(true);
		const own = await listWorkAgentSessions(db, {
			organizationId: ORG,
			userId: OTHER_USER,
			includeEnded: false,
			now: T2,
		});
		expect(own[0]?.summary).toBe("Editing the router");

		const foreign = await listWorkProjectContributorSources(db, {
			organizationId: OTHER_ORG,
			projectId: PROJECT,
		});
		expect(foreign).toEqual({ reports: [], attempts: [] });
	});
});

it("a late observation cannot reopen a completed lane or discard its usage", async () => {
	const db = fixture();
	const telemetry = {
		executor: "codex",
		model: "fictional-model",
		provider: "fictional",
		reasoningEffort: null,
		brief: "Fix example",
		startedAt: T0,
		heartbeatAt: T2,
		finishedAt: T2,
		outcome: "succeeded",
		finalMessage: "Done",
		tools: { Read: 1 },
		usage: { input: 10, cached: 0, output: 2, reasoning: 0 },
		shas: [],
		workItems: [],
		corrections: [],
		source: "wrapper",
		estimatedCostUsd: null,
		rateVersionId: null,
		lesson: null,
		lessonStatus: "unavailable",
	} as const;
	await report(db, {
		state: "done",
		telemetry: { ...telemetry, shas: [], workItems: [], corrections: [] },
		now: T2,
	});
	const late = await report(db, {
		state: "working",
		telemetry: {
			...telemetry,
			heartbeatAt: T1,
			finishedAt: null,
			outcome: null,
			shas: [],
			workItems: [],
			corrections: [],
		},
		now: T2,
	});
	expect(late.row.state).toBe("done");
	expect(late.row.telemetry?.finishedAt).toBe(T2);
	expect(late.changed).toBe(false);
	const hook = await report(db, { state: "needs_you", now: T2 });
	expect(hook.row.telemetry?.usage).toEqual(telemetry.usage);
});
