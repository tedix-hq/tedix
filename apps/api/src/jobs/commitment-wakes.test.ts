import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { tedis } from "@tedix/db/schema/tedis";
import { projects } from "@tedix/db/schema/projects";
import {
	workItems,
	workEvents,
	workAttempts,
} from "@tedix/db/schema/work-items";
import {
	workApprovalProposals,
	workApprovalDecisions,
	workInteractions,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { osGadgetExecutions } from "@tedix/db/schema/os-workspaces";
import { skillRuns } from "@tedix/db/schema/cognitive";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { buildRuntimeRunId } from "@tedix/api-contract/utils/runtime-identity";
import {
	advanceCommitmentWakeCheckpoint,
	advanceCommitmentWakeCursor,
	getCommitmentWakeCursor,
	listCommitmentChanges,
	lastCommitmentWakeCheckpoint,
} from "@tedix/db/queries/work-items/commitment-changes";
import {
	platformCronExecutions,
	platformCronCheckpoints,
} from "@tedix/db/schema/platform-cron-executions";
import {
	buildCommitmentWakeRequest,
	MAX_COMMITMENT_CHANGES_PER_RUN,
	commitmentWakeWindows,
	dispatchCommitmentWakes,
} from "./commitment-wakes";
import { ensureCommitmentFollowup } from "../services/tedi-context-wake";
import { listWorkInteractionInbox } from "@tedix/db/queries/work-items/interactions";
import { projectDeckCards } from "@tedix/api-contract/utils/deck-projection";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import {
	workInteractionAttention,
	workInteractionDeliveries,
} from "@tedix/db/schema/work-factory";
import { runPlatformCronPath } from "./platform-cron-receipts";

const after = "2026-10-16T12:00:00.000Z";
const through = "2026-10-16T12:02:00.000Z";
const changedAt = "2026-10-16T12:01:00.000Z";

function fixture(plans: string[] = [], migrated = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	if (migrated) {
		const root = new URL("../../../../packages/db/drizzle/", import.meta.url);
		for (const name of readdirSync(root).sort())
			sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), "utf8"));
	} else
		sqlite.exec(
			schemaDdl(
				tedis,
				projects,
				workItems,
				workEvents,
				workAttempts,
				workApprovalProposals,
				workApprovalDecisions,
				workInteractions,
				workInteractionResponses,
				tediApprovalRequests,
				osGadgetExecutions,
				skillRuns,
				tediRuntimeEvents,
				platformCronExecutions,
				platformCronCheckpoints,
				organizationMembers,
				memoryFacts,
				decisionEdges,
				workInteractionAttention,
				workInteractionDeliveries,
			),
		);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	if (!migrated)
		sqlite.exec(`INSERT INTO tedis (id,organization_id,name,slug,status) VALUES ('worker-1','org-1','Orion','orion','active'),('worker-2','org-2','Lyra','lyra','active');
	INSERT INTO work_items(id,org_id,title,created_at,disposition,accountable_owner_type,accountable_owner_id) VALUES ('work-1','org-1','Scratch commitment','${after}','accepted','tedi','worker-1');`);
	const binding = createD1Facade({
		prepare(query) {
			expect((query.match(/\bUNION\b/gi) ?? []).length).toBeLessThan(4);
			plans.push(
				...sqlite
					.prepare(`EXPLAIN QUERY PLAN ${query}`)
					.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
					.map((row) => String(row.detail)),
			);
			return sqlite.prepare(query);
		},
		exec: (query) => {
			sqlite.exec(query);
		},
	});
	return { sqlite, db: createDbClient(binding), binding };
}

