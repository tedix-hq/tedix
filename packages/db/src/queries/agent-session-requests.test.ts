import { DatabaseSync } from "node:sqlite";
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
	listAgentSessionRequests,
	recordAgentSessionEvents,
	recordAgentSessionRequests,
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
