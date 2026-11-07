import { env } from "cloudflare:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vite-plus/test";
import {
	osGadgets,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
import { workItems } from "@tedix/db/schema/work-items";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { storeOutputBody } from "../src/data-port-tenant";
import type { WorkspaceEnv, WorkspaceScope } from "../src/env";
import type { WorkspaceRpc } from "../src/do";
import type { ScriptStep } from "./worker";

const scope: WorkspaceScope = {
	organizationId: "org_test",
	workspaceId: "11111111-1111-4111-8111-111111111111",
};
const testEnv = env as unknown as WorkspaceEnv & {
	TEDI_AGENT: DurableObjectNamespace;
};

type Stub = WorkspaceRpc & {
	scriptModel(scope: WorkspaceScope, steps: ScriptStep[]): Promise<void>;
	importRows(
		scope: WorkspaceScope,
		batch: {
			batchId: string;
			table: string;
			rows: Record<string, string | number | null>[];
		},
	): Promise<unknown>;
};
function workspace(): Stub {
	return tenantStoreStub(testEnv.WORKSPACE, testEnv, scope) as unknown as Stub;
}

/** CREATE TABLE from the Drizzle definition, so inserts can use every column. */
function ddl(table: SQLiteTable): string {
	const columns = Object.values(getTableColumns(table)).map((column) => {
		const parts = [`"${column.name}"`, column.getSQLType()];
		if (column.primary) parts.push("PRIMARY KEY");
		else if (column.notNull && !column.hasDefault) parts.push("NOT NULL");
		return parts.join(" ");
	});
	return `CREATE TABLE IF NOT EXISTS "${getTableName(table)}" (${columns.join(", ")})`;
}

async function seedCore() {
	const now = "2026-11-07T10:00:00.000Z";
	for (const table of [
		osWorkspaces,
		osWorkspaceProjects,
		osWorkspaceResources,
		osGadgets,
		tedis,
		workItems,
	]) {
		await testEnv.DB.exec(ddl(table));
	}
	await testEnv.DB.batch([
		testEnv.DB.prepare(
			`INSERT OR REPLACE INTO os_workspaces (id, organization_id, name, description, status, created_by_kind, created_by_id, created_at, updated_at, visibility) VALUES (?, ?, ?, ?, 'active', 'user', 'u1', ?, ?, 'org')`,
		).bind(
			scope.workspaceId,
			scope.organizationId,
			"Programme workspace",
			"Challenge tracking",
			now,
			now,
		),
		testEnv.DB.prepare(
			`INSERT OR REPLACE INTO os_workspace_projects (id, organization_id, workspace_id, project_id, status, created_by_kind, created_by_id, created_at) VALUES ('wp1', ?, ?, 'proj1', 'active', 'user', 'u1', ?)`,
		).bind(scope.organizationId, scope.workspaceId, now),
		...[
			["w1", "Open one", "accepted"],
			["w2", "Open two", "in_progress"],
			["w3", "Open three", "proposed"],
			["w4", "Done", "completed"],
			["w5", "Dropped", "cancelled"],
		].map(([id, title, disposition]) =>
			testEnv.DB.prepare(
				`INSERT OR REPLACE INTO work_items (id, org_id, project_id, title, disposition, work_kind, created_at, updated_at) VALUES (?, ?, 'proj1', ?, ?, 'coding', ?, ?)`,
			).bind(id, scope.organizationId, title, disposition, now, now),
		),
		testEnv.DB.prepare(
			`INSERT OR REPLACE INTO tedis (id, organization_id, name, slug, isolate_agent_id, created_at, updated_at) VALUES ('tedi1', ?, 'Guest', 'guest', 'tedi-object-1', ?, ?)`,
		).bind(scope.organizationId, now, now),
	]);
}

async function seedOutputs(ws: Stub) {
	const now = "2026-11-07T10:00:00.000Z";
	const sheet = {
		kind: "sheet",
		columns: ["Challenge", "Owner"],
		rows: [
			["Problem statement", "-"],
			["Battery recycling", "A"],
			["Grid storage", "B"],
			["Cell chemistry", "C"],
			["Supply chain", "D"],
		],
	};
	const doc = {
		kind: "document",
		blocks: [
			{ type: "heading", level: 1, text: "Priorities" },
			{
				type: "list",
				items: ["Battery recycling", "Grid storage", "Cell chemistry"],
			},
		],
	};
	const sheetBody = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify(sheet),
	);
	const docBody = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify(doc),
	);
	await ws.importRows(scope, {
		batchId: "b-outputs",
		table: "os_outputs",
		rows: [
			{
				id: "out-sheet",
				organization_id: scope.organizationId,
				workspace_id: scope.workspaceId,
				kind: "sheet",
				title: "Challenges",
				status: "active",
				current_revision_id: "rev-sheet",
				created_by_kind: "user",
				created_by_id: "u1",
				created_at: now,
				updated_at: now,
			},
			{
				id: "out-doc",
				organization_id: scope.organizationId,
				workspace_id: scope.workspaceId,
				kind: "document",
				title: "Priorities",
				status: "active",
				current_revision_id: "rev-doc",
				created_by_kind: "user",
				created_by_id: "u1",
				created_at: now,
				updated_at: now,
			},
		],
	});
	await ws.importRows(scope, {
		batchId: "b-revisions",
		table: "os_output_revisions",
		rows: [
			{
				id: "rev-sheet",
				organization_id: scope.organizationId,
				output_id: "out-sheet",
				revision: 1,
				content: "",
				created_by_kind: "user",
				created_by_id: "u1",
				created_at: now,
				content_sha256: sheetBody.contentSha256,
				content_bytes: sheetBody.contentBytes,
				body_r2_key: sheetBody.bodyR2Key,
			},
			{
				id: "rev-doc",
				organization_id: scope.organizationId,
				output_id: "out-doc",
				revision: 1,
				content: "",
				created_by_kind: "user",
				created_by_id: "u1",
				created_at: now,
				content_sha256: docBody.contentSha256,
				content_bytes: docBody.contentBytes,
				body_r2_key: docBody.bodyR2Key,
			},
		],
	});
}

