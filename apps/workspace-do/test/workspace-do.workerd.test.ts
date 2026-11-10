import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
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
import { projects } from "@tedix/db/schema/projects";
import { workEvents, workItems } from "@tedix/db/schema/work-items";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createOsOutput as createCoreOutput } from "@tedix/db/queries/os-workspaces/outputs";
import {
	getWorkspaceOutputIndexCurrent,
	listWorkspaceActivity,
} from "@tedix/db/queries/workspace-feed/read";
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
	failTransferReply(scope: WorkspaceScope): Promise<void>;
	pruneChatLedger(scope: WorkspaceScope): Promise<void>;
	failNextProjection(scope: WorkspaceScope): Promise<void>;
	failEventProjection(
		scope: WorkspaceScope,
		when: "before" | "after",
	): Promise<void>;
	failActionProjection(
		scope: WorkspaceScope,
		when: "before" | "after",
	): Promise<void>;
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

async function rejectedSocketTurn(
	ws: Stub,
	attachments: unknown,
	turnId: string,
) {
	const socket = (
		await ws.fetch(
			new Request("https://workspace.test/subscribe", {
				headers: {
					Upgrade: "websocket",
					"X-Workspace-Org": scope.organizationId,
					"X-Workspace-Id": scope.workspaceId,
					"X-Workspace-Actor-Id": "u1",
				},
			}),
		)
	).webSocket;
	if (!socket) throw new Error("No socket");
	try {
		const rejected = socketFramesUntil(
			socket,
			(frame) => frame.type === "error",
		);
		socket.send(
			JSON.stringify({
				type: "send_turn",
				clientTurnId: turnId,
				conversationId: null,
				text: "Read this",
				attachments,
			}),
		);
		return (await rejected).at(-1)!;
	} finally {
		socket.close(1000, "test complete");
	}
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
	const tables = [
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
		projects,
		workItems,
		workEvents,
	];
	await testEnv.DB.batch([
		...tables.map((table) => testEnv.DB.prepare(ddl(table))),
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
			`INSERT OR REPLACE INTO projects (id, org_id, key, name, objective_id, created_at, updated_at) VALUES ('proj1', ?, 'PRG', 'Programme', 'obj1', ?, ?)`,
		).bind(scope.organizationId, now, now),
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

async function seedOutputs(ws: Stub, outputScope = scope) {
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
		outputScope.organizationId,
		JSON.stringify(sheet),
	);
	const docBody = await storeOutputBody(
		testEnv.R2_BUCKET,
		outputScope.organizationId,
		JSON.stringify(doc),
	);
	await ws.importRows(outputScope, {
		batchId: "b-outputs",
		table: "os_outputs",
		rows: [
			{
				id: "out-sheet",
				organization_id: outputScope.organizationId,
				workspace_id: outputScope.workspaceId,
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
				organization_id: outputScope.organizationId,
				workspace_id: outputScope.workspaceId,
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
	await ws.importRows(outputScope, {
		batchId: "b-revisions",
		table: "os_output_revisions",
		rows: [
			{
				id: "rev-sheet",
				organization_id: outputScope.organizationId,
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
				organization_id: outputScope.organizationId,
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
		const modelCalls = messages.filter(
			(message) => message.role === "assistant",
		);
		expect(modelCalls).toHaveLength(2);
		const done = events.find((event) => event.type === "assistant.done");
		expect(done?.type === "assistant.done" && done.usage).toMatchObject({
			inputTokens: modelCalls.reduce(
				(sum, message) =>
					sum +
					message.usage.input +
					message.usage.cacheRead +
					message.usage.cacheWrite,
				0,
			),
			outputTokens: modelCalls.reduce(
				(sum, message) => sum + message.usage.output,
				0,
			),
		});
		const toolText = JSON.stringify(
			messages.find((m) => m.role === "toolResult"),
		);
		expect(toolText).toContain('\\"challenges\\": 4');
		expect(toolText).toContain('\\"openWork\\": 3');

		const ledger = await ws.readChangeRecords(scope, {});
		expect(await ws.reconcileActivity(scope)).toMatchObject({
			checked: 4,
			missing: [],
			coverage: "recorded_binding_actions",
		});
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

	test("agent reads browser revisions from the workspace owner and refuses unverified source content", async () => {
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
		await ws.importRows(scope, {
			batchId: "browser-workspace-owner",
			table: "os_workspaces",
			rows: [
				{
					id: scope.workspaceId,
					organization_id: scope.organizationId,
					name: "Programme workspace",
					status: "active",
					visibility: "org",
					created_by_kind: "user",
					created_by_id: "u1",
					created_at: now,
					updated_at: now,
				},
			],
		});
		await ws.outputQuery(scope, { op: "create", output, revision });
		expect(await ws.outputQuery(scope, { op: "authority" })).toBe("object");
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
		const activity = await listWorkspaceActivity(
			db,
			{ organizationId: scope.organizationId, viewer: { userIds: ["u1"] } },
			{ workspaceId: scope.workspaceId, kinds: ["output"] },
		);
		expect(
			activity
				.filter((row) => row.entityId === "object-browser")
				.map((row) => row.changeRecordId),
		).toEqual(["object-browser-r2", "object-browser-r1"]);
		expect(
			await listWorkspaceActivity(
				db,
				{ organizationId: "other-org", viewer: { userIds: ["u1"] } },
				{ workspaceId: scope.workspaceId, kinds: ["output"] },
			),
		).toEqual([]);
		await testEnv.DB.prepare(
			"UPDATE os_workspaces SET visibility = 'private', owner_user_id = 'u1' WHERE id = ? AND organization_id = ?",
		)
			.bind(scope.workspaceId, scope.organizationId)
			.run();
		try {
			expect(
				await listWorkspaceActivity(
					db,
					{
						organizationId: scope.organizationId,
						viewer: { userIds: ["other"] },
					},
					{ workspaceId: scope.workspaceId, kinds: ["output"] },
				),
			).toEqual([]);
			expect(
				(
					await listWorkspaceActivity(
						db,
						{
							organizationId: scope.organizationId,
							viewer: { userIds: ["u1"] },
						},
						{ workspaceId: scope.workspaceId, kinds: ["output"] },
					)
				).some((row) => row.entityId === "object-browser"),
			).toBe(true);
		} finally {
			await testEnv.DB.prepare(
				"UPDATE os_workspaces SET visibility = 'org', owner_user_id = NULL WHERE id = ? AND organization_id = ?",
			)
				.bind(scope.workspaceId, scope.organizationId)
				.run();
		}
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

	test.each(["sheets", "presentations"] as const)(
		"%s edits round-trip through the sandbox and approval receipt",
		async (binding) => {
			await seedCore();
			const workspaceScope = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([workspaceScope]);
			const ws = workspace(workspaceScope);
			const now = "2026-11-08T12:00:00.000Z";
			const outputId = `typed-${binding}`,
				revisionId = `${outputId}-r1`;
			const content =
				binding === "sheets"
					? { kind: "sheet" as const, columns: ["A"], rows: [[1]] }
					: {
							kind: "presentation" as const,
							slides: [{ title: "Before", bullets: [] }],
						};
			const body = await storeOutputBody(
				testEnv.R2_BUCKET,
				workspaceScope.organizationId,
				JSON.stringify(content),
			);
			await ws.outputQuery(workspaceScope, {
				op: "create",
				output: {
					id: outputId,
					...workspaceScope,
					kind: content.kind,
					title: binding,
					currentRevisionId: revisionId,
					createdByKind: "user",
					createdById: "u1",
					createdAt: now,
					updatedAt: now,
				},
				revision: {
					id: revisionId,
					organizationId: workspaceScope.organizationId,
					outputId,
					revision: 1,
					content: "",
					...body,
					accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
					createdByKind: "user",
					createdById: "u1",
					createdAt: now,
				},
			});
			const edit =
				binding === "sheets"
					? { startRow: 0, startColumn: 0, cells: [["Approved gadget edit"]] }
					: {
							ops: [
								{
									op: "replace",
									index: 0,
									slide: { title: "Approved gadget edit", bullets: [] },
								},
							],
						};
			await ws.scriptModel(workspaceScope, [
				{
					code: `export default async env=>{const output=await env.${binding}.read({outputId:${JSON.stringify(outputId)}});return env.${binding}.edit({outputId:output.id,expectedRevision:output.revision,...${JSON.stringify(edit)}});}`,
				},
			]);
			const started = await ws.sendTurn(workspaceScope, {
				actorId: "u1",
				actorKind: "user",
				text: "Edit the gadget output",
			});
			await ws.awaitTurn(workspaceScope, started.turnId, 20000);
			const events = await ws.readEvents(workspaceScope, {
				conversationId: started.conversationId,
				after: 0,
			});
			const approval = events.find(
				(event) => event.type === "approval.requested",
			);
			if (approval?.type !== "approval.requested")
				throw new Error("Missing typed-output approval");
			expect(approval.title).toBe(
				binding === "sheets" ? "Editing sheet cells" : "Editing slides",
			);
			expect(
				events.some(
					(event) =>
						event.type === "step.started" &&
						event.tool === `${binding}.edit` &&
						event.kind === "write",
				),
			).toBe(true);
			expect(
				(await ws.outputQuery(workspaceScope, { op: "get", outputId }))
					?.currentRevisionId,
			).toBe(revisionId);
			await ws.scriptModel(workspaceScope, [
				{
					code: `export default async env=>env.${binding}.read({outputId:${JSON.stringify(outputId)}})`,
				},
				{ text: "Saved" },
			]);
			const decided = await ws.decideApproval(workspaceScope, {
				approvalId: approval.approvalId,
				decision: "approve",
				by: "u1",
			});
			expect(decided.applied).toBe(true);
			await ws.awaitTurn(workspaceScope, decided.turnId!, 20000);
			const messages = await ws.readMessages(
				workspaceScope,
				started.conversationId,
			);
			expect(
				JSON.stringify(
					messages.filter((message) => message.role === "toolResult"),
				),
			).toContain("Approved gadget edit");
			const records = (
				await ws.readChangeRecords(workspaceScope, { resource: "output" })
			).filter((record) => record.operation === "edit");
			expect(records.map((record) => record.outcome)).toEqual([
				"needs_approval",
				"applied",
			]);
			expect(records[1]?.before?.revisionId).toBe(revisionId);
			expect(records[1]?.after?.revisionId).toBeTruthy();
			await ws.retryProjections(workspaceScope);
			const lifecycle = await testEnv.DB.prepare(
				"SELECT actor_kind, actor_id, summary FROM workspace_feed_ledger WHERE workspace_id = ? AND change_record_id LIKE 'workspace-event:%' ORDER BY seq",
			)
				.bind(workspaceScope.workspaceId)
				.all<{ actor_kind: string; actor_id: string; summary: string }>();
			const actions = lifecycle.results.map((row) => ({
				...row,
				action: JSON.parse(row.summary).action,
			}));
			for (const operation of [
				"step.started",
				"step.finished",
				"approval.requested",
				"approval.executed",
			]) {
				expect(actions.some((row) => row.action.operation === operation)).toBe(
					true,
				);
			}
			expect(
				actions.find((row) => row.action.operation === "approval.decided"),
			).toMatchObject({ actor_kind: "user", actor_id: "u1" });
			expect(JSON.stringify(lifecycle.results)).not.toContain(
				"Approved gadget edit",
			);
		},
	);

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

	test("asking to file a Work Item shows a card and files it only after approval", async () => {
		const ws = workspace();
		const FILE = `export default async (env) => env.work.create({ title: "Make the Work tab live", description: "Show live Work in the monitor app." })`;
		await ws.scriptModel(scope, [{ code: FILE }, { text: "unreachable" }]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "File a Work Item to make the Work tab live",
		});
		await ws.awaitTurn(scope, turnId, 20_000);
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("no approval card");
		expect(requested.title).toBe("Filing a Work Item");
		expect(requested.input).toMatchObject({ title: "Make the Work tab live" });
		const filed = () =>
			testEnv.DB.prepare(
				"SELECT id, project_id, objective_id, disposition, steward_type, steward_id FROM work_items WHERE title = ?",
			)
				.bind("Make the Work tab live")
				.all();
		expect((await filed()).results).toHaveLength(0);

		await ws.scriptModel(scope, [{ text: "Filed." }]);
		const decided = await ws.decideApproval(scope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decided.applied).toBe(true);
		await ws.awaitTurn(scope, decided.turnId!, 20_000);
		const rows = (await filed()).results as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			project_id: "proj1",
			objective_id: "obj1",
			disposition: "proposed",
			steward_type: "user",
			steward_id: "u1",
		});
		const created = await testEnv.DB.prepare(
			"SELECT actor_type, actor_id FROM work_events WHERE work_item_id = ? AND event_type = 'work.created'",
		)
			.bind(rows[0]?.id)
			.first();
		expect(created).toMatchObject({ actor_type: "user", actor_id: "u1" });
		await testEnv.DB.prepare("DELETE FROM work_items WHERE id = ?")
			.bind(rows[0]?.id)
			.run();
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
		await seedCore();
		const scope = {
			organizationId: "org_attachment_retry",
			workspaceId: crypto.randomUUID(),
		};
		await seedWorkspaceRows([scope]);
		const ws = workspace(scope);
		await seedOutputs(ws, scope);
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
			attachments: [{ outputId: "out-doc" }],
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
		expect(events.find((event) => event.type === "turn.started")).toMatchObject(
			{
				text: "Send once despite retry",
				attachments: [
					{
						outputId: "out-doc",
						title: "Priorities",
						revision: 1,
						revisionId: "rev-doc",
					},
				],
			},
		);
		const messages = await ws.readMessages(scope, String(first.conversationId));
		expect(
			JSON.stringify(messages.filter((message) => message.role === "user")),
		).toContain("Battery recycling");
		expect(JSON.stringify(messages)).toContain("rev-doc");
	});

	test("rejects unavailable and malformed attachments before recording a turn", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		for (const attachments of [
			[{ outputId: "not-in-this-workspace" }],
			Array.from({ length: 6 }, () => ({ outputId: "out-doc" })),
			[{ outputId: 42 }],
		]) {
			const turnId = crypto.randomUUID();
			expect(await rejectedSocketTurn(ws, attachments, turnId)).toMatchObject({
				type: "error",
				clientTurnId: turnId,
				message: expect.any(String),
			});
			expect(await ws.readTurn(scope, turnId)).toBeNull();
		}
	});

	test("includes selected file contents when a turn runs in a facet", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		await ws.scriptModel(scope, [{ text: "Read the selected sheet." }]);
		const turn = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Read the sheet",
			attachments: [{ outputId: "out-sheet" }],
			isolate: true,
		});
		expect((await ws.awaitTurn(scope, turn.turnId, 20_000)).status).toBe(
			"finished",
		);
		expect(
			JSON.stringify(await ws.readMessages(scope, turn.conversationId)),
		).toContain("Supply chain");
	});

	test.each(["uploaded", "large", "restricted", "foreign"])(
		"refuses %s attachment contents without starting a turn",
		async (kind) => {
			await seedCore();
			const ws = workspace();
			const outputId = crypto.randomUUID();
			const revisionId = crypto.randomUUID();
			const content = {
				kind: "document",
				blocks:
					kind === "large"
						? Array.from({ length: 4 }, () => ({
								type: "paragraph",
								text: "x".repeat(17_000),
							}))
						: [],
				...(kind === "uploaded"
					? {
							file: {
								workspaceId: scope.workspaceId,
								resourceId: crypto.randomUUID(),
							},
						}
					: {}),
			};
			const body = await storeOutputBody(
				testEnv.R2_BUCKET,
				scope.organizationId,
				JSON.stringify(content),
			);
			await createCoreOutput(
				createDbQueryClient(testEnv.DB),
				{ organizationId: scope.organizationId },
				{
					id: outputId,
					organizationId: scope.organizationId,
					workspaceId:
						kind === "foreign" ? crypto.randomUUID() : scope.workspaceId,
					title: "Unavailable attachment",
					kind: "document",
					currentRevisionId: revisionId,
					createdByKind: "user",
					createdById: "u1",
				},
				{
					id: revisionId,
					organizationId: scope.organizationId,
					outputId,
					revision: 1,
					content: "",
					...body,
					createdByKind: "user",
					createdById: "u1",
					accessEnvelope:
						kind === "restricted"
							? null
							: JSON.stringify({ version: 1, sources: [] }),
				},
			);
			const turnId = crypto.randomUUID();
			expect(
				(await rejectedSocketTurn(ws, [{ outputId }], turnId)).message,
			).toContain(
				kind === "large"
					? "64 KB"
					: kind === "uploaded"
						? "cannot be read"
						: "unavailable",
			);
			expect(await ws.readTurn(scope, turnId)).toBeNull();
		},
	);

	test("already copied history converts on wake and survives removal of the copied rows", async () => {
		const movedScope = {
			...scope,
			workspaceId: "11111111-1111-4111-8111-111111111118",
		};
		const ws = workspace(movedScope);
		const stub = ws as unknown as DurableObjectStub;
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO kernel_conversations (id, organization_id, workspace_id, conversation_id, title, last_message_at, archived_at) VALUES (?, ?, ?, 'copied', 'Copied chat', '2026-11-03T10:00:00.000Z', '2026-11-04T10:00:00.000Z')",
				"copied-index",
				movedScope.organizationId,
				movedScope.workspaceId,
			);
			state.storage.sql.exec(
				"INSERT INTO conversations (id, title, created_at, updated_at, archived_at) VALUES ('copied', 'Copied chat', '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z', '2026-11-04T10:00:00.000Z'), ('native-archive', 'Native archive', '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:00.000Z', '2026-11-04T10:00:00.000Z')",
			);
			state.storage.sql.exec(
				"INSERT INTO kernel_runtime_events (id, organization_id, conversation_id, run_id, kind, payload, created_at) VALUES ('copied-input', ?, 'copied', 'copied-run', 'message.received', ?, '2026-11-03T10:00:00.000Z')",
				movedScope.organizationId,
				JSON.stringify({ role: "user", content: "Copied question" }),
			);
			state.storage.sql.exec(
				"INSERT INTO kernel_runtime_events (id, organization_id, conversation_id, run_id, kind, payload, created_at) VALUES ('copied-failure', ?, 'copied', 'copied-run', 'run.failed', ?, '2026-11-03T10:00:02.000Z')",
				movedScope.organizationId,
				JSON.stringify({ error: "Earlier failure" }),
			);
		});
		await evictDurableObject(stub);
		expect(await ws.listConversations(movedScope)).toEqual([
			expect.objectContaining({ id: "copied", title: "Copied chat" }),
		]);
		const events = await ws.readEvents(movedScope);
		expect(events.map((e) => e.type)).toEqual([
			"turn.started",
			"turn.finished",
		]);
		expect(await ws.readTurn(movedScope, "copied-run")).toMatchObject({
			status: "failed",
			error: "Earlier failure",
		});
		await evictDurableObject(stub);
		expect(await ws.readEvents(movedScope)).toEqual(events);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE conversations SET archived_at = '2026-11-04T10:00:00.000Z' WHERE id = 'copied'",
			);
		});
		await evictDurableObject(stub);
		expect(await ws.listConversations(movedScope)).toEqual([]);
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE conversations SET archived_at = NULL WHERE id = 'copied'",
			);
			state.storage.sql.exec("DELETE FROM kernel_runtime_events");
			state.storage.sql.exec("DELETE FROM kernel_conversations");
		});
		await evictDurableObject(stub);
		expect(await ws.readEvents(movedScope)).toEqual(events);
		expect(await ws.listConversations(movedScope)).toHaveLength(1);
	});

	test("moved kernel history shares the native socket list and replay ledger", async () => {
		const scope: WorkspaceScope = {
			organizationId: "org_test",
			workspaceId: "11111111-1111-4111-8111-111111111117",
		};
		const ws = workspace(scope);
		await ws.scriptModel(scope, [{ text: "native answer" }]);
		const native = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Native chat",
		});
		await ws.awaitTurn(scope, native.turnId, 20_000);
		for (let i = 0; i < 2; i++) {
			await ws.scriptModel(scope, [{ text: "another native answer" }]);
			const turn = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "Another native chat",
			});
			await ws.awaitTurn(scope, turn.turnId, 20_000);
		}
		const at = "2026-11-03T10:00:00.000Z";
		await ws.importRows(scope, {
			batchId: "moved-conversations",
			table: "kernel_conversations",
			rows: [
				...Array.from({ length: 11 }, (_, i) => ({
					id: `kc-${i}`,
					organization_id: scope.organizationId,
					workspace_id: scope.workspaceId,
					conversation_id: `moved-${i}`,
					title: `Moved ${i}`,
					archived_at: i < 9 ? at : null,
					created_at: at,
					updated_at: at,
					last_message_at: at,
				})),
				{
					id: "kc-deleted",
					organization_id: scope.organizationId,
					workspace_id: scope.workspaceId,
					conversation_id: "deleted",
					last_message_at: at,
					deleted_at: at,
				},
			],
		});
		await ws.importRows(scope, {
			batchId: "moved-runs",
			table: "kernel_runtime_runs",
			rows: [
				{
					id: "moved-run",
					organization_id: scope.organizationId,
					conversation_id: "moved-0",
					status: "completed",
					input_message_id: "moved-question",
					started_at: at,
					completed_at: "2026-11-03T10:00:02.000Z",
				},
			],
		});
		const batch = {
			batchId: "moved-events",
			table: "kernel_runtime_events",
			rows: [
				{
					id: "moved-received",
					organization_id: scope.organizationId,
					conversation_id: "moved-0",
					run_id: null,
					message_id: "moved-question",
					kind: "message.received",
					payload: JSON.stringify({
						role: "user",
						content: "Earlier question",
					}),
					created_at: at,
				},
				{
					id: "moved-answer",
					organization_id: scope.organizationId,
					conversation_id: "moved-0",
					run_id: "moved-run",
					message_id: "moved-response",
					kind: "message.completed",
					payload: JSON.stringify({
						role: "assistant",
						content: "Earlier answer",
					}),
					created_at: "2026-11-03T10:00:01.000Z",
				},
				{
					id: "moved-finished",
					organization_id: scope.organizationId,
					conversation_id: "moved-0",
					run_id: "moved-run",
					message_id: null,
					kind: "run.completed",
					payload: JSON.stringify({ status: "completed" }),
					created_at: "2026-11-03T10:00:02.000Z",
				},
			],
		};
		await ws.importRows(scope, batch);
		const before = await ws.readEvents(scope, { conversationId: "moved-0" });
		await ws.importRows(scope, batch);
		expect(await ws.readEvents(scope, { conversationId: "moved-0" })).toEqual(
			before,
		);
		expect(await ws.readTurn(scope, "moved-run")).toMatchObject({
			status: "finished",
			text: "Earlier answer",
			firstSeq: before[0]!.seq,
		});
		const response = await ws.fetch(
			new Request(
				"https://workspace.test/subscribe?conversation=moved-0&after=0",
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
		const socket = response.webSocket!;
		let frames: Record<string, unknown>[];
		try {
			frames = await socketFramesUntil(
				socket,
				(frame) => frame.type === "caught_up",
			);
		} finally {
			socket.close(1000, "test complete");
		}
		const conversations = frames[0]!.conversations as Array<{ id: string }>;
		expect(conversations).toHaveLength(14);
		expect(conversations.map((c) => c.id)).toContain(native.conversationId);
		for (let i = 0; i < 11; i++)
			expect(conversations.map((c) => c.id)).toContain(`moved-${i}`);
		expect(frames.filter((f) => typeof f.seq === "number")).toEqual(before);
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "turn.started",
					turnId: "moved-run",
					text: "Earlier question",
				}),
				expect.objectContaining({
					type: "assistant.done",
					turnId: "moved-run",
					text: "Earlier answer",
				}),
				expect.objectContaining({
					type: "turn.finished",
					turnId: "moved-run",
					status: "done",
				}),
			]),
		);
		expect(frames.at(-1)!.cursor).toBe(before.at(-1)!.seq);
		expect(
			await ws.readLedger(scope, "moved-0", {
				before: before.at(-1)!.seq,
				limit: 1,
			}),
		).toEqual([before[1]]);
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

