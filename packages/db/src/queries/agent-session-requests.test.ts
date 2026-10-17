import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { agentSessionRequests } from "../schema/agent-session-requests";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listAgentSessionRequests,
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
