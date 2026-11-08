import { env } from "cloudflare:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, test } from "vite-plus/test";
import {
	osGadgets,
	osOutputs,
	osOutputRevisions,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workspaceFeedLedger,
	workspaceFeedCursors,
	workspaceActivity,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
import { workItems } from "@tedix/db/schema/work-items";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createOsOutput as createCoreOutput } from "@tedix/db/queries/os-workspaces/outputs";
import { getWorkspaceOutputIndexCurrent } from "@tedix/db/queries/workspace-feed/read";
import { storeOutputBody } from "../src/data-port-tenant";
import type { WorkspaceEnv, WorkspaceScope } from "../src/env";
import type { WorkspaceRpc } from "../src/do";
import type { ScriptStep } from "./worker";
import wranglerConfig from "../wrangler.jsonc?raw";

const scope: WorkspaceScope = {
	organizationId: "org_test",
	workspaceId: "11111111-1111-4111-8111-111111111111",
};
const testEnv = env as unknown as WorkspaceEnv & {
	TEDI_AGENT: DurableObjectNamespace;
};

type Stub = WorkspaceRpc & {
	failNextProjection(scope: WorkspaceScope): Promise<void>;
	retryProjections(scope: WorkspaceScope): Promise<void>;
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
function workspace(workspaceScope = scope): Stub {
	return tenantStoreStub(
		testEnv.WORKSPACE,
		testEnv,
		workspaceScope,
	) as unknown as Stub;
}

function percentile(values: number[], quantile: number): number {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}

async function socketFramesUntil(
	socket: WebSocket,
	done: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
	const frames: Record<string, unknown>[] = [];
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("WebSocket replay timed out")),
			5_000,
		);
		socket.addEventListener("message", (event) => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			frames.push(frame);
			if (done(frame)) {
				clearTimeout(timer);
				resolve(frames);
			}
		});
		socket.accept();
	});
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
		osOutputs,
		osOutputRevisions,
		workspaceFeedLedger,
		workspaceFeedCursors,
		workspaceActivity,
		workspaceOutputIndex,
		workspaceWorkLinks,
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