const READ_ONLY_CODE = `export default async (env) => {
	const outputs = await env.outputs.list();
	const sheet = await env.outputs.get(outputs.find((o) => o.kind === "sheet").id);
	const doc = await env.outputs.get(outputs.find((o) => o.kind === "document").id);
	const challenges = sheet.content.rows.filter((r) => r[0] !== "Problem statement").length;
	const priorities = doc.content.blocks.find((b) => b.type === "list").items;
	const open = await env.work.listOpen();
	return { challenges, priorities, openWork: open.length };
}`;

describe("WorkspaceDO", () => {
	test("answers the read-only benchmark question from its own bindings and records every read", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		await ws.scriptModel(scope, [
			{ code: READ_ONLY_CODE },
			{
				text: "4 challenges (excluding the problem statement), priorities: Battery recycling, Grid storage, Cell chemistry; 3 open Work items.",
			},
		]);
		const started = Date.now();
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Read-only check: how many challenges excluding the problem-statement row, the three tied priorities, open Work items",
		});
		const outcome = await ws.awaitTurn(scope, turnId, 20_000);
		const elapsed = Date.now() - started;
		expect(outcome.status).toBe("finished");
		expect(outcome.text).toContain("4 challenges");
		expect(outcome.text).toContain("3 open Work items");

		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const types = events.map((event) => event.type);
		expect(types[0]).toBe("conversation.updated");
		expect(types[1]).toBe("turn.started");
		expect(types.at(-1)).toBe("turn.finished");
		expect(types.at(-2)).toBe("assistant.done");
		const steps = events.filter((event) => event.type === "step.started");
		expect(
			steps.map((step) => (step.type === "step.started" ? step.label : "")),
		).toEqual([
			"Running code against the workspace",
			"Listing documents and sheets",
			"Reading a document or sheet",
			"Reading a document or sheet",
			"Reading open Work items",
		]);
		expect(
			events
				.filter((event) => event.type === "step.finished")
				.every(
					(event) => event.type === "step.finished" && event.status === "ok",
				),
		).toBe(true);
		const finished = events.at(-1);
		expect(finished?.type === "turn.finished" && finished.status).toBe("done");
		// The sandbox returned the real numbers, not the scripted text.
		const messages = await ws.readMessages(scope, conversationId);
		const toolText = JSON.stringify(
			messages.find((m) => m.role === "toolResult"),
		);
		expect(toolText).toContain('\\"challenges\\": 4');
		expect(toolText).toContain('\\"openWork\\": 3');

		const ledger = await ws.readChangeRecords(scope, {});
		expect(
			ledger.map((record) => `${record.resource}.${record.operation}`),
		).toEqual(["output.list", "output.get", "output.get", "work.listOpen"]);
		for (const record of ledger) {
			expect(record.decision.verdict).toBe("allow");
			expect(record.decision.riskTier).toBe("read");
			expect(record.outcome).toBe("applied");
			expect(record.source.surface).toBe("workspace_object");
		}
		expect((await ws.listConversations(scope))[0]?.id).toBe(conversationId);
		// Loop overhead without a real model: well inside the 30 s budget.
		expect(elapsed).toBeLessThan(10_000);
	});

	test("a write holds for approval; approving runs it with a receipt and the turn continues", async () => {
		const ws = workspace();
		const CREATE = `export default async (env) => env.outputs.create({ title: "New", content: { kind: "document", blocks: [] } })`;
		await ws.scriptModel(scope, [{ code: CREATE }, { text: "unreachable" }]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Create a new document",
		});
		const outcome = await ws.awaitTurn(scope, turnId, 20_000);
		expect(outcome.status).toBe("finished");
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		expect(requested?.type).toBe("approval.requested");
		if (requested?.type !== "approval.requested")
			throw new Error("no approval");
		expect(requested.title).toBe("Creating a new output");
		const held = (
			await ws.readChangeRecords(scope, { resource: "output" })
		).find((record) => record.operation === "create");
		expect(held?.outcome).toBe("needs_approval");
		expect(held?.id).toBe(requested.approvalId);

		// The approver's decision applies the held call and the model finishes the answer.
		await ws.scriptModel(scope, [{ text: "Done: the document was created." }]);
		const decided = await ws.decideApproval(scope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decided.applied).toBe(true);
		await ws.awaitTurn(scope, decided.turnId!, 20_000);
		const after = await ws.readEvents(scope, {
			conversationId,
			after: requested.seq,
		});
		expect(after.map((event) => event.type)).toContain("approval.decided");
		const applied = (
			await ws.readChangeRecords(scope, { resource: "output" })
		).filter((record) => record.operation === "create");
		expect(applied.map((record) => record.outcome)).toEqual([
			"needs_approval",
			"applied",
		]);
		expect((await ws.readTurn(scope, decided.turnId!))?.text).toBe(
			"Done: the document was created.",
		);
		const created = events.length;
		expect(created).toBeGreaterThan(0);
	});

	test("events replay from a cursor and a guest tedi's profile comes from its own object", async () => {
		const ws = workspace();
		const before = await ws.readEvents(scope, { after: 0, limit: 5000 });
		const last = before.at(-1)?.seq ?? 0;
		await ws.scriptModel(scope, [{ text: "Hello from the guest." }]);
		const { turnId, conversationId, seq } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Say hello",
			tediId: "tedi1",
		});
		expect(seq).toBeGreaterThan(last);
		await ws.awaitTurn(scope, turnId, 20_000);
		const replayed = await ws.readEvents(scope, {
			conversationId,
			after: last,
		});
		const startedEvent = replayed.find(
			(event) => event.type === "turn.started",
		);
		expect(
			startedEvent?.type === "turn.started" && startedEvent.authorKind,
		).toBe("tedi");
		const done = replayed.find((event) => event.type === "assistant.done");
		expect(done?.type === "assistant.done" && done.text).toBe(
			"Hello from the guest.",
		);
		const history = await ws.readLedger(scope, conversationId, { limit: 10 });
		expect(history.map((event) => event.type)).toContain("turn.started");
	});

	test("a long conversation runs its turn in a facet", async () => {
		const ws = workspace();
		let conversationId: string | null = null;
		for (let i = 0; i < 21; i += 1) {
			await ws.scriptModel(scope, [{ text: `reply ${i}` }]);
			const started = await ws.sendTurn(scope, {
				conversationId,
				actorId: "u1",
				actorKind: "user",
				text: `m ${i}`,
			});
			conversationId = started.conversationId;
			await ws.awaitTurn(scope, started.turnId, 20_000);
		}
		await ws.scriptModel(scope, [{ text: "isolated reply" }]);
		const { turnId } = await ws.sendTurn(scope, {
			conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "last",
		});
		const outcome = await ws.awaitTurn(scope, turnId, 20_000);
		expect(outcome.status).toBe("finished");
		expect(outcome.text).toBe("isolated reply");
	});
});