describe("workspace model request to turn", () => {
	test.each([false, true])(
		"a selected configured model reaches execution and durable replay (isolate=%s)",
		async (isolate) => {
			await seedCore();
			const ws = workspace();
			await ws.scriptModel(scope, [
				{ code: "export default () => 1" },
				{ text: "Configured answer" },
			]);
			const { turnId, conversationId } = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "Use configured model",
				modelId: "faux",
				isolate,
			});
			await ws.awaitTurn(scope, turnId, 20_000);
			const events = await ws.readEvents(scope, { conversationId });
			const done = events.find((event) => event.type === "assistant.done");
			expect(done?.type === "assistant.done" && done.model).toBe("faux");
			if (done?.type !== "assistant.done")
				throw new Error("No completed answer");
			const messages = await ws.readMessages(scope, conversationId);
			const expected = messages
				.filter((message) => message.role === "assistant")
				.reduce(
					(total, message) =>
						total +
						(message.role === "assistant"
							? message.usage.input +
								message.usage.cacheRead +
								message.usage.cacheWrite
							: 0),
					0,
				);
			expect(done.usage?.inputTokens).toBe(expected);
			expect(done.usage?.partial).toBe(false);
			expect(done.usage).not.toHaveProperty("costCents");
			const history = await ws.readLedger(scope, conversationId, {
				limit: 100,
			});
			expect(history.find((event) => event.type === "assistant.done")).toEqual(
				done,
			);
		},
	);

	test("an unsupported socket model is rejected before a conversation or turn is written", async () => {
		const ws = workspace();
		const before = await ws.readEvents(scope, { after: 0, limit: 5000 });
		const socket = (
			await ws.fetch(
				new Request("https://workspace.test/subscribe", {
					headers: {
						Upgrade: "websocket",
						"X-Workspace-Org": scope.organizationId,
						"X-Workspace-Id": scope.workspaceId,
						"X-Workspace-Actor-Id": "u1",
					},
				}),
			)
		).webSocket;
		if (!socket) throw new Error("No socket");
		try {
			const rejected = socketFramesUntil(
				socket,
				(frame) => frame.type === "error",
			);
			socket.send(
				JSON.stringify({
					type: "send_turn",
					clientTurnId: crypto.randomUUID(),
					conversationId: null,
					text: "Override",
					modelId: "unconfigured/provider",
				}),
			);
			expect((await rejected).at(-1)).toMatchObject({
				type: "error",
				message: "This model is not configured for workspace chat",
			});
			expect(
				await ws.readEvents(scope, { after: before.at(-1)?.seq ?? 0 }),
			).toEqual([]);
		} finally {
			socket.close(1000, "test complete");
		}
	});

	test("socket catalog and selected model use the same server configuration", async () => {
		await seedCore();
		const ws = workspace();
		await ws.scriptModel(scope, [{ text: "Socket answer" }]);
		const socket = (
			await ws.fetch(
				new Request("https://workspace.test/subscribe", {
					headers: {
						Upgrade: "websocket",
						"X-Workspace-Org": scope.organizationId,
						"X-Workspace-Id": scope.workspaceId,
						"X-Workspace-Actor-Id": "u1",
					},
				}),
			)
		).webSocket;
		if (!socket) throw new Error("No socket");
		try {
			const replay = socketFramesUntil(
				socket,
				(frame) => frame.type === "caught_up",
			);
			socket.send(
				JSON.stringify({
					type: "subscribe",
					conversationId: null,
					cursor: null,
				}),
			);
			const hello = (await replay).find((frame) => frame.type === "hello");
			expect(hello?.models).toEqual([
				{ id: "faux", label: "Scripted test model" },
			]);
			const clientTurnId = crypto.randomUUID();
			const accepted = socketFramesUntil(
				socket,
				(frame) => frame.type === "turn.accepted",
			);
			socket.send(
				JSON.stringify({
					type: "send_turn",
					clientTurnId,
					conversationId: null,
					text: "Selected",
					modelId: "faux",
				}),
			);
			const receipt = (await accepted).at(-1)!;
			await ws.awaitTurn(scope, clientTurnId, 20_000);
			const events = await ws.readEvents(scope, {
				conversationId: String(receipt.conversationId),
			});
			expect(
				events.find((event) => event.type === "assistant.done"),
			).toMatchObject({ model: "faux" });
		} finally {
			socket.close(1000, "test complete");
		}
	});
});

