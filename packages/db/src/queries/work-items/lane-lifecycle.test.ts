import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import {
	workInteractions,
	workResourceReservations,
	workBudgetReservations,
} from "../../schema/work-factory";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";
import {
	recordStaleLanes,
	notifyStoppedLanes,
	readLaneState,
} from "./lane-lifecycle";
import { agentSessionRequests } from "../../schema/agent-session-requests";
import { sweepElapsedWorkAttempts } from "./attempts";

const start = "2026-10-17T12:00:00.000Z";
const stale = "2026-10-17T12:02:30.000Z";
const expiry = "2026-10-17T12:05:00.000Z";
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workAttempts,
			workEvents,
			workInteractions,
			externalAgentPrincipals,
			agentSessionRequests,
			workResourceReservations,
			workBudgetReservations,
		),
	);
	sqlite.exec(
		"DROP INDEX uniq_work_attempt_active; CREATE UNIQUE INDEX uniq_work_attempt_active ON work_attempts(org_id,work_item_id) WHERE runtime_state IN ('queued','running','waiting','retrying')",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(workItems).values({
		id: "item",
		orgId: "org-example",
		title: "Improve search",
		disposition: "accepted",
		projectId: "project",
		createdAt: start,
	});
	await db.insert(externalAgentPrincipals).values({
		id: "agent",
		organizationId: "org-example",
		key: "agent",
		displayName: "Worker",
		credentialBindingType: "owner_user",
		credentialBindingId: "user-example",
		createdByType: "user",
		createdById: "user-example",
	});
	await db.insert(workAttempts).values({
		id: "attempt",
		orgId: "org-example",
		workItemId: "item",
		executorType: "external_agent",
		executorId: "agent",
		executorSessionId: "session",
		externalSessionKey: "codex:example",
		attemptNumber: 1,
		startedAt: start,
		heartbeatAt: start,
		expiresAt: expiry,
		metadata: { lane: true },
	});
	return { sqlite, db };
}

describe("server lane lifecycle", () => {
	it("detects a stopped lane with no local reporter, records once, and expires at 2N", async () => {
		const { db } = await fixture();
		expect(await recordStaleLanes(db, "2026-10-17T12:02:29.999Z")).toBe(0);
		expect(await recordStaleLanes(db, stale)).toBe(1);
		expect(await recordStaleLanes(db, stale)).toBe(0);
		expect(await notifyStoppedLanes(db, stale)).toBe(1);
		expect(await notifyStoppedLanes(db, stale)).toBe(0);
		expect((await sweepElapsedWorkAttempts(db, { now: expiry })).expired).toBe(
			1,
		);
		expect(await notifyStoppedLanes(db, expiry)).toBe(1);
		expect(await notifyStoppedLanes(db, expiry)).toBe(0);
		const notices = await db.select().from(workInteractions);
		expect(notices.map((n) => n.targetId)).toEqual([
			"user-example",
			"user-example",
		]);
		expect(notices.map((n) => n.metadata.laneLifecycle)).toMatchObject([
			{ state: "stale" },
			{ state: "failed" },
		]);
		expect((await db.select().from(workItems))[0]?.disposition).toBe(
			"accepted",
		);
	});
	it("does not notify a recovered heartbeat and can detect its next lapse", async () => {
		const { db, sqlite } = await fixture();
		await recordStaleLanes(db, stale);
		sqlite.exec(
			"UPDATE work_attempts SET heartbeat_at='2026-10-17T12:03:00.000Z', expires_at='2026-10-17T12:08:00.000Z'",
		);
		expect(await notifyStoppedLanes(db, stale)).toBe(0);
		expect(await recordStaleLanes(db, "2026-10-17T12:05:29.999Z")).toBe(0);
		expect(await recordStaleLanes(db, "2026-10-17T12:05:30.000Z")).toBe(1);
		expect(await notifyStoppedLanes(db, "2026-10-17T12:05:30.000Z")).toBe(1);
	});
	it("does not route a foreign principal or a superseded lane to the owner", async () => {
		const { db, sqlite } = await fixture();
		await recordStaleLanes(db, stale);
		sqlite.exec(
			"UPDATE external_agent_principals SET organization_id='foreign-org'",
		);
		expect(await notifyStoppedLanes(db, stale)).toBe(0);
		sqlite.exec(
			"UPDATE external_agent_principals SET organization_id='org-example'; UPDATE work_attempts SET runtime_state='expired',outcome='expired',finished_at='2026-10-17T12:05:00.000Z'",
		);
		await db.insert(workAttempts).values({
			id: "successor",
			orgId: "org-example",
			workItemId: "item",
			executorType: "external_agent",
			executorId: "agent",
			executorSessionId: "new-session",
			externalSessionKey: "codex:new",
			attemptNumber: 2,
			startedAt: expiry,
			heartbeatAt: expiry,
			expiresAt: "2026-10-17T12:10:00.000Z",
			metadata: { lane: true },
		});
		expect(await notifyStoppedLanes(db, expiry)).toBe(0);
	});
});

it("derives lane state from canonical time, asks and the owner's ledger", async () => {
	const { db, sqlite } = await fixture();
	expect(await readLaneState(db, "other-org", "attempt", start)).toBeNull();
	expect(await readLaneState(db, "org-example", "attempt", start)).toBe(
		"ready",
	);
	expect(await readLaneState(db, "org-example", "attempt", stale)).toBe(
		"stale",
	);
	expect(await readLaneState(db, "org-example", "attempt", expiry)).toBe(
		"failed",
	);
	await db.insert(workInteractions).values({
		id: "ask",
		orgId: "org-example",
		workItemId: "item",
		kind: "question",
		subject: "Choose",
		prompt: "Choose a release window",
		creatorType: "system",
		creatorId: "tedix",
		targetType: "user",
		targetId: "user-example",
		createdAt: start,
	});
	expect(await readLaneState(db, "org-example", "attempt", start)).toBe(
		"needs-human",
	);
	sqlite.exec("UPDATE work_interactions SET status='resolved'");
	await db.insert(agentSessionRequests).values({
		id: "request",
		organizationId: "org-example",
		userId: "other-user",
		harness: "codex",
		sessionKey: "example",
		projectId: "project",
		kind: "request",
		text: "Check search",
		status: "waiting_on_user",
		sourceAt: start,
		sourceKey: "example-message",
		statusChangedAt: start,
	});
	expect(await readLaneState(db, "org-example", "attempt", start)).toBe(
		"ready",
	);
	sqlite.exec("UPDATE agent_session_requests SET user_id='user-example'");
	expect(await readLaneState(db, "org-example", "attempt", start)).toBe(
		"needs-human",
	);
	sqlite.exec(
		"UPDATE agent_session_requests SET status='done'; UPDATE work_attempts SET runtime_state='finished',outcome='succeeded',finished_at='2026-10-17T12:01:00.000Z'",
	);
	expect(await readLaneState(db, "org-example", "attempt", expiry)).toBe(
		"done",
	);
});
