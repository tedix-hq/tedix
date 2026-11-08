import { publishWorkspaceAction } from "./action-publication";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceChangeEvent } from "@tedix/api-contract/schemas/workspace-feed";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { kernelConversations } from "../../schema/cognitive-runtime";
import { osWorkspaces } from "../../schema/os-workspaces";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceFeedLedger,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "../../schema/workspace-feed";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	appendWorkspaceFeedLedger,
	listWorkspaceFeedLedger,
	snapshotWorkspaceFeedLedger,
} from "./ledger";
import {
	applyWorkspaceChangeEvents,
	getWorkspaceFeedCursor,
} from "./projection";
import {
	listWorkspaceActivity,
	listWorkspaceOutputLibrary,
	listWorkspaceWorkLinksForWorkItem,
} from "./read";
import { snapshotWorkspaceProjection } from "./reconcile";

const ORG = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-000000000002";
const OUTPUT = "00000000-0000-4000-8000-000000000010";
const WORK = "00000000-0000-4000-8000-000000000020";
const viewer = { userIds: ["user-1"] };

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		"CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL); INSERT INTO organizations VALUES ('" +
			ORG +
			"');",
	);
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			kernelConversations,
			workspaceFeedLedger,
			workspaceFeedCursors,
			workspaceActivity,
			workspaceOutputIndex,
			workspaceWorkLinks,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		id: WS,
		organizationId: ORG,
		name: "Finance",
		status: "active",
		visibility: "org",
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-11-07T09:00:00.000Z",
		updatedAt: "2026-11-07T09:00:00.000Z",
	});
	return db;
}

function event(
	seq: number,
	patch: Partial<WorkspaceChangeEvent> = {},
): WorkspaceChangeEvent {
	return {
		workspaceId: WS,
		organizationId: ORG,
		kind: "output",
		id: OUTPUT,
		revision: 1,
		actor: { kind: "user", id: "user-1" },
		changeRecordId: `rev-${seq}`,
		at: `2026-11-07T10:00:0${seq}.000Z`,
		seq,
		summary: {},
		...patch,
	};
}

describe("applyWorkspaceChangeEvents", () => {
	it("projects an output through create, revise and rename", async () => {
		const db = await fixture();
		const first = await applyWorkspaceChangeEvents(db, [
			event(1, {
				summary: {
					title: "Q4 plan",
					outputKind: "document",
					excerpt: "Revenue targets for Q4",
					workItemIds: [WORK],
				},
			}),
		]);
		expect(first.outcomes.get(1)).toBe("applied");
		expect(await getWorkspaceFeedCursor(db, WS)).toBe(1);

		const library = await listWorkspaceOutputLibrary(db, {
			organizationId: ORG,
			viewer,
		});
		expect(library).toHaveLength(1);
		expect(library[0]?.index).toMatchObject({
			outputId: OUTPUT,
			revision: 1,
			isCurrent: 1,
			title: "Q4 plan",
			searchText: "revenue targets for q4",
		});
		expect(library[0]?.workspace).toEqual({
			id: WS,
			name: "Finance",
			status: "active",
		});
		expect(
			await listWorkspaceWorkLinksForWorkItem(db, {
				organizationId: ORG,
				workItemId: WORK,
			}),
		).toHaveLength(1);

		await applyWorkspaceChangeEvents(db, [
			event(2, {
				revision: 2,
				changeRecordId: "rev-2",
				summary: { excerpt: "Revised revenue targets", workItemIds: [] },
			}),
			event(3, {
				revision: 2,
				changeRecordId: "rev-2",
				summary: { title: "Q4 plan (final)" },
			}),
		]);
		const current = await listWorkspaceOutputLibrary(db, {
			organizationId: ORG,
			viewer,
		});
		expect(current).toHaveLength(1);
		expect(current[0]?.index).toMatchObject({
			id: `${OUTPUT}:2`,
			revisionId: "rev-2",
			revision: 2,
			title: "Q4 plan (final)",
			searchText: "revised revenue targets",
		});
		expect(
			await listWorkspaceWorkLinksForWorkItem(db, {
				organizationId: ORG,
				workItemId: WORK,
			}),
		).toHaveLength(0);
		expect(
			await listWorkspaceOutputLibrary(
				db,
				{ organizationId: ORG, viewer },
				{ search: "FINAL" },
			),
		).toHaveLength(1);
		expect(
			await listWorkspaceOutputLibrary(
				db,
				{ organizationId: ORG, viewer },
				{ search: "nothing here" },
			),
		).toHaveLength(0);

		const activity = await listWorkspaceActivity(db, {
			organizationId: ORG,
			viewer,
		});
		expect(activity.map((row) => row.seq)).toEqual([3, 2, 1]);
	});

	it("acknowledges duplicates and holds back a gap", async () => {
		const db = await fixture();
		await applyWorkspaceChangeEvents(db, [event(1), event(2)]);
		const result = await applyWorkspaceChangeEvents(db, [
			event(2),
			event(1),
			event(4),
			event(3),
			event(5),
		]);
		expect(result.outcomes.get(1)).toBe("duplicate");
		expect(result.outcomes.get(2)).toBe("duplicate");
		expect(result.outcomes.get(3)).toBe("applied");
		expect(result.outcomes.get(4)).toBe("applied");
		expect(result.outcomes.get(5)).toBe("applied");
		expect(result.lastSeq).toBe(5);
		const gap = await applyWorkspaceChangeEvents(db, [event(7)]);
		expect(gap.outcomes.get(7)).toBe("gap");
		expect(await getWorkspaceFeedCursor(db, WS)).toBe(5);
		const activity = await listWorkspaceActivity(db, {
			organizationId: ORG,
			viewer,
		});
		expect(activity).toHaveLength(5);
	});

	it("bumps the Home conversation index for chat events", async () => {
		const db = await fixture();
		await applyWorkspaceChangeEvents(db, [
			event(1, {
				kind: "chat",
				id: "msg-1",
				changeRecordId: "msg-1",
				summary: { conversationId: "ws:thread-1", title: "Budget chat" },
			}),
			event(2, {
				kind: "chat",
				id: "msg-2",
				changeRecordId: "msg-2",
				summary: { conversationId: "ws:thread-1" },
			}),
		]);
		const rows = await db.select().from(kernelConversations);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			conversationId: "ws:thread-1",
			workspaceId: WS,
			title: "Budget chat",
			messageCount: 2,
			lastMessageAt: "2026-11-07T10:00:02.000Z",
		});
	});

	it("matches the ledger snapshot after every event is applied", async () => {
		const db = await fixture();
		const inputs = [
			{ kind: "output" as const, id: OUTPUT, revision: 1 },
			{ kind: "output" as const, id: OUTPUT, revision: 2 },
			{ kind: "run" as const, id: "run-1", revision: 0 },
			{ kind: "memory" as const, id: "fact-1", revision: 1 },
		];
		const events: WorkspaceChangeEvent[] = [];
		for (const input of inputs) {
			events.push(
				await appendWorkspaceFeedLedger(db, {
					workspaceId: WS,
					organizationId: ORG,
					kind: input.kind,
					id: input.id,
					revision: input.revision,
					actor: { kind: "tedi", id: "tedi-1" },
					changeRecordId: `${input.id}:${input.revision}`,
					at: "2026-11-07T10:00:00.000Z",
				}),
			);
		}
		expect(events.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
		expect(
			(await listWorkspaceFeedLedger(db, { workspaceId: WS, fromSeq: 3 })).map(
				(row) => row.seq,
			),
		).toEqual([3, 4]);
		await applyWorkspaceChangeEvents(db, events);
		const ledger = await snapshotWorkspaceFeedLedger(db, WS);
		const projection = await snapshotWorkspaceProjection(db, WS);
		expect(projection).toEqual(ledger);
		expect(ledger).toEqual({
			workspaceId: WS,
			lastSeq: 4,
			kinds: {
				output: { records: 1, events: 2, latest: { [OUTPUT]: 2 } },
				run: { records: 1, events: 1, latest: { "run-1": 0 } },
				memory: { records: 1, events: 1, latest: { "fact-1": 1 } },
			},
		});
	});
});