test.each(["before", "after"] as const)(
	"replays durable actions after a %s publication failure without duplicates",
	async (when) => {
		await seedCore();
		const actionScope = { ...scope, workspaceId: crypto.randomUUID() };
		await createDbQueryClient(testEnv.DB).insert(osWorkspaces).values({
			id: actionScope.workspaceId,
			organizationId: actionScope.organizationId,
			name: "Action replay",
			visibility: "org",
			createdByKind: "user",
			createdById: "u1",
		});
		const ws = workspace(actionScope);
		await ws.failActionProjection(actionScope, when);
		await ws.scriptModel(actionScope, [
			{ code: "export default async (env) => env.work.listOpen()" },
			{ text: "Read the Work list." },
		]);
		const { turnId } = await ws.sendTurn(actionScope, {
			actorId: "u1",
			actorKind: "external_agent",
			text: "List open Work",
		});
		expect((await ws.awaitTurn(actionScope, turnId, 20_000)).status).toBe(
			"finished",
		);
		const records = await ws.readChangeRecords(actionScope);
		expect(records).toHaveLength(1);
		if (when === "before")
			expect((await ws.reconcileActivity(actionScope)).missing).toEqual([
				records[0]!.id,
			]);
		await ws.retryProjections(actionScope);
		expect((await ws.reconcileActivity(actionScope)).missing).toEqual([]);
		await ws.replayActivity(actionScope);
		const projected = await testEnv.DB.prepare(
			"SELECT actor_kind, change_record_id FROM workspace_activity WHERE workspace_id = ? AND kind = 'run' AND change_record_id NOT LIKE 'workspace-event:%'",
		)
			.bind(actionScope.workspaceId)
			.all();
		expect(projected.results).toEqual([
			{ actor_kind: "external_agent", change_record_id: records[0]!.id },
		]);
		await testEnv.DB.prepare(
			"DELETE FROM workspace_activity WHERE workspace_id = ?",
		)
			.bind(actionScope.workspaceId)
			.run();
		expect((await ws.reconcileActivity(actionScope)).missing).toEqual([
			records[0]!.id,
		]);
		await ws.replayActivity(actionScope);
		expect((await ws.reconcileActivity(actionScope)).missing).toEqual([]);
	},
);