async function seedWorkspaceRows(scopes: WorkspaceScope[]) {
	const now = "2026-11-07T10:00:00.000Z";
	await testEnv.DB.batch(
		scopes.map((workspaceScope, index) =>
			testEnv.DB.prepare(
				`INSERT OR REPLACE INTO os_workspaces (id, organization_id, name, description, status, created_by_kind, created_by_id, created_at, updated_at, visibility) VALUES (?, ?, ?, '', 'active', 'service', 'load-test', ?, ?, 'org')`,
			).bind(
				workspaceScope.workspaceId,
				workspaceScope.organizationId,
				`Load workspace ${index}`,
				now,
				now,
			),
		),
	);
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
				access_envelope: JSON.stringify({ version: 1, sources: [] }),
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
				access_envelope: JSON.stringify({ version: 1, sources: [] }),
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
	test("production keeps workspace objects and their bodies in the EU jurisdiction", () => {
		const production = wranglerConfig.slice(
			wranglerConfig.indexOf('"production"'),
		);
		expect(production).toContain('"DO_JURISDICTION": "eu"');
		expect(production).toMatch(
			/"bucket_name": "public-installation-bucket",\s*"jurisdiction": "eu"/,
		);
	});

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

	test("agent reads browser revisions from both stores and refuses unverified source content", async () => {
		await seedCore();
		const ws = workspace();
		const now = new Date().toISOString();
		const body = await storeOutputBody(
			testEnv.R2_BUCKET,
			scope.organizationId,
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "browser-marker" }],
			}),
		);
		const output = {
			id: "legacy-browser",
			...scope,
			kind: "document" as const,
			title: "Browser document",
			currentRevisionId: "legacy-browser-r1",
			createdByKind: "user" as const,
			createdById: "u1",
			createdAt: now,
			updatedAt: now,
		};
		const revision = {
			id: "legacy-browser-r1",
			organizationId: scope.organizationId,
			outputId: output.id,
			revision: 1,
			content: "",
			...body,
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			createdByKind: "user" as const,
			createdById: "u1",
			createdAt: now,
		};
		await createCoreOutput(
			createDbQueryClient(testEnv.DB),
			scope,
			output,
			revision,
		);
		await ws.failNextProjection(scope);
		await ws.outputQuery(scope, {
			op: "create",
			output: {
				...output,
				id: "object-browser",
				currentRevisionId: "object-browser-r1",
			},
			revision: {
				...revision,
				id: "object-browser-r1",
				outputId: "object-browser",
			},
		});
		const db = createDbQueryClient(testEnv.DB);
		expect(
			await getWorkspaceOutputIndexCurrent(db, {
				organizationId: scope.organizationId,
				outputId: "object-browser",
			}),
		).toBeUndefined();
		await ws.retryProjections(scope);
		expect(
			(
				await getWorkspaceOutputIndexCurrent(db, {
					organizationId: scope.organizationId,
					outputId: "object-browser",
				})
			)?.revisionId,
		).toBe("object-browser-r1");
		await ws.outputQuery(scope, {
			op: "create",
			output: {
				...output,
				id: "unverified",
				currentRevisionId: "unverified-r1",
			},
			revision: {
				...revision,
				id: "unverified-r1",
				outputId: "unverified",
				accessEnvelope: null,
			},
		});
		const editedBody = await storeOutputBody(
			testEnv.R2_BUCKET,
			scope.organizationId,
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "browser-edit-marker" }],
			}),
		);
		const revised = await ws.outputQuery(scope, {
			op: "revise",
			params: {
				...revision,
				...editedBody,
				id: "object-browser-r2",
				outputId: "object-browser",
				expectedRevision: 1,
			},
		});
		expect(revised.ok).toBe(true);
		const stale = await ws.outputQuery(scope, {
			op: "revise",
			params: {
				...revision,
				id: "stale-r2",
				outputId: "object-browser",
				expectedRevision: 1,
			},
		});
		expect(stale).toEqual({ ok: false, reason: "revision_conflict" });
		await ws.scriptModel(scope, [
			{
				code: `export default async (env) => ({
			legacy: await env.outputs.get("legacy-browser"),
			object: await env.outputs.get("object-browser"),
			unverified: await env.outputs.get("unverified")
		})`,
			},
			{ text: "Read checked." },
		]);
		const turn = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Read browser outputs",
		});
		await ws.awaitTurn(scope, turn.turnId, 20_000);
		const messages = await ws.readMessages(scope, turn.conversationId);
		const tool = messages.find((message) => message.role === "toolResult");
		const rendered = JSON.stringify(tool);
		expect(rendered).toContain("browser-marker");
		expect(rendered).toContain('\\"revision\\": 2');
		expect(rendered).toContain('\\"unverified\\": null');
	});

	test("two isolated turns in one workspace remain in flight together", async () => {
		const ws = workspace();
		await ws.scriptModel(scope, [
			{
				text: "one two three four five six seven eight",
				tokensPerSecond: 5,
			},
		]);
		const [first, second] = await Promise.all([
			ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "first isolated turn",
				isolate: true,
			}),
			ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "second isolated turn",
				isolate: true,
			}),
		]);

		await new Promise((resolve) => setTimeout(resolve, 100));
		const inFlight = await Promise.all([
			ws.readTurn(scope, first.turnId),
			ws.readTurn(scope, second.turnId),
		]);
		expect(inFlight.map((turn) => turn?.status)).toEqual([
			"running",
			"running",
		]);

		const outcomes = await Promise.all([
			ws.awaitTurn(scope, first.turnId, 20_000),
			ws.awaitTurn(scope, second.turnId, 20_000),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			"finished",
			"finished",
		]);
	});

	test("runs five concurrent turns in each of 50 local workerd workspaces", async () => {
		await seedCore();
		const loadScopes = Array.from(
			{ length: 50 },
			(_, index): WorkspaceScope => ({
				organizationId: scope.organizationId,
				workspaceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
			}),
		);
		await seedWorkspaceRows(loadScopes);
		const workspaces = await Promise.all(
			loadScopes.map(async (workspaceScope, index) => {
				const ws = workspace(workspaceScope);
				await ws.scriptModel(workspaceScope, [{ text: `workspace ${index}` }]);
				return { scope: workspaceScope, ws };
			}),
		);
		const latencies: number[] = [];

		await Promise.all(
			workspaces.flatMap(({ scope: workspaceScope, ws }) =>
				Array.from({ length: 5 }, async (_, turn) => {
					const startedAt = performance.now();
					const started = await ws.sendTurn(workspaceScope, {
						actorId: "load-test",
						actorKind: "service",
						text: `turn ${turn}`,
					});
					const outcome = await ws.awaitTurn(
						workspaceScope,
						started.turnId,
						20_000,
					);
					latencies.push(performance.now() - startedAt);
					expect(outcome.status).toBe("finished");
				}),
			),
		);

		const p50 = percentile(latencies, 0.5);
		const p95 = percentile(latencies, 0.95);
		console.info(
			`workspace-do load: turns=${latencies.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
		);
		expect(latencies).toHaveLength(250);
		expect(p95).toBeLessThan(20_000);
	});

	test("typed Doc edits use the canonical document and cannot run before approval", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		await ws.scriptModel(scope, [
			{
				code: `export default async env => { const doc = await env.documents.read({outputId:"out-doc"}); return env.documents.edit({outputId:doc.id,expectedRevision:doc.revision,ops:[{op:"replace",index:0,block:{type:"heading",level:1,text:"Approved Doc edit"}}]}); }`,
			},
		]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Edit the document",
		});
		await ws.awaitTurn(scope, started.turnId, 20000);
		const events = await ws.readEvents(scope, {
			conversationId: started.conversationId,
			after: 0,
		});
		const approval = events.find(
			(event) => event.type === "approval.requested",
		);
		if (approval?.type !== "approval.requested")
			throw new Error("Doc edit did not request approval");
		const before = await ws.outputQuery(scope, {
			op: "get",
			outputId: "out-doc",
		});
		expect(before?.currentRevisionId).toBe("rev-doc");
		await ws.scriptModel(scope, [
			{
				code: `export default async env => env.documents.read({outputId:"out-doc"})`,
			},
			{ text: "Saved" },
		]);
		const applied = await ws.decideApproval(scope, {
			approvalId: approval.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(applied.applied).toBe(true);
		await ws.awaitTurn(scope, applied.turnId!, 20000);
		const messages = await ws.readMessages(scope, started.conversationId);
		expect(
			JSON.stringify(
				messages.filter((message) => message.role === "toolResult"),
			),
		).toContain("Approved Doc edit");
		const records = await ws.readChangeRecords(scope, { resource: "output" });
		const edits = records.filter((record) => record.operation === "edit");
		expect(edits.map((record) => record.outcome)).toEqual([
			"needs_approval",
			"applied",
		]);
		expect(edits[1]?.before?.revisionId).toBe("rev-doc");
		expect(edits[1]?.after?.revisionId).toBeTruthy();
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
		expect(
			after.find((event) => event.type === "approval.executed"),
		).toMatchObject({
			approvalId: requested.approvalId,
			status: "applied",
		});
		const continuation = after.find(
			(event) =>
				event.type === "turn.started" && event.turnId === decided.turnId,
		);
		expect(
			continuation?.type === "turn.started" && continuation.displayText,
		).toBe("Approved the requested action.");
		expect(
			continuation?.type === "turn.started" && continuation.text,
		).toContain("outputs.create applied:");
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
		expect(
			await ws.decideApproval(scope, {
				approvalId: requested.approvalId,
				decision: "approve",
				by: "u1",
			}),
		).toEqual(decided);
		expect(
			await ws.readEvents(scope, { conversationId, after: requested.seq }),
		).toEqual(after);
	});

	test("an approved revision conflict remains failed on repeated decisions", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		const before = await ws.outputQuery(scope, {
			op: "get",
			outputId: "out-doc",
		});
		await ws.scriptModel(scope, [
			{
				code: `export default async (env) => env.outputs.revise({
			outputId: "out-doc", expectedRevision: 0,
			content: { kind: "document", blocks: [{ type: "paragraph", text: "stale edit" }] }
		})`,
			},
		]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Try the stale edit",
		});
		await ws.awaitTurn(scope, started.turnId, 20_000);
		const requested = (
			await ws.readEvents(scope, { conversationId: started.conversationId })
		).find((event) => event.type === "approval.requested");
		if (requested?.type !== "approval.requested")
			throw new Error("No held write");
		await ws.scriptModel(scope, [
			{ text: "The approved write failed because its revision was stale." },
		]);
		const result = await ws.decideApproval(scope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(result.applied).toBe(false);
		await ws.awaitTurn(scope, result.turnId!, 20_000);
		const events = await ws.readEvents(scope, {
			conversationId: started.conversationId,
		});
		expect(
			events.find((event) => event.type === "approval.executed"),
		).toMatchObject({
			approvalId: requested.approvalId,
			status: "failed",
			error: expect.stringContaining("revision_conflict"),
		});
		expect(
			await ws.decideApproval(scope, {
				approvalId: requested.approvalId,
				decision: "approve",
				by: "u1",
			}),
		).toEqual(result);
		expect(
			await ws.readEvents(scope, { conversationId: started.conversationId }),
		).toEqual(events);
		expect(
			(await ws.outputQuery(scope, { op: "get", outputId: "out-doc" }))
				?.currentRevisionId,
		).toBe(before?.currentRevisionId);
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

	test("a retried socket send keeps one turn and conversation", async () => {
		const ws = workspace();
		await ws.scriptModel(scope, [{ text: "One answer." }]);
		const request = new Request("https://workspace.test/subscribe", {
			headers: {
				Upgrade: "websocket",
				"X-Workspace-Org": scope.organizationId,
				"X-Workspace-Id": scope.workspaceId,
				"X-Workspace-Actor-Id": "u1",
			},
		});
		const clientTurnId = crypto.randomUUID();
		const frame = JSON.stringify({
			type: "send_turn",
			clientTurnId,
			conversationId: null,
			text: "Send once despite retry",
		});
		const accepted = async () => {
			const socket = (await ws.fetch(request.clone())).webSocket;
			if (!socket) throw new Error("No socket");
			const frames = socketFramesUntil(
				socket,
				(value) => value.type === "turn.accepted",
			);
			socket.send(frame);
			const result = (await frames).at(-1)!;
			socket.close(1000, "test complete");
			return result;
		};
		const first = await accepted();
		await ws.awaitTurn(scope, clientTurnId, 20_000);
		const second = await accepted();
		expect(first.turnId).toBe(clientTurnId);
		expect(second).toEqual(first);
		const events = await ws.readEvents(scope, {
			conversationId: String(first.conversationId),
		});
		expect(
			events.filter((event) => event.type === "turn.started"),
		).toHaveLength(1);
	});

	test("a WebSocket reconnect replays events after its cursor", async () => {
		const ws = workspace();
		await ws.scriptModel(scope, [{ text: "replayed answer" }]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "replay this turn",
		});
		await ws.awaitTurn(scope, started.turnId, 20_000);

		const response = await ws.fetch(
			new Request(
				`https://workspace.test/subscribe?conversation=${started.conversationId}&after=${started.seq}`,
				{
					headers: {
						Upgrade: "websocket",
						"X-Workspace-Org": scope.organizationId,
						"X-Workspace-Id": scope.workspaceId,
						"X-Workspace-Actor-Id": "u1",
					},
				},
			),
		);
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		if (!socket) throw new Error("upgrade did not return a WebSocket");
		const frames = await socketFramesUntil(
			socket,
			(frame) => frame.type === "caught_up",
		);
		socket.close(1000, "test complete");

		expect(frames[0]?.type).toBe("hello");
		expect(frames.at(-1)?.type).toBe("caught_up");
		expect(frames.map((frame) => frame.type)).toContain("assistant.done");
		expect(
			frames
				.filter((frame) => typeof frame.seq === "number")
				.every((frame) => Number(frame.seq) > started.seq),
		).toBe(true);
	});

	test("the MCP entry lists tools and completes a workspace turn", async () => {
		const ws = workspace();
		const headers = {
			"Content-Type": "application/json",
			"X-Workspace-Org": scope.organizationId,
			"X-Workspace-Id": scope.workspaceId,
			"X-Workspace-Actor-Id": "outside-agent",
			"X-Workspace-Actor-Kind": "external_agent",
		};
		const listed = await ws.fetch(
			new Request("https://workspace.test/mcp", {
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		const listBody = (await listed.json()) as {
			result: { tools: Array<{ name: string }> };
		};
		expect(listBody.result.tools.map((tool) => tool.name)).toContain(
			"send_turn",
		);

		await ws.scriptModel(scope, [{ text: "answer through MCP" }]);
		const called = await ws.fetch(
			new Request("https://workspace.test/mcp", {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "send_turn",
						arguments: { text: "answer from outside", waitSeconds: 10 },
					},
				}),
			}),
		);
		const callBody = (await called.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const outcome = JSON.parse(callBody.result.content[0]?.text ?? "{}") as {
			status?: string;
			text?: string;
		};
		expect(outcome).toMatchObject({
			status: "finished",
			text: "answer through MCP",
		});
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