describe("commitment wakes", () => {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse(through) + 30_000);
	});
	afterEach(() => vi.restoreAllMocks());
	it("creates one daily ask, reuses an open ask, and never reopens an answered ask", async () => {
		const { db, sqlite } = fixture();
		sqlite.exec(`
		INSERT INTO tedis(id,organization_id,name,slug,status,scope,owner_user_id)
		VALUES ('personal','org-one','Personal','personal','active','personal','provider-user');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status)
		VALUES ('member','org-one','human','provider-user','human@example.test','active');
		INSERT INTO work_items(id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id)
		VALUES ('idle','org-one','Send proposal','2026-10-20T08:01:00.000Z','2026-10-20T08:01:00.000Z','accepted','user','human');
	`);
		const after = "2026-10-22T08:00:00.000Z";
		const through = "2026-10-22T08:02:00.000Z";
		const [change] = await listCommitmentChanges(
			db,
			after,
			through,
			"production",
		);
		const id = await ensureCommitmentFollowup(db, change!, through);
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		const inbox = await listWorkInteractionInbox(db, {
			orgId: "org-one",
			targetType: "user",
			targetId: "human",
			states: ["open"],
			observedAt: through,
		});
		const cards = projectDeckCards({
			requests: inbox.data.map((row) => ({
				...row,
				request: {
					...row.request,
					requestedFromType: row.request.targetType!,
					requestedFromId: row.request.targetId!,
					state: row.request.status,
					requestedAt: row.request.createdAt,
				},
				canRespond: true,
				canCancel: false,
			})),
			work: [],
			runtime: [],
			now: new Date(through),
		});
		expect(cards).toEqual([
			expect.objectContaining({
				kind: "question",
				label: "Follow up: Send proposal",
			}),
		]);
		sqlite
			.prepare("UPDATE work_interactions SET metadata='{}' WHERE id=?")
			.run(id);
		expect(await ensureCommitmentFollowup(db, change!, through)).toBe(id);
		const restored = sqlite
			.prepare("SELECT version,metadata FROM work_interactions WHERE id=?")
			.get(id)!;
		expect(JSON.parse(String(restored.metadata)).decisionClass).toBe(
			"personal.proposal.commitment",
		);
		expect(await ensureCommitmentFollowup(db, change!, through)).toBe(id);
		expect(
			sqlite.prepare("SELECT version FROM work_interactions WHERE id=?").get(id)
				?.version,
		).toBe(restored.version);
		expect(
			await ensureCommitmentFollowup(db, change!, "2026-10-23T08:00:00.000Z"),
		).toBe(id);
		sqlite
			.prepare("UPDATE work_interactions SET status='resolved' WHERE id=?")
			.run(id);
		expect(await ensureCommitmentFollowup(db, change!, through)).toBe(id);
		expect(
			sqlite
				.prepare("SELECT status,kind,metadata FROM work_interactions")
				.get(),
		).toMatchObject({
			status: "resolved",
			kind: "question",
			metadata: expect.stringContaining("work:idle:2026-10-23"),
		});
		expect(
			await ensureCommitmentFollowup(db, change!, "2026-10-23T08:00:00.000Z"),
		).not.toBe(id);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_interactions").get()?.n,
		).toBe(2);
		const open = sqlite
			.prepare("SELECT id FROM work_interactions WHERE status='open'")
			.get()!;
		sqlite
			.prepare(
				"UPDATE work_interactions SET due_at=?, metadata='{}' WHERE id=?",
			)
			.run(through, open.id);
		const interactionChange = {
			...change!,
			kind: "interaction" as const,
			objectId: String(open.id),
			state: "overdue",
		};
		expect(
			await ensureCommitmentFollowup(
				db,
				interactionChange,
				"2026-10-23T08:00:00.000Z",
			),
		).toBe(open.id);
		expect(
			JSON.parse(
				String(
					sqlite
						.prepare("SELECT metadata FROM work_interactions WHERE id=?")
						.get(open.id)?.metadata,
				),
			).decisionClass,
		).toBe("deadline.owner.commitment");
		sqlite
			.prepare("UPDATE work_interactions SET metadata=? WHERE id=?")
			.run('{"decisionDeck":{"kind":"approval"}}', open.id);
		await ensureCommitmentFollowup(
			db,
			interactionChange,
			"2026-10-23T08:00:00.000Z",
		);
		expect(
			sqlite
				.prepare("SELECT metadata FROM work_interactions WHERE id=?")
				.get(open.id)?.metadata,
		).toBe('{"decisionDeck":{"kind":"approval"}}');
	});

	it.each([false, true])(
		"records partial delivery counts and retries only once (recover=%s)",
		async (recover) => {
			const { sqlite, db, binding } = fixture();
			await advanceCommitmentWakeCheckpoint(db, after);
			sqlite.exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at)
			VALUES ('first','org-1','work-1','work.accepted','user','owner','${changedAt}');`);
			const fetch = vi.fn(async () =>
				recover && fetch.mock.calls.length > 1
					? Response.json({ run_id: "accepted", accepted: true })
					: new Response("retry", { status: 503 }),
			);
			const env = {
				DB: binding,
				ENVIRONMENT: "test",
				TEDI_SERVICE: { fetch },
			} as unknown as CloudflareEnv;
			const scheduledTime = Date.parse(through) + 30_000;
			const result = runPlatformCronPath(
				env,
				{ scheduledTime, cron: "*/2 * * * *" } as ScheduledController,
				"commitment-wakes",
				() => dispatchCommitmentWakes(env, scheduledTime),
			);
			if (recover) await result;
			else
				await expect(result).rejects.toThrow("Commitment wake delivery failed");
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(await lastCommitmentWakeCheckpoint(db)).toBe(
				recover ? through : after,
			);
			const receipt = sqlite
				.prepare(
					"SELECT status,affected_row_counts AS counts FROM platform_cron_executions",
				)
				.get()!;
			expect(receipt.status).toBe(recover ? "success" : "failure");
			expect(JSON.parse(String(receipt.counts))).toMatchObject({
				observed: 1,
				dispatched: recover ? 1 : 0,
				failed: recover ? 0 : 1,
				retried: 1,
			});
		},
	);

	it("skips stale windows without ingesting even completed lane successes", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(`UPDATE work_items SET disposition='completed';
			INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
			VALUES ('old-success','org-1','work-1','attempt.settled','external_agent','agent','{"outcome":"succeeded"}','${changedAt}');`);
		const fetch = vi.fn();
		const counts = await dispatchCommitmentWakes(
			{
				DB: binding,
				ENVIRONMENT: "test",
				TEDI_SERVICE: { fetch },
			} as unknown as CloudflareEnv,
			Date.parse("2026-10-19T12:00:30.000Z"),
		);
		expect(counts).toMatchObject({
			windowsSkippedMaxAge: 10,
			observed: 0,
			dispatched: 0,
			windowsProcessed: 10,
		});
		expect(fetch).not.toHaveBeenCalled();
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-16T12:20:00.000Z",
		);
	});

	it("uses execution time to suppress an old delayed cron fire", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at)
			VALUES ('old','org-1','work-1','work.accepted','user','owner','${changedAt}')`);
		vi.mocked(Date.now).mockReturnValue(Date.parse(through) + 15 * 60_000 + 1);
		const fetch = vi.fn();
		const counts = await dispatchCommitmentWakes(
			{
				DB: binding,
				ENVIRONMENT: "test",
				TEDI_SERVICE: { fetch },
			} as unknown as CloudflareEnv,
			Date.parse(through) + 30_000,
		);
		expect(counts).toMatchObject({ windowsSkippedMaxAge: 1, dispatched: 0 });
		expect(fetch).not.toHaveBeenCalled();
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
	});

	it("delivers at the age boundary and only skips older windows in a mixed tick", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES
			('old','org-1','work-1','work.accepted','user','owner','${changedAt}'),
			('recent','org-1','work-1','work.accepted','user','owner','2026-10-16T12:03:00.000Z')`);
		vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-16T12:19:00.000Z"));
		const fetch = vi.fn(async () =>
			Response.json({ run_id: "run", accepted: true }),
		);
		const counts = await dispatchCommitmentWakes(
			{
				DB: binding,
				ENVIRONMENT: "test",
				TEDI_SERVICE: { fetch },
			} as unknown as CloudflareEnv,
			Date.parse("2026-10-16T12:06:30.000Z"),
		);
		expect(counts).toMatchObject({
			windowsSkippedMaxAge: 1,
			dispatched: 1,
			observed: 1,
			windowsProcessed: 3,
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-16T12:06:00.000Z",
		);
	});
	it("seeks the polling time window before joining Work ownership", async () => {
		const plans: string[] = [];
		const { db } = fixture(plans);
		await listCommitmentChanges(db, after, through, "production");
		expect(plans).toContain("MATERIALIZE recent_work_events");
		for (const name of [
			"idx_work_items_deadline",
			"idx_work_items_due_date",
			"idx_work_approval_resolved",
			"idx_approval_requests_resolved",
			"idx_work_interaction_responses_time",
			"idx_work_interactions_due",
			"idx_os_gadget_executions_completed",
			"idx_skill_runs_completed",
		]) {
			expect(plans, name).toContainEqual(
				expect.stringContaining(`USING INDEX ${name}`),
			);
		}
		expect(plans).toContainEqual(
			expect.stringMatching(
				/SEARCH work_events USING INDEX idx_work_events_occurred/,
			),
		);
	});
	it("keeps the initial failed scan boundary until a successful cron receipt", async () => {
		const { sqlite, db } = fixture();
		expect(await lastCommitmentWakeCheckpoint(db)).toBeNull();
		sqlite.exec(
			`INSERT INTO platform_cron_executions(id,schedule_id,cron,scheduled_at,started_at,status,affected_row_counts,created_at) VALUES ('tick-1','commitment-wakes','*/2 * * * *','${after}','${after}','failure','{}','${after}'),('tick-2','commitment-wakes','*/2 * * * *','${through}','${through}','running','{}','${through}')`,
		);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-16T11:56:00.000Z",
		);
		sqlite.exec(
			"UPDATE platform_cron_executions SET status='success' WHERE id='tick-2'",
		);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
	});
	it("debounces until a whole window settles and replays the same windows after failure", () => {
		const now = Date.parse(through);
		expect(commitmentWakeWindows(null, now)).toEqual([
			{ after: "2026-10-16T11:58:00.000Z", through: after },
		]);
		expect(commitmentWakeWindows(after, now + 30_000)).toEqual([
			{ after, through },
		]);
		expect(commitmentWakeWindows(through, now + 30_000)).toEqual([]);
	});
	it("drains an old checkpoint in contiguous ten-window ticks", async () => {
		const { db, binding } = fixture();
		const start = "2026-10-17T12:18:00.000Z";
		const now = Date.parse("2026-10-19T15:04:40.000Z");
		await advanceCommitmentWakeCheckpoint(db, start);
		const env = { DB: binding, ENVIRONMENT: "test" } as CloudflareEnv;
		const counts = await dispatchCommitmentWakes(env, now);
		const first = "2026-10-17T12:38:00.000Z";
		expect(counts).toMatchObject({
			windowsProcessed: 10,
			checkpointMs: Date.parse(first),
		});
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(first);
		await dispatchCommitmentWakes(env, now);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-17T12:58:00.000Z",
		);
		await advanceCommitmentWakeCheckpoint(db, first);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-17T12:58:00.000Z",
		);
	});
	it("pins a fresh scheduler boundary when its first wake fails", async () => {
		const { sqlite, db, binding } = fixture();
		sqlite.exec(
			`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('first','org-1','work-1','work.accepted','user','owner','${changedAt}')`,
		);
		const env = {
			DB: binding,
			ENVIRONMENT: "test",
			TEDI_SERVICE: {
				fetch: async () => new Response("retry", { status: 503 }),
			},
		} as unknown as CloudflareEnv;
		await expect(
			dispatchCommitmentWakes(env, Date.parse(through) + 30_000),
		).rejects.toThrow();
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
	});
	it("retains accepted windows on later failure and retries with the same delivery key", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES
			('first','org-1','work-1','work.accepted','user','owner','${changedAt}'),
			('second','org-1','work-1','work.accepted','user','owner','2026-10-16T12:03:00.000Z')`);
		const keys: string[] = [];
		const fetch = vi.fn(async (request: Request) => {
			keys.push(
				((await request.json()) as { client_request_id: string })
					.client_request_id,
			);
			return keys.length === 2 || keys.length === 3
				? new Response("unavailable", { status: 503 })
				: Response.json({ run_id: "run-accepted", accepted: true });
		});
		const env = {
			DB: binding,
			ENVIRONMENT: "test",
			TEDI_SERVICE: { fetch },
		} as unknown as CloudflareEnv;
		const now = Date.parse("2026-10-16T12:06:30.000Z");
		await expect(dispatchCommitmentWakes(env, now)).rejects.toThrow();
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
		await dispatchCommitmentWakes(env, now);
		expect(keys[1]).toBe(keys[2]);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-16T12:06:00.000Z",
		);
		// Health receipts cannot jump over replay progress.
		sqlite.exec(
			`INSERT INTO platform_cron_executions(id,schedule_id,cron,scheduled_at,started_at,status,affected_row_counts,created_at) VALUES ('healthy','commitment-wakes','*/2 * * * *','2026-10-19T12:00:00.000Z','${after}','success','{}','${after}')`,
		);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(
			"2026-10-16T12:06:00.000Z",
		);
	});

	it.each([
		"run.started",
		"run.failed",
		"run.canceled",
		"run.completed",
	] as const)(
		"advances past an already delivered wake with canonical %s evidence",
		async (kind) => {
			const { sqlite, db, binding } = fixture();
			await advanceCommitmentWakeCheckpoint(db, after);
			sqlite.exec(
				`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('changed','org-1','work-1','work.accepted','user','owner','${changedAt}')`,
			);
			await db.insert(tediRuntimeEvents).values({
				id: "wake-receipt",
				organizationId: "org-1",
				tediId: "worker-1",
				kind,
				runId: buildRuntimeRunId({
					tediId: "worker-1",
					surface: "mcp",
					turnKey: `commitments:org-1:worker-1:${through}`,
				}),
				runtimeBackend: "cloudflare-agents",
				createdAt: changedAt,
			});
			const fetch = vi.fn(async () =>
				Response.json({ outcome: "failed" }, { status: 500 }),
			);
			const result = await dispatchCommitmentWakes(
				{
					DB: binding,
					ENVIRONMENT: "production",
					TEDI_SERVICE: { fetch },
				} as unknown as CloudflareEnv,
				Date.parse(through) + 30_000,
			);
			expect(result).toMatchObject({
				dispatched: 0,
				deduplicated: 1,
				windowsProcessed: 1,
			});
			expect(fetch).not.toHaveBeenCalled();
			expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
		},
	);
	it("recovers a lost transport response from a concurrently committed ingress receipt", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(
			`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('changed','org-1','work-1','work.accepted','user','owner','${changedAt}')`,
		);
		const fetch = vi.fn(async () => {
			await db.insert(tediRuntimeEvents).values({
				id: "accepted-during-send",
				organizationId: "org-1",
				tediId: "worker-1",
				kind: "run.started",
				runId: buildRuntimeRunId({
					tediId: "worker-1",
					surface: "mcp",
					turnKey: `commitments:org-1:worker-1:${through}`,
				}),
				runtimeBackend: "cloudflare-agents",
				createdAt: changedAt,
			});
			throw new Error("response lost");
		});
		const counts = await dispatchCommitmentWakes(
			{
				DB: binding,
				ENVIRONMENT: "production",
				TEDI_SERVICE: { fetch },
			} as unknown as CloudflareEnv,
			Date.parse(through) + 30_000,
		);
		expect(counts).toMatchObject({ deduplicated: 1, windowsProcessed: 1 });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
	});
	it("retains the window for an unacknowledged failure even with a foreign tenant receipt", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(
			`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('changed','org-1','work-1','work.accepted','user','owner','${changedAt}')`,
		);
		const runId = buildRuntimeRunId({
			tediId: "worker-1",
			surface: "mcp",
			turnKey: `commitments:org-1:worker-1:${through}`,
		});
		await db.insert(tediRuntimeEvents).values({
			id: "foreign-receipt",
			organizationId: "org-2",
			tediId: "worker-1",
			kind: "run.failed",
			runId,
			runtimeBackend: "cloudflare-agents",
			createdAt: changedAt,
		});
		const fetch = vi.fn(async () =>
			Response.json({ run_id: runId, outcome: "failed" }, { status: 500 }),
		);
		await expect(
			dispatchCommitmentWakes(
				{
					DB: binding,
					ENVIRONMENT: "production",
					TEDI_SERVICE: { fetch },
				} as unknown as CloudflareEnv,
				Date.parse(through) + 30_000,
			),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
	});

	it("suppresses self writes, completed Work, unchanged records and foreign tenants", async () => {
		const { sqlite, db } = fixture();
		const event = sqlite.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES (?,?,?,?,?,?,?)",
		);
		event.run(
			"event-1",
			"org-1",
			"work-1",
			"work.accepted",
			"user",
			"operator",
			changedAt,
		);
		event.run(
			"self",
			"org-1",
			"work-1",
			"work.specification_updated",
			"tedi",
			"worker-1",
			changedAt,
		);
		event.run(
			"foreign",
			"org-2",
			"work-1",
			"work.accepted",
			"user",
			"operator",
			changedAt,
		);
		let changes = await listCommitmentChanges(db, after, through, "production");
		expect(changes.map((change) => change.key)).toEqual(["work:event-1"]);
		expect(changes[0]?.tediId).toBe("worker-1");
		sqlite.exec("UPDATE work_items SET disposition='completed'");
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
	it("includes failed attempts and overdue owned commitments once at their crossing", async () => {
		const { sqlite, db } = fixture();
		sqlite.prepare("UPDATE work_items SET deadline=?").run(changedAt);
		sqlite
			.prepare(
				"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES ('failure','org-1','work-1','attempt.settled','system','runtime',?,?)",
			)
			.run(JSON.stringify({ outcome: "failed" }), changedAt);
		expect(
			(await listCommitmentChanges(db, after, through, "production"))
				.map((change) => change.state)
				.sort(),
		).toEqual(["failed", "overdue"]);
		expect(
			await listCommitmentChanges(
				db,
				through,
				"2026-10-16T12:04:00.000Z",
				"production",
			),
		).toEqual([]);
	});
	it("uses due date only without a deadline and keeps the time window exclusive at its start", async () => {
		const { sqlite, db } = fixture();
		sqlite
			.prepare("UPDATE work_items SET due_date=?, deadline=?")
			.run(changedAt, "2026-10-17T12:00:00.000Z");
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
		sqlite.exec("UPDATE work_items SET deadline=NULL");
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(row) => row.key,
			),
		).toEqual([`overdue:work-1:${changedAt}`]);
		sqlite.prepare("UPDATE work_items SET due_date=?").run(after);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
	it("wakes the requester when another actor answers an Interaction", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,created_at,status) VALUES ('ask-1','org-1','work-1','question','Scratch question','Continue?','tedi','worker-1','${after}','resolved');`,
		);
		sqlite
			.prepare(
				"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES ('answer-1','org-1','ask-1',1,'fence','user','operator','Proceed','answer',1,?)",
			)
			.run(changedAt);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.state,
			),
		).toEqual(["answered"]);
		sqlite.exec(
			"UPDATE work_interaction_responses SET responder_type='tedi',responder_id='worker-1'",
		);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
	it("reads approval decisions and factory results and keeps AITL workflow continuations in their existing path", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`INSERT INTO work_approval_proposals (id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,resolved_at) VALUES ('proposal-1','org-1','work-1',1,'review','execute','{}','tedi','worker-1','user','operator','approved','Scratch review','2026-10-17T00:00:00.000Z','${after}','${changedAt}');
		INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES ('decision-1','proposal-1',1,'approved','user','operator','Bounded','${changedAt}');
		INSERT INTO tedi_approval_requests(id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at,resolved_at,resolved_by,workflow_id) VALUES ('aitl-1','worker-1','org-1','scratch','Scratch approval','{}','approved','${after}','2026-10-17T00:00:00.000Z','${changedAt}','operator','workflow-1');
		INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,tedi_id,created_by_kind,created_by_id,created_at,completed_at,runtime_environment) VALUES ('run-1','org-1','workspace-1','gadget-1','failed','[]','{}','worker-1','user','operator','${after}','${changedAt}','production');`);
		expect(
			(await listCommitmentChanges(db, after, through, "production"))
				.map((change) => change.kind)
				.sort(),
		).toEqual(["approval", "factory_run"]);
		sqlite.exec(
			"UPDATE work_approval_decisions SET decider_type='tedi', decider_id='worker-1'",
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.kind,
			),
		).toEqual(["factory_run"]);
	});
	it("isolates factory environments, requires a skill commitment, and avoids counting gadget runs twice", async () => {
		const { sqlite, db } = fixture();
		const insert = sqlite.prepare(
			"INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,completed_at,work_item_id) VALUES (?,'org-1','skill-1','worker-1',?,?,'completed',?,?)",
		);
		insert.run(
			"skill-prod",
			"workflow-prod",
			"production",
			changedAt,
			"work-1",
		);
		insert.run("skill-stage", "workflow-stage", "staging", changedAt, "work-1");
		insert.run(
			"skill-unlinked",
			"workflow-unlinked",
			"production",
			changedAt,
			null,
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["skill-prod"]);
		sqlite.exec(
			`INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,tedi_id,created_by_kind,created_by_id,created_at,completed_at,runtime_environment,run_id) VALUES ('gadget-prod','org-1','workspace-1','gadget-1','completed','[]','{}','worker-1','user','operator','${after}','${changedAt}','production','skill-prod');`,
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["gadget-prod"]);
		sqlite.exec(
			"UPDATE os_gadget_executions SET runtime_environment='staging'",
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["skill-prod"]);
	});
	it("batches meaningful changes in one durable, replay-safe context turn", async () => {
		const changes = [
			{
				key: "work:event-1",
				orgId: "org-1",
				tediId: "worker-1",
				slug: "orion",
				kind: "work" as const,
				objectId: "work-1",
				state: "failed",
				changedAt,
			},
		];
		const request = buildCommitmentWakeRequest(changes, through, "production");
		const body = (await request.json()) as {
			client_request_id: string;
			text: string;
			metadata: object;
		};
		expect(body.client_request_id).toBe(
			(
				(await buildCommitmentWakeRequest(
					changes,
					through,
					"production",
				).json()) as typeof body
			).client_request_id,
		);
		expect(body.text).toContain("Read these exact canonical objects");
		expect(body.text).toContain("no approval or Work Attempt");
		expect(body.metadata).not.toHaveProperty("workItemId");
		expect(request.headers.get("X-Tedix-Host")).toBe("orion.tedi.tedix.dev");
	});
});

it("verifies an external lane success even when lane done already completed Work", async () => {
	const { sqlite, db } = fixture();
	sqlite
		.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES ('lane-result','org-1','work-1','attempt.settled','external_agent','agent',?,?)",
		)
		.run(JSON.stringify({ outcome: "succeeded" }), changedAt);
	sqlite.exec("UPDATE work_items SET disposition='completed'");
	expect(
		(await listCommitmentChanges(db, after, through, "production")).map(
			(c) => c.state,
		),
	).toEqual(["succeeded"]);
	sqlite.exec("UPDATE work_items SET disposition='cancelled'");
	expect(await listCommitmentChanges(db, after, through, "production")).toEqual(
		[],
	);
});

describe("bounded commitment pages", () => {
	beforeEach(() =>
		vi.spyOn(Date, "now").mockReturnValue(Date.parse(through) + 30_000),
	);
	afterEach(() => vi.restoreAllMocks());
	it("uses indexed hot-path lookups on the complete migrated schema", async () => {
		const plans: string[] = [];
		const { db, sqlite } = fixture(plans, true);
		await listCommitmentChanges(db, after, through, "test", {
			limit: 25,
			cursor: null,
		});
		expect(plans).toContainEqual(
			expect.stringContaining(
				"SEARCH a USING INDEX uniq_work_attempt_number (org_id=? AND work_item_id=?)",
			),
		);
		expect(plans).toContainEqual(
			expect.stringContaining(
				"SEARCH g USING COVERING INDEX idx_os_gadget_executions_run (organization_id=? AND run_id=? AND runtime_environment=?)",
			),
		);
		// Materialized, time-range result sets may scan; persistent hot tables must seek.
		expect(
			plans.filter((line) =>
				/SCAN (work_events|work_items|work_attempts|work_approval_proposals|work_interactions|work_interaction_responses|skill_runs|os_gadget_executions|tedis)\b/.test(
					line,
				),
			),
		).toEqual([]);
		await advanceCommitmentWakeCheckpoint(db, after);
		const cursor = { changedAt, key: "work:z", tediId: "worker-1" };
		await advanceCommitmentWakeCursor(db, after, cursor);
		await advanceCommitmentWakeCursor(db, after, { ...cursor, key: "work:a" });
		expect(await getCommitmentWakeCursor(db, after)).toEqual(cursor);
		await advanceCommitmentWakeCheckpoint(db, through);
		await advanceCommitmentWakeCursor(db, after, cursor);
		expect(await getCommitmentWakeCursor(db, through)).toBeNull();
		sqlite.close();
	});
	it("times out an unresponsive wake and preserves replay progress", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(
			`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('a','org-1','work-1','work.accepted','user','owner','${changedAt}')`,
		);
		vi.useFakeTimers();
		try {
			const fetch = vi.fn(() => new Promise<Response>(() => {}));
			const result = dispatchCommitmentWakes(
				{
					DB: binding,
					ENVIRONMENT: "test",
					TEDI_SERVICE: { fetch },
				} as unknown as CloudflareEnv,
				Date.parse(through) + 30_000,
			);
			const rejected = expect(result).rejects.toThrow(
				"Commitment wake delivery failed",
			);
			await vi.advanceTimersByTimeAsync(10_000);
			await rejected;
			expect(fetch).toHaveBeenCalledTimes(2);
			expect(
				(fetch.mock.calls[0] as unknown as [Request])[0].signal.aborted,
			).toBe(true);
			expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
		} finally {
			vi.useRealTimers();
		}
	});
	it("defers a whole page when earlier windows used the remaining run budget", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		const insert = sqlite.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES (?,'org-1','work-1','work.accepted','user','owner',?)",
		);
		for (let i = 0; i < MAX_COMMITMENT_CHANGES_PER_RUN - 1; i++)
			insert.run(`early-${i}`, changedAt);
		insert.run("later-a", "2026-10-16T12:03:00.000Z");
		insert.run("later-b", "2026-10-16T12:03:00.000Z");
		const fetch = vi.fn(async () =>
			Response.json({ run_id: "accepted", accepted: true }),
		);
		const env = {
			DB: binding,
			ENVIRONMENT: "test",
			TEDI_SERVICE: { fetch },
		} as unknown as CloudflareEnv;
		const now = Date.parse("2026-10-16T12:04:30.000Z");
		expect(await dispatchCommitmentWakes(env, now)).toMatchObject({
			observed: MAX_COMMITMENT_CHANGES_PER_RUN - 1,
			budgetExhausted: 1,
		});
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
		expect(await dispatchCommitmentWakes(env, now)).toMatchObject({
			observed: 2,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("resumes a dense window without dropping equal-time changes or reusing page delivery keys", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		const total = MAX_COMMITMENT_CHANGES_PER_RUN + 2;
		const insert = sqlite.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES (?,'org-1','work-1','work.accepted','user','owner',?)",
		);
		for (let i = 0; i < total; i++)
			insert.run(`event-${String(i).padStart(4, "0")}`, changedAt);
		const keys: string[] = [];
		const fetch = vi.fn(async (request: Request) => {
			keys.push(
				((await request.json()) as { client_request_id: string })
					.client_request_id,
			);
			return Response.json({ run_id: "accepted", accepted: true });
		});
		const env = {
			DB: binding,
			ENVIRONMENT: "test",
			TEDI_SERVICE: { fetch },
		} as unknown as CloudflareEnv;
		expect(
			await dispatchCommitmentWakes(env, Date.parse(through) + 30_000),
		).toMatchObject({
			observed: MAX_COMMITMENT_CHANGES_PER_RUN,
			budgetExhausted: 1,
		});
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
		expect(
			await dispatchCommitmentWakes(env, Date.parse(through) + 30_000),
		).toMatchObject({ observed: 2 });
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
		expect(new Set(keys).size).toBe(2);
	});

	it("continues to the other tedi when one wake fails and leaves the page retryable", async () => {
		const { sqlite, db, binding } = fixture();
		await advanceCommitmentWakeCheckpoint(db, after);
		sqlite.exec(`INSERT INTO work_items(id,org_id,title,created_at,disposition,accountable_owner_type,accountable_owner_id) VALUES ('work-2','org-2','Other','${after}','accepted','tedi','worker-2');
	INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('a','org-1','work-1','work.accepted','user','owner','${changedAt}'),('b','org-2','work-2','work.accepted','user','owner','${changedAt}');`);
		const fetch = vi.fn(async (request: Request) =>
			request.headers.get("X-Tedix-Host")?.startsWith("orion.")
				? new Response("retry", { status: 503 })
				: Response.json({ run_id: "accepted", accepted: true }),
		);
		await expect(
			dispatchCommitmentWakes(
				{
					DB: binding,
					ENVIRONMENT: "test",
					TEDI_SERVICE: { fetch },
				} as unknown as CloudflareEnv,
				Date.parse(through) + 30_000,
			),
		).rejects.toThrow();
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
	});
});

it("wakes the project's lead tedi for a lane without a Work-level owner", async () => {
	const { sqlite, db } = fixture();
	sqlite
		.prepare(
			"INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES ('project','org-1','EXAMPLE','Example','worker-1',?)",
		)
		.run(after);
	sqlite.exec(
		"UPDATE work_items SET accountable_owner_type=NULL,accountable_owner_id=NULL,project_id='project'",
	);
	sqlite
		.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES ('lane-result','org-1','work-1','attempt.settled','external_agent','agent',?,?)",
		)
		.run(JSON.stringify({ outcome: "succeeded" }), changedAt);
	expect(
		(await listCommitmentChanges(db, after, through, "production")).map(
			(c) => c.tediId,
		),
	).toEqual(["worker-1"]);
});
