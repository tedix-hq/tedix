import { DatabaseSync } from "node:sqlite";
import type {
	WorkspaceChangeInput,
	WorkspaceChangeQueueMessage,
} from "@tedix/api-contract/schemas/workspace-feed";
import { createDbQueryClient } from "@tedix/db/query-client";
import { kernelConversations } from "@tedix/db/schema/cognitive-runtime";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	createWorkspaceFeedConsumer,
	type WorkspaceFeedMessage,
} from "./consumer";
import { createWorkspaceFeed, type WorkspaceFeedQueue } from "./feed";
import {
	createWorkspaceFeedLedger,
	type WorkspaceFeedSqlStorage,
} from "./ledger";
import { reconcileWorkspaceFeed } from "./reconcile";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OUTPUT = "00000000-0000-4000-8000-000000000010";

/** `node:sqlite` driven through the Durable Object `SqlStorage` shape. */
function sqlStorage(db: DatabaseSync): WorkspaceFeedSqlStorage {
	return {
		exec(query, ...bindings) {
			const statement = db.prepare(query);
			const rows = /^\s*select/i.test(query)
				? (statement.all(...(bindings as never[])) as never[])
				: (statement.run(...(bindings as never[])), []);
			return { toArray: () => rows };
		},
	};
}

function coreDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);");
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			kernelConversations,
			workspaceFeedCursors,
			workspaceActivity,
			workspaceOutputIndex,
			workspaceWorkLinks,
		),
	);
	return createDbQueryClient(createD1Facade(sqlite));
}

function fakeQueue() {
	const sent: WorkspaceChangeQueueMessage[] = [];
	const queue: WorkspaceFeedQueue = {
		async send(message) {
			sent.push(message);
		},
	};
	return { queue, sent };
}

function change(revision: number, title?: string): WorkspaceChangeInput {
	return {
		workspaceId: WS,
		organizationId: ORG,
		kind: "output",
		id: OUTPUT,
		revision,
		actor: { kind: "tedi", id: "tedi-1" },
		changeRecordId: `rev-${revision}`,
		at: `2026-11-07T10:00:0${revision}.000Z`,
		summary: title ? { title, outputKind: "document" } : undefined,
	};
}

function asMessages(bodies: unknown[]) {
	const log: string[] = [];
	const messages: WorkspaceFeedMessage[] = bodies.map((body, index) => ({
		body,
		ack: () => log.push(`ack:${index}`),
		retry: (options) =>
			log.push(`retry:${index}:${options?.delaySeconds ?? 0}`),
	}));
	return { messages, log };
}

describe("workspace feed", () => {
	it("emits in sequence, projects within one consume, and reports zero drift", async () => {
		const ledger = createWorkspaceFeedLedger(
			sqlStorage(new DatabaseSync(":memory:")),
			{
				workspaceId: WS,
			},
		);
		const { queue, sent } = fakeQueue();
		const feed = createWorkspaceFeed({ ledger, queue });
		const first = await feed.emit(change(1, "Plan"));
		const second = await feed.emit(change(2));
		expect([first.seq, second.seq]).toEqual([1, 2]);
		expect(sent.map((message) => message.event.seq)).toEqual([1, 2]);

		const db = coreDb();
		const consumer = createWorkspaceFeedConsumer({ db });
		const { messages, log } = asMessages(sent);
		const result = await consumer.consume(messages);
		expect(result).toEqual({ outcomes: ["applied", "applied"], applied: 2 });
		expect(log).toEqual(["ack:0", "ack:1"]);

		const report = await reconcileWorkspaceFeed(db, await feed.snapshot());
		expect(report.drift).toEqual([]);
		expect(report.replayFromSeq).toBeNull();
	});

	it("acks redelivery, delays a message ahead of a gap, and replays to close it", async () => {
		const ledger = createWorkspaceFeedLedger(
			sqlStorage(new DatabaseSync(":memory:")),
			{
				workspaceId: WS,
			},
		);
		const { queue, sent } = fakeQueue();
		const feed = createWorkspaceFeed({ ledger, queue });
		for (let revision = 1; revision <= 3; revision += 1)
			await feed.emit(change(revision));

		const db = coreDb();
		const consumer = createWorkspaceFeedConsumer({ db });
		// seq 2 is lost on the way; seq 1 arrives twice; a stray body is poison.
		const { messages, log } = asMessages([
			sent[0],
			sent[2],
			sent[0],
			{ kind: "something_else" },
		]);
		const result = await consumer.consume(messages);
		expect(result.outcomes).toEqual(["applied", "gap", "duplicate", "poison"]);
		expect(log).toEqual(["ack:3", "ack:0", "retry:1:5", "ack:2"]);

		const behind = await reconcileWorkspaceFeed(db, await feed.snapshot());
		expect(behind.drift).toContainEqual({
			kind: "cursor",
			objectSeq: 3,
			projectionSeq: 1,
		});
		expect(behind.replayFromSeq).toBe(2);

		sent.length = 0;
		expect(await feed.replayFrom(behind.replayFromSeq!)).toEqual({
			sent: 2,
			lastSeq: 3,
		});
		await consumer.consume(asMessages(sent).messages);
		const settled = await reconcileWorkspaceFeed(db, await feed.snapshot());
		expect(settled.drift).toEqual([]);
	});
});

it("reports missing history below the cursor as requiring rebuild, not successful replay", async () => {
	const ledger = createWorkspaceFeedLedger(
		sqlStorage(new DatabaseSync(":memory:")),
		{ workspaceId: WS },
	);
	const { queue, sent } = fakeQueue();
	const feed = createWorkspaceFeed({ ledger, queue });
	await feed.emit(change(1));
	await feed.emit(change(2));
	const db = coreDb();
	await createWorkspaceFeedConsumer({ db }).consume(asMessages(sent).messages);
	await db.delete(workspaceActivity);
	const report = await reconcileWorkspaceFeed(db, await feed.snapshot());
	expect(report.drift.length).toBeGreaterThan(0);
	expect(report.rebuildRequired).toBe(true);
	expect(report.replayFromSeq).toBeNull();
});
