import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import {
	agentSessionRequests,
	agentSessionEvents,
} from "../schema/agent-session-requests";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getPreviousAgentSessionTurn,
	getAgentSessionRequestPrompts,
	listAgentSessionRequests,
	recordAgentSessionEvents,
	recordAgentSessionRequests,
	retryFailedAgentSessionEvents,
	updateAgentSessionRequests,
} from "./agent-session-requests";

const ORG = "org-example";
const USER = "user-ada";
const OTHER_USER = "user-grace";
const T0 = "2026-10-06T10:00:00.000Z";
const T1 = "2026-10-06T10:05:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(agentSessionRequests));
	sqlite.exec(schemaDdl(agentSessionEvents));
	return createDbQueryClient(createD1Facade(sqlite));
}

function record(
	db: ReturnType<typeof fixture>,
	overrides: Partial<Parameters<typeof recordAgentSessionRequests>[1]> = {},
) {
	return recordAgentSessionRequests(db, {
		organizationId: ORG,
		userId: USER,
		harness: "claude-code",
		sessionKey: "session-1",
		repository: "example/app",
		sourceAt: T0,
		sourceKey: "message-1",
		requests: [
			{ kind: "request", text: "Add a dark mode toggle" },
			{ kind: "question", text: "Why does the build take four minutes?" },
		],
		now: T0,
		...overrides,
	});
}

describe("agent session request ledger", () => {
	it("records each request once per message", async () => {
		const db = fixture();
		expect(await record(db)).toHaveLength(2);
		expect(await record(db)).toHaveLength(0);
		const rows = await listAgentSessionRequests(db, {
			organizationId: ORG,
			userId: USER,
		});
		expect(rows.map((row) => [row.kind, row.status])).toEqual([
			["request", "open"],
			["question", "open"],
		]);
	});

	it("records more rows than one D1 statement can bind", async () => {
		const db = fixture();
		const requests = Array.from({ length: 8 }, (_, index) => ({
			kind: "request" as const,
			text: `Request ${index}`,
		}));
		expect(await record(db, { requests })).toHaveLength(8);
	});

	it("reads the newest rows first when asked, so a bounded read keeps them", async () => {
		const db = fixture();
		await record(db);
		await record(db, {
			sourceKey: "message-2",
			sourceAt: T1,
			requests: [{ kind: "request", text: "Ship the docs" }],
		});
		const [newest] = await listAgentSessionRequests(db, {
			organizationId: ORG,
			userId: USER,
			limit: 1,
			newestFirst: true,
		});
		expect(newest?.text).toBe("Ship the docs");
	});

	it("never shows one person's rows to another", async () => {
		const db = fixture();
		await record(db);
		expect(
			await listAgentSessionRequests(db, {
				organizationId: ORG,
				userId: OTHER_USER,
			}),
		).toEqual([]);
	});

	it("filters by status and session", async () => {
		const db = fixture();
		const [first] = await record(db);
		await record(db, { sessionKey: "session-2", sourceKey: "message-2" });
		await updateAgentSessionRequests(db, {
			organizationId: ORG,
			userId: USER,
			updates: [{ id: first!.id, status: "done", evidence: "abc1234" }],
			now: T1,
		});
		const open = await listAgentSessionRequests(db, {
			organizationId: ORG,
			userId: USER,
			statuses: ["open"],
			harness: "claude-code",
			sessionKey: "session-1",
		});
		expect(open.map((row) => row.text)).toEqual([
			"Why does the build take four minutes?",
		]);
		const [done] = await listAgentSessionRequests(db, {
			organizationId: ORG,
			userId: USER,
			statuses: ["done"],
		});
		expect(done).toMatchObject({ evidence: "abc1234", statusChangedAt: T1 });
	});

	it("records agent asks as waiting on the user", async () => {
		const db = fixture();
		const [ask] = await record(db, {
			requests: [{ kind: "ask", text: "Approve the README publication" }],
		});
		expect(ask).toMatchObject({ kind: "ask", status: "waiting_on_user" });
	});
});