describe("activity coverage", () => {
	it("requires the first event before advancing a new projection", async () => {
		const db = await fixture();
		const gap = await applyWorkspaceChangeEvents(db, [event(3)]);
		expect(gap.outcomes.get(3)).toBe("gap");
		expect(gap.lastSeq).toBe(0);
		await applyWorkspaceChangeEvents(db, [event(1), event(2), event(3)]);
		expect(await getWorkspaceFeedCursor(db, WS)).toBe(3);
	});

	it("publishes an action once after a lost reply and catches up earlier file events", async () => {
		const db = await fixture();
		await appendWorkspaceFeedLedger(
			db,
			event(1, { summary: { title: "Plan" } }),
		);
		const action = event(2, {
			kind: "run",
			id: "action-1",
			changeRecordId: "action-1",
			actor: { kind: "external_agent", id: "agent-1" },
			summary: {
				action: {
					resource: "output",
					operation: "revise",
					outcome: "applied",
					surface: "workspace_object",
					traceId: "turn-1",
					revisionId: "rev-1",
				},
			},
		});
		await publishWorkspaceAction(db, action);
		await publishWorkspaceAction(db, action);
		const ledger = await snapshotWorkspaceFeedLedger(db, WS);
		expect(ledger.lastSeq).toBe(2);
		expect(await snapshotWorkspaceProjection(db, WS)).toEqual(ledger);
		const rows = await listWorkspaceActivity(db, {
			organizationId: ORG,
			viewer,
		});
		expect(rows.map((row) => row.kind)).toEqual(["run", "output"]);
		expect(rows[0]).toMatchObject({
			actorKind: "external_agent",
			changeRecordId: "action-1",
		});
	});

	it("excludes orphaned workspace scopes and keeps equal timestamp/sequence pages complete", async () => {
		const db = await fixture();
		const second = "00000000-0000-4000-8000-000000000003";
		await db.insert(osWorkspaces).values({
			id: second,
			organizationId: ORG,
			name: "Other",
			visibility: "org",
			createdByKind: "user",
			createdById: "user-1",
		});
		await applyWorkspaceChangeEvents(db, [event(1)]);
		await applyWorkspaceChangeEvents(db, [event(1, { workspaceId: second })]);
		await applyWorkspaceChangeEvents(db, [event(1, { workspaceId: "orphan" })]);
		const first = (
			await listWorkspaceActivity(
				db,
				{ organizationId: ORG, viewer },
				{ limit: 1 },
			)
		)[0]!;
		const rest = await listWorkspaceActivity(
			db,
			{ organizationId: ORG, viewer },
			{
				before: { occurredAt: first.occurredAt, seq: first.seq, id: first.id },
			},
		);
		expect(rest).toHaveLength(1);
		expect(rest[0]?.workspaceId).not.toBe("orphan");
		expect(rest[0]?.id).not.toBe(first.id);
	});
});