test("recovers intermediate file revisions when output notifications coalesce", async () => {
	await seedCore();
	const ws = workspace();
	const id = "coalesced-file";
	const now = new Date().toISOString();
	const body = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify({ kind: "document", blocks: [] }),
	);
	await ws.failNextProjection(scope);
	await ws.outputQuery(scope, {
		op: "create",
		output: {
			id,
			...scope,
			kind: "document",
			title: "Recovery file",
			currentRevisionId: "coalesced-r1",
			createdByKind: "user",
			createdById: "u1",
			createdAt: now,
			updatedAt: now,
		},
		revision: {
			id: "coalesced-r1",
			organizationId: scope.organizationId,
			outputId: id,
			revision: 1,
			content: "",
			...body,
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			createdByKind: "user",
			createdById: "u1",
			createdAt: now,
		},
	});
	const changed = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify({
			kind: "document",
			blocks: [{ type: "paragraph", text: "Second save" }],
		}),
	);
	const revised = await ws.outputQuery(scope, {
		op: "revise",
		params: {
			id: "coalesced-r2",
			organizationId: scope.organizationId,
			outputId: id,
			expectedRevision: 1,
			...changed,
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			createdByKind: "external_agent",
			createdById: "agent-fixture",
		},
	});
	expect(revised.ok).toBe(true);
	const activity = await testEnv.DB.prepare(
		"SELECT revision, change_record_id, actor_kind FROM workspace_activity WHERE entity_id = ? AND kind = 'output' ORDER BY revision",
	)
		.bind(id)
		.all();
	expect(activity.results).toEqual([
		{ revision: 1, change_record_id: "coalesced-r1", actor_kind: "user" },
		{
			revision: 2,
			change_record_id: "coalesced-r2",
			actor_kind: "external_agent",
		},
	]);
	expect(
		(
			await getWorkspaceOutputIndexCurrent(createDbQueryClient(testEnv.DB), {
				organizationId: scope.organizationId,
				outputId: id,
			})
		)?.revision,
	).toBe(2);
});