it("reads the preceding turn only from the same owner, harness and session, before the user reply", async () => {
	const db = fixture();
	const add = async (
		org: string,
		user: string,
		session: string,
		harness: "claude-code" | "codex",
		kind: "prompt" | "turn",
		at: string,
		body: string,
	) =>
		recordAgentSessionEvents(db, {
			organizationId: org,
			userId: user,
			events: [
				{
					harness,
					sessionKey: session,
					repository: null,
					kind,
					body,
					activity: null,
					sourceAt: at,
					sourceKey: `${org}:${user}:${session}:${harness}:${kind}:${at}`,
				},
			],
			now: at,
		});
	await add(ORG, USER, "chat-a", "claude-code", "turn", T0, "Older question.");
	await add(
		ORG,
		USER,
		"chat-a",
		"claude-code",
		"turn",
		"2026-10-06T10:04:00.000Z",
		"Choose option one or two.",
	);
	await add(
		ORG,
		USER,
		"chat-a",
		"claude-code",
		"turn",
		T1,
		"Future result must not be read.",
	);
	await add(
		ORG,
		USER,
		"chat-a",
		"claude-code",
		"prompt",
		"2026-10-06T10:04:30.000Z",
		"User prompt is not agent context.",
	);
	await add(
		"org-other",
		USER,
		"chat-a",
		"claude-code",
		"turn",
		"2026-10-06T10:04:40.000Z",
		"Other organization.",
	);
	await add(
		ORG,
		OTHER_USER,
		"chat-a",
		"claude-code",
		"turn",
		"2026-10-06T10:04:40.000Z",
		"Other person.",
	);
	await add(
		ORG,
		USER,
		"chat-b",
		"claude-code",
		"turn",
		"2026-10-06T10:04:40.000Z",
		"Other chat.",
	);
	await add(
		ORG,
		USER,
		"chat-a",
		"codex",
		"turn",
		"2026-10-06T10:04:40.000Z",
		"Other harness.",
	);
	expect(
		await getPreviousAgentSessionTurn(db, {
			organizationId: ORG,
			userId: USER,
			harness: "claude-code",
			sessionKey: "chat-a",
			before: T1,
		}),
	).toBe("Choose option one or two.");
	expect(
		await getPreviousAgentSessionTurn(db, {
			organizationId: ORG,
			userId: USER,
			harness: "claude-code",
			sessionKey: "chat-a",
			before: T1,
			kind: "prompt",
		}),
	).toBe("User prompt is not agent context.");
	expect(
		await getPreviousAgentSessionTurn(db, {
			organizationId: ORG,
			userId: USER,
			harness: "claude-code",
			sessionKey: "chat-a",
			before: T0,
		}),
	).toBeNull();
});

it("retries only the owner's exact failed events and preserves their source", async () => {
	const db = fixture();
	const put = (
		organizationId: string,
		userId: string,
		key: string,
		sessionKey: string,
		sourceAt = T0,
	) =>
		recordAgentSessionEvents(db, {
			organizationId,
			userId,
			now: T0,
			events: [
				{
					harness: "claude-code",
					sessionKey,
					repository: null,
					kind: "turn",
					body: "Original redacted source",
					activity: null,
					sourceAt,
					sourceKey: key,
				},
			],
		});
	await put(ORG, USER, "failed", "chat-a");
	await put(ORG, OTHER_USER, "failed", "chat-a");
	await put("org-other", USER, "failed", "chat-a");
	await db
		.update(agentSessionEvents)
		.set({ status: "failed", attempts: 3 })
		.where(eq(agentSessionEvents.sourceKey, "failed"));
	await put(ORG, USER, "done", "other-chat", T1);
	await put(ORG, OTHER_USER, "foreign-later", "chat-a", T1);
	for (const key of ["done", "foreign-later"])
		await db
			.update(agentSessionEvents)
			.set({ status: "processed", attempts: 1 })
			.where(eq(agentSessionEvents.sourceKey, key));
	await put(ORG, USER, "pending", "pending-chat");
	expect(
		await retryFailedAgentSessionEvents(db, {
			organizationId: ORG,
			userId: USER,
			sourceKeys: ["failed", "done", "pending"],
		}),
	).toBe(1);
	const all = await db.select().from(agentSessionEvents);
	expect(
		all.find(
			(r) =>
				r.organizationId === ORG &&
				r.userId === USER &&
				r.sourceKey === "failed",
		),
	).toMatchObject({
		status: "pending",
		attempts: 0,
		body: "Original redacted source",
	});
	expect(
		all
			.filter(
				(r) =>
					r.sourceKey === "failed" &&
					(r.organizationId !== ORG || r.userId !== USER),
			)
			.map((r) => [r.status, r.attempts]),
	).toEqual([
		["failed", 3],
		["failed", 3],
	]);
	expect(all.find((r) => r.sourceKey === "done")).toMatchObject({
		status: "processed",
		attempts: 1,
	});
	expect(all.find((r) => r.sourceKey === "pending")).toMatchObject({
		status: "pending",
		attempts: 0,
	});
});

it("refuses to rewind past a later processed or leased event in that session", async () => {
	const db = fixture();
	await recordAgentSessionEvents(db, {
		organizationId: ORG,
		userId: USER,
		now: T0,
		events: [T0, T1].map((sourceAt, i) => ({
			harness: "claude-code",
			sessionKey: "chat-a",
			repository: null,
			kind: "turn",
			body: "Redacted source",
			activity: null,
			sourceAt,
			sourceKey: `event-${i}`,
		})),
	});
	await db
		.update(agentSessionEvents)
		.set({ status: "failed", attempts: 3 })
		.where(eq(agentSessionEvents.sourceKey, "event-0"));
	await db
		.update(agentSessionEvents)
		.set({ status: "processed" })
		.where(eq(agentSessionEvents.sourceKey, "event-1"));
	const retry = () =>
		retryFailedAgentSessionEvents(db, {
			organizationId: ORG,
			userId: USER,
			sourceKeys: ["event-0"],
		});
	expect(await retry()).toBe(0);
	await db
		.update(agentSessionEvents)
		.set({ status: "pending", claimedAt: T1 })
		.where(eq(agentSessionEvents.sourceKey, "event-1"));
	expect(await retry()).toBe(0);
	await db
		.update(agentSessionEvents)
		.set({ claimedAt: null })
		.where(eq(agentSessionEvents.sourceKey, "event-1"));
	expect(await retry()).toBe(1);
});

it("recovers original prompts without later goals or another owner's events", async () => {
	const db = fixture();
	const original = "Review the authentication integration and report findings.";
	for (const [organizationId, userId, sessionKey, harness, sourceAt, body] of [
		[ORG, USER, "session-1", "claude-code", T0, original],
		[
			ORG,
			USER,
			"session-1",
			"claude-code",
			T1,
			"Now implement the findings and deploy.",
		],
		["org-other", USER, "session-1", "claude-code", T0, "Other org"],
		[ORG, OTHER_USER, "session-1", "claude-code", T0, "Other owner"],
		[ORG, USER, "session-other", "claude-code", T0, "Other session"],
		[ORG, USER, "session-1", "codex", T0, "Other harness"],
	] as const) {
		await recordAgentSessionEvents(db, {
			organizationId,
			userId,
			now: sourceAt,
			events: [
				{
					sessionKey,
					harness,
					sourceAt,
					body,
					kind: "prompt",
					repository: null,
					activity: null,
					sourceKey: `${organizationId}:${userId}:${sessionKey}:${harness}:${sourceAt}`,
				},
			],
		});
	}
	const requests = Array.from({ length: 55 }, (_, i) => ({
		kind: "request" as const,
		text: `Review item ${i}`,
	}));
	const own = await record(db, { requests });
	const other = await record(db, { userId: OTHER_USER });
	const prompts = await getAgentSessionRequestPrompts(db, {
		organizationId: ORG,
		userId: USER,
		ids: [...own, ...other].map((row) => row.id),
	});
	expect(prompts).toHaveLength(55);
	expect(prompts.every((row) => row.message === original)).toBe(true);
	expect(
		await getAgentSessionRequestPrompts(db, {
			organizationId: ORG,
			userId: USER,
			ids: [],
		}),
	).toEqual([]);
});