test.each(["before", "after"] as const)(
	"repairs sanitized conversation activity after a %s publication failure",
	async (when) => {
		await seedCore();
		const eventScope = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([eventScope]);
		const ws = workspace(eventScope);
		await ws.scriptModel(eventScope, [
			{ text: "Private answer secret-marker" },
		]);
		const started = await ws.sendTurn(eventScope, {
			actorId: "requesting-agent",
			actorKind: "external_agent",
			text: "Private question secret-marker",
		});
		expect(
			(await ws.awaitTurn(eventScope, started.turnId, 20_000)).status,
		).toBe("finished");
		const source = { source: "events" as const };
		const before = await ws.reconcileActivity(eventScope, source);
		expect(before).toMatchObject({
			checked: 4,
			coverage: "recorded_workspace_events",
		});
		expect(before.missing).toHaveLength(4);
		await ws.failEventProjection(eventScope, when);
		await ws.retryProjections(eventScope);
		expect(
			(await ws.reconcileActivity(eventScope, source)).missing,
		).toHaveLength(when === "before" ? 4 : 3);
		await ws.retryProjections(eventScope);
		expect((await ws.reconcileActivity(eventScope, source)).missing).toEqual(
			[],
		);
		const page = await ws.replayActivity(eventScope, { ...source, limit: 2 });
		expect(page.published).toBe(2);
		expect(
			(
				await ws.replayActivity(eventScope, {
					...source,
					afterSequence: page.lastSequence,
				})
			).published,
		).toBe(2);
		const projected = await testEnv.DB.prepare(
			"SELECT actor_kind, actor_id, change_record_id, summary FROM workspace_feed_ledger WHERE workspace_id = ? ORDER BY seq",
		)
			.bind(eventScope.workspaceId)
			.all<{
				actor_kind: string;
				actor_id: string;
				change_record_id: string;
				summary: string;
			}>();
		expect(projected.results).toHaveLength(4);
		expect(
			projected.results.map((row) => JSON.parse(row.summary).action.operation),
		).toEqual([
			"conversation.updated",
			"turn.started",
			"assistant.done",
			"turn.finished",
		]);
		expect(projected.results[1]).toMatchObject({
			actor_kind: "external_agent",
			actor_id: "requesting-agent",
		});
		expect(projected.results[2]).toMatchObject({
			actor_kind: "service",
			actor_id: "workspace_object",
		});
		expect(JSON.stringify(projected.results)).not.toContain("secret-marker");
		await ws.pruneChatLedger(eventScope);
		expect(await ws.readEvents(eventScope)).toEqual([]);
		await testEnv.DB.prepare(
			"DELETE FROM workspace_activity WHERE workspace_id = ?",
		)
			.bind(eventScope.workspaceId)
			.run();
		expect(
			(await ws.reconcileActivity(eventScope, source)).missing,
		).toHaveLength(4);
		await ws.replayActivity(eventScope, source);
		expect((await ws.reconcileActivity(eventScope, source)).missing).toEqual(
			[],
		);
		let scopeError: unknown;
		try {
			await ws.replayActivity(
				{ ...eventScope, organizationId: "other-org" },
				source,
			);
		} catch (error) {
			scopeError = error;
		}
		expect(scopeError).toBeInstanceOf(Error);
		expect((scopeError as Error).message).toBe(
			"TenantStore scope does not match this object",
		);
	},
);

test("retains each metadata operation while publication is unavailable", async () => {
	await seedCore();
	const metadataScope = { ...scope, workspaceId: crypto.randomUUID() };
	await seedWorkspaceRows([metadataScope]);
	const ws = workspace(metadataScope);
	await seedOutputs(ws, metadataScope);
	for (const patch of [
		{ title: "Private rename secret-marker" },
		{ status: "archived" as const },
		{ status: "active" as const },
	]) {
		await ws.failEventProjection(metadataScope, "before");
		expect(
			await ws.outputQuery(metadataScope, {
				op: "update",
				outputId: "out-doc",
				patch,
			}),
		).toBeDefined();
	}
	const source = { source: "events" as const };
	expect(await ws.reconcileActivity(metadataScope, source)).toMatchObject({
		checked: 3,
		coverage: "recorded_workspace_events",
	});
	expect(
		(await ws.reconcileActivity(metadataScope, source)).missing,
	).toHaveLength(3);
	await ws.retryProjections(metadataScope);
	expect((await ws.reconcileActivity(metadataScope, source)).missing).toEqual(
		[],
	);
	await ws.replayActivity(metadataScope, source);
	const projected = await testEnv.DB.prepare(
		"SELECT actor_kind, actor_id, summary FROM workspace_feed_ledger WHERE workspace_id = ? AND kind = 'run' ORDER BY seq",
	)
		.bind(metadataScope.workspaceId)
		.all<{ actor_kind: string; actor_id: string; summary: string }>();
	expect(projected.results).toHaveLength(3);
	expect(
		projected.results.map((row) => JSON.parse(row.summary).action.operation),
	).toEqual(["update_metadata", "archive", "restore"]);
	for (const row of projected.results) {
		expect(row).toMatchObject({
			actor_kind: "service",
			actor_id: "workspace_object",
		});
		expect(JSON.parse(row.summary).action).toMatchObject({
			outcome: "applied",
			revisionId: "rev-doc",
		});
	}
	expect(JSON.stringify(projected.results)).not.toContain("secret-marker");
	expect(
		await ws.outputQuery(metadataScope, {
			op: "update",
			outputId: "absent-output",
			patch: { title: "Absent" },
		}),
	).toBeUndefined();
	expect((await ws.reconcileActivity(metadataScope, source)).checked).toBe(3);
});

test("moves object-owned outputs with every revision, resumes lost replies, and permits moving back", async () => {
	await seedCore();
	const source = { ...scope, workspaceId: crypto.randomUUID() };
	const target = { ...scope, workspaceId: crypto.randomUUID() };
	await seedWorkspaceRows([source, target]);
	const from = workspace(source),
		to = workspace(target);
	const outputId = crypto.randomUUID(),
		revisionId = crypto.randomUUID();
	const body = await storeOutputBody(
		testEnv.R2_BUCKET,
		source.organizationId,
		JSON.stringify({ kind: "document", blocks: [] }),
	);
	await from.outputQuery(source, {
		op: "create",
		output: {
			id: outputId,
			...source,
			title: "Moving file",
			kind: "document",
			status: "active",
			currentRevisionId: revisionId,
			createdByKind: "user",
			createdById: "u1",
		},
		revision: {
			id: revisionId,
			organizationId: source.organizationId,
			outputId,
			revision: 1,
			content: "",
			...body,
			createdByKind: "user",
			createdById: "u1",
		},
	});
	const revision2 = crypto.randomUUID();
	await from.outputQuery(source, {
		op: "revise",
		params: {
			id: revision2,
			organizationId: source.organizationId,
			outputId,
			...body,
			contentSha256: "b".repeat(64),
			createdByKind: "user",
			createdById: "u1",
			expectedRevision: 1,
		},
	});
	await to.failTransferReply(target);
	let transferError: unknown;
	try {
		await from.transferOutput(source, outputId, target.workspaceId);
	} catch (error) {
		transferError = error;
	}
	expect(transferError).toBeInstanceOf(Error);
	expect((transferError as Error).message).toBe("Injected lost transfer reply");
	for (const [stub, bound] of [
		[from, source],
		[to, target],
	] as const) {
		let editError: unknown;
		try {
			await stub.outputQuery(bound, {
				op: "update",
				outputId,
				patch: { title: "Premature edit" },
			});
		} catch (error) {
			editError = error;
		}
		expect(editError).toBeInstanceOf(Error);
		expect((editError as Error).message).toBe(
			"Output transfer in progress or output moved",
		);
	}
	expect(
		await from.transferOutput(source, outputId, crypto.randomUUID()),
	).toEqual({ ok: false, reason: "conflict" });
	await from.retryProjections(source);
	expect(
		await from.outputQuery(source, { op: "get", outputId }),
	).toBeUndefined();
	expect(await to.outputQuery(target, { op: "get", outputId })).toMatchObject({
		workspaceId: target.workspaceId,
		currentRevisionId: revision2,
	});
	for (const id of [revisionId, revision2]) {
		expect(
			await to.outputQuery(target, { op: "revision", revisionId: id }),
		).toMatchObject({ id, bodyR2Key: body.bodyR2Key });
		const indexed = await testEnv.DB.prepare(
			"SELECT workspace_id FROM workspace_output_index WHERE revision_id = ?",
		)
			.bind(id)
			.first<{ workspace_id: string }>();
		expect(indexed?.workspace_id).toBe(target.workspaceId);
	}
	await expect(
		to.outputQuery(target, {
			op: "update",
			outputId,
			patch: { title: "Moved file" },
		}),
	).resolves.toMatchObject({ title: "Moved file" });
	await from.retryProjections(source);
	expect(
		await getWorkspaceOutputIndexCurrent(createDbQueryClient(testEnv.DB), {
			organizationId: source.organizationId,
			outputId,
		}),
	).toMatchObject({ workspaceId: target.workspaceId, revisionId: revision2 });
	expect(
		await to.transferOutput(target, outputId, source.workspaceId),
	).toMatchObject({
		ok: true,
		output: { workspaceId: source.workspaceId, title: "Moved file" },
	});
	await expect(
		from.outputQuery(source, {
			op: "update",
			outputId,
			patch: { title: "Back home" },
		}),
	).resolves.toMatchObject({ title: "Back home" });
	expect(
		await from.transferOutput(source, "missing", target.workspaceId),
	).toEqual({ ok: false, reason: "not_found" });
});
