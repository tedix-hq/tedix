import { grantOsWorkspaceAccess } from "@tedix/db/queries/os-collaborators";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
} from "@tedix/db/schema/os-collaborators";
import { InternalEntrypoint } from "../src/index";
import {
	createExecutionContext,
	env,
	evictDurableObject,
	runInDurableObject,
} from "cloudflare:test";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, test, vi } from "vite-plus/test";
import {
	osGadgets,
	osGadgetRevisions,
	osGadgetCode,
	osGadgetCodeBlobs,
	osWorkspaceProjects,
	osWorkspaceResources,
	osWorkspaceSummaries,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import {
	applyOsWorkspaceSummary,
	getOsWorkspaceSummary,
	parseOsWorkspaceSummaryPayload,
} from "@tedix/db/queries/os-workspaces/summaries";
import { connectionInstances } from "@tedix/db/schema/connection-instances";
import { connectionProviders } from "@tedix/db/schema/connection-providers";
import { apps } from "@tedix/db/schema/apps";
import { appTools } from "@tedix/db/schema/tools";
import type {
	WorkspaceConnectionDecisionInput,
	WorkspaceConnectionReadInput,
	WorkspaceConnectionReadResult,
} from "@tedix/api-contract/schemas/workspace-connection-read";
import type {
	WorkspaceMachineInput,
	WorkspaceMachineResult,
} from "@tedix/api-contract/schemas/workspace-machine";
import { tedis } from "@tedix/db/schema/tedis";
import { organizations } from "@tedix/db/schema/organizations";
import {
	WORKSPACE_ROOM_OUTPUT_REVISION_PATH,
	workspaceRoomName,
} from "@tedix/api-contract/utils/workspace-room";
import {
	workspaceFeedLedger,
	workspaceFeedCursors,
	workspaceActivity,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "@tedix/db/schema/workspace-feed";
import { projects } from "@tedix/db/schema/projects";
import { osShareLinks, osReviewBatches } from "@tedix/db/schema/os-shares";
import { osCollaborationProposals } from "@tedix/db/schema/os-workspaces";
import { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { workEvidence } from "@tedix/db/schema/work-items";
import {
	workAttemptMessages,
	workAttemptSteps,
	workAttempts,
	workEvents,
	workItemComments,
	workItems,
} from "@tedix/db/schema/work-items";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
	listWorkspaceActivity,
} from "@tedix/db/queries/workspace-feed/read";
import {
	readOutputBody,
	storeOutputBody,
	TenantDataPort,
} from "../src/data-port-tenant";
import {
	FILE_TEXT_INLINE_CHARS,
	FILE_TEXT_PART_CHARS,
	encodedLength,
	readTextPart,
} from "../src/file-text";
import { workspaceFileTextKey } from "@tedix/api-contract/utils/workspace-file-text";
import { EVENT_PAGE_CHARS } from "../src/event-ledger";
import {
	getOsAppEditDraft,
	decideOsCollaborationProposal,
	mergeOsCollaborationProposal,
} from "@tedix/db/queries/os-workspaces/collaboration";
import { createOsGadgetRevision } from "@tedix/db/queries/os-workspaces/gadgets";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	createLoaderSandbox,
	sandboxTimeoutError,
	validateWorkspaceAppSource,
} from "../src/sandbox";
import { COMPATIBILITY_DATE } from "../src/do";
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

type Stub = DurableObjectStub &
	WorkspaceRpc & {
		failTransferReply(scope: WorkspaceScope): Promise<void>;
		pruneChatLedger(scope: WorkspaceScope): Promise<void>;
		disableActivityProjection(scope: WorkspaceScope): Promise<void>;
		failNextProjection(scope: WorkspaceScope): Promise<void>;
		delayProjections(scope: WorkspaceScope, ms: number): Promise<void>;
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
		limitCodeRuns(scope: WorkspaceScope, ms: number): Promise<void>;
		webFetchCount(scope: WorkspaceScope): Promise<number>;
		scriptAccountReads(
			scope: WorkspaceScope,
			responses: WorkspaceConnectionReadResult[],
		): Promise<void>;
		readAccountCalls(
			scope: WorkspaceScope,
		): Promise<
			Array<WorkspaceConnectionReadInput | WorkspaceConnectionDecisionInput>
		>;
		scriptMachine(
			scope: WorkspaceScope,
			responses: WorkspaceMachineResult[],
		): Promise<void>;
		readMachineCalls(scope: WorkspaceScope): Promise<WorkspaceMachineInput[]>;
		readSystemPrompts(scope: WorkspaceScope): Promise<string[]>;
		readModelCalls(scope: WorkspaceScope): Promise<string[][]>;
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
	requestScope = scope,
) {
	const socket = (
		await ws.fetch(
			new Request("https://workspace.test/subscribe", {
				headers: {
					Upgrade: "websocket",
					"X-Workspace-Org": requestScope.organizationId,
					"X-Workspace-Id": requestScope.workspaceId,
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
		organizationMembers,
		osWorkspaceCollaborators,
		osWorkspaceAccessEdges,
		osWorkspaceShareLinks,
		osWorkspaces,
		workspaceFeedLedger,
		workspaceFeedCursors,
		workspaceActivity,
		workspaceOutputIndex,
		workspaceWorkLinks,
		osWorkspaceProjects,
		osWorkspaceResources,
		osWorkspaceSummaries,
		osGadgets,
		tedis,
		projects,
		workItems,
		workEvents,
		osShareLinks,
		osReviewBatches,
		osCollaborationProposals,
		kernelRuntimeRuns,
		workEvidence,
	];
	await testEnv.DB.batch([
		...tables.map((table) => testEnv.DB.prepare(ddl(table))),
		testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS os_workspace_collaborators_workspace_user_unique ON os_workspace_collaborators(workspace_id, user_id)",
		),
		testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS os_workspace_access_edges_unique ON os_workspace_access_edges(workspace_id, target_user_id, edge_key)",
		),
		testEnv.DB.prepare(
			"INSERT OR REPLACE INTO organization_members (id, organization_id, descope_user_id, email, role, status, kind) VALUES (?, ?, 'u1', 'u1@example.test', 'member', 'active', 'human')",
		).bind(`fixture-u1-${scope.organizationId}`, scope.organizationId),
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

/** A store moved in November 2026: it owns its files but has not yet taken its resources. */
async function markMovedOwner(ws: Stub) {
	await runInDurableObject(ws, (_instance, state) => {
		state.storage.kv.put("output-authority", "object");
	});
}

async function seedWorkspaceRows(scopes: WorkspaceScope[]) {
	const now = "2026-11-07T10:00:00.000Z";
	await testEnv.DB.batch(
		[...new Set(scopes.map((s) => s.organizationId))].map((organizationId) =>
			testEnv.DB.prepare(
				"INSERT OR REPLACE INTO organization_members (id, organization_id, descope_user_id, email, role, status, kind) VALUES (?, ?, 'u1', 'u1@example.test', 'member', 'active', 'human')",
			).bind(`fixture-u1-${organizationId}`, organizationId),
		),
	);
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
	await testEnv.DB.prepare(
		"INSERT OR IGNORE INTO os_workspaces (id, organization_id, name, description, status, created_by_kind, created_by_id, created_at, updated_at, visibility) VALUES (?, ?, 'Fixture workspace', '', 'active', 'user', 'u1', ?, ?, 'org')",
	)
		.bind(outputScope.workspaceId, outputScope.organizationId, now, now)
		.run();
	await ws.outputQuery(outputScope, { op: "initialize" });
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
			// One step: shown while the code is written, then while it runs.
			"Writing the next step",
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
		// Each step carries what ran and the start of what came back.
		const codeStep = steps[1];
		if (codeStep?.type !== "step.started") throw new Error("no code step");
		expect(codeStep.input).toEqual({ code: READ_ONLY_CODE });
		const results = events.flatMap((event) =>
			event.type === "step.finished" ? [event] : [],
		);
		expect(
			results.find((event) => event.stepId === codeStep.stepId)?.result,
		).toContain("return value:");
		expect(results.every((event) => typeof event.result === "string")).toBe(
			true,
		);
		expect(results.every((event) => (event.result?.length ?? 0) < 4_100)).toBe(
			true,
		);
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
		expect(await ws.listConversationTurnIds(scope, conversationId)).toEqual([
			turnId,
		]);
		expect(
			await ws.listConversationTurnIds(scope, "another-conversation"),
		).toEqual([]);
		const [listed] = await ws.listConversations(scope);
		expect(listed?.id).toBe(conversationId);
		// A person started it, so it is not an agent's run.
		expect(listed?.startedBy).toBeUndefined();
		// The conversation carries what its finished reply used.
		expect(listed?.usage).toMatchObject({
			inputTokens:
				done?.type === "assistant.done" ? done.usage?.inputTokens : -1,
			outputTokens:
				done?.type === "assistant.done" ? done.usage?.outputTokens : -1,
		});
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
		await ws.outputQuery(scope, { op: "initialize" });
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
				await ws.disableActivityProjection(workspaceScope);
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
		const projected = await testEnv.DB.prepare(
			"SELECT COUNT(*) AS count FROM workspace_feed_ledger WHERE workspace_id LIKE '00000000-0000-4000-8000-%'",
		).first<{ count: number }>();

		const p50 = percentile(latencies, 0.5);
		const p95 = percentile(latencies, 0.95);
		console.info(
			`workspace-do load: turns=${latencies.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms`,
		);
		expect(latencies).toHaveLength(250);
		expect(projected?.count).toBe(0);
		expect(p95).toBeLessThan(20_000);
	});

	test.each(["sheets", "presentations"] as const)(
		"%s edits round-trip through the sandbox and apply in the turn with a receipt",
		async (binding) => {
			await seedCore();
			const workspaceScope = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([workspaceScope]);
			const ws = workspace(workspaceScope);
			await ws.outputQuery(workspaceScope, { op: "initialize" });
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
					? { startRow: 0, startColumn: 0, cells: [["Applied gadget edit"]] }
					: {
							ops: [
								{
									op: "replace",
									index: 0,
									slide: { title: "Applied gadget edit", bullets: [] },
								},
							],
						};
			await ws.scriptModel(workspaceScope, [
				{
					code: `export default async env=>{const output=await env.${binding}.read({outputId:${JSON.stringify(outputId)}});return env.${binding}.edit({outputId:output.id,expectedRevision:output.revision,...${JSON.stringify(edit)}});}`,
				},
				{ text: "Saved" },
			]);
			const started = await ws.sendTurn(workspaceScope, {
				actorId: "u1",
				actorKind: "user",
				text: "Edit the gadget output",
			});
			expect(
				await ws.awaitTurn(workspaceScope, started.turnId, 20000),
			).toMatchObject({ status: "finished", text: "Saved" });
			const events = await ws.readEvents(workspaceScope, {
				conversationId: started.conversationId,
				after: 0,
			});
			const approval = events.find(
				(event) => event.type === "approval.requested",
			);
			if (approval?.type !== "approval.requested")
				throw new Error("Missing typed-output write");
			expect(approval.title).toBe(
				binding === "sheets" ? "Editing sheet cells" : "Editing slides",
			);
			expect(approval.automatic).toBe(true);
			expect(
				events.some(
					(event) =>
						event.type === "step.started" &&
						event.tool === `${binding}.edit` &&
						event.kind === "write",
				),
			).toBe(true);
			// Nobody is asked: the edit is recorded for the person the turn
			// acts for and applied in the same turn.
			expect(
				events
					.filter((event) => event.type.startsWith("approval."))
					.map((event) => event.type),
			).toEqual([
				"approval.requested",
				"approval.decided",
				"approval.executed",
			]);
			expect(
				events.find((event) => event.type === "approval.decided"),
			).toMatchObject({
				approvalId: approval.approvalId,
				decision: "approve",
				by: "u1",
				automatic: true,
			});
			expect(
				events.find((event) => event.type === "approval.executed"),
			).toMatchObject({
				approvalId: approval.approvalId,
				status: "applied",
				output: { outputId, revision: 2 },
			});
			expect(
				events.filter((event) => event.type === "turn.started"),
			).toHaveLength(1);
			const saved = await ws.outputQuery(workspaceScope, {
				op: "get",
				outputId,
			});
			expect(saved?.currentRevisionId).not.toBe(revisionId);
			// The model got the saved file back as the call's result.
			const messages = await ws.readMessages(
				workspaceScope,
				started.conversationId,
			);
			expect(
				JSON.stringify(
					messages.filter((message) => message.role === "toolResult"),
				),
			).toContain("Applied gadget edit");
			const records = (
				await ws.readChangeRecords(workspaceScope, { resource: "output" })
			).filter((record) => record.operation === "edit");
			expect(records.map((record) => record.outcome)).toEqual([
				"needs_approval",
				"applied",
			]);
			expect(records[1]?.before?.revisionId).toBe(revisionId);
			expect(records[1]?.after?.revisionId).toBe(saved?.currentRevisionId);
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
				"approval.automatic",
				"approval.executed",
			]) {
				expect(actions.some((row) => row.action.operation === operation)).toBe(
					true,
				);
			}
			// A request in the feed is what tells people "needs your approval".
			expect(
				actions.some((row) => row.action.operation === "approval.requested"),
			).toBe(false);
			expect(
				actions.find((row) => row.action.operation === "approval.decided"),
			).toMatchObject({ actor_kind: "user", actor_id: "u1" });
			expect(JSON.stringify(lifecycle.results)).not.toContain(
				"Applied gadget edit",
			);
		},
	);

	test("chat file edits share one pinned draft, reject without publishing, merge once and preserve revision history", async () => {
		await seedCore();
		await testEnv.DB.batch(
			[osGadgetRevisions, osGadgetCode, osGadgetCodeBlobs].map((table) =>
				testEnv.DB.prepare(ddl(table)),
			),
		);
		await testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS test_app_blob_key ON os_gadget_code_blobs (organization_id, sha256)",
		).run();
		await testEnv.DB.prepare(
			"INSERT INTO os_gadgets (id, organization_id, workspace_id, name, status, created_by_kind, created_by_id, created_at, updated_at) VALUES ('editable', ?, ?, 'Fixture app', 'active', 'user', 'u1', 'now', 'now')",
		)
			.bind(scope.organizationId, scope.workspaceId)
			.run();
		const files = {
			"server.js": "export class App {}",
			"client.js": "export default () => 'Before';",
		};
		const db = createDbQueryClient(testEnv.DB);
		const initial = await createOsGadgetRevision(db, {
			id: "app-before",
			organizationId: scope.organizationId,
			gadgetId: "editable",
			manifest: JSON.stringify({
				entry: "tedix:runtime/v1",
				capabilities: [],
				config: { version: 1 },
			}),
			createdByKind: "user",
			createdById: "u1",
			expectedRevision: 0,
			code: { files: JSON.stringify(files), codeLength: 1 },
		});
		expect(initial.ok).toBe(true);
		const data = new TenantDataPort({
			...scope,
			tenant: {} as TenantStoreDb,
			core: db,
			bucket: testEnv.R2_BUCKET,
			actorKind: "user",
			validateAppSource: (files, date) =>
				validateWorkspaceAppSource(testEnv.LOADER, files, date),
			assertWorkspaceAuthority: async () => {},
			commitOutput: async () => {
				throw new Error("unused");
			},
			notifyOutputRevision: async () => {},
		});
		const ws = workspace();

		const requestEdit = async (code: string) => {
			await ws.scriptModel(scope, [{ code }]);
			const started = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "Edit the app",
			});
			await ws.awaitTurn(scope, started.turnId, 20000);
			const events = await ws.readEvents(scope, {
				conversationId: started.conversationId,
				after: 0,
			});
			expect(
				events.filter((e) => e.type === "approval.requested"),
			).toHaveLength(0);
			expect(
				events.filter(
					(e) => e.type === "step.finished" && e.status === "error",
				),
			).toHaveLength(0);
			const draft = await getOsAppEditDraft(db, {
				...scope,
				gadgetId: "editable",
				sourceKind: "chat",
				sourceId: started.conversationId,
			});
			expect(draft).toBeDefined();
			return draft!;
		};
		const code = `export default async env => {
   const file = await env.apps.readFile({appId:"editable",path:"client.js"});
   const matches = await env.apps.grep({appId:"editable",query:"Before"});
   if (matches.matches.length !== 1) throw new Error("Search missed the source");
   await env.apps.editFile({appId:"editable",path:"client.js",expectedRevisionId:file.revisionId,before:"Before",after:"After"});
   const changed = await env.apps.readFile({appId:"editable",path:"client.js"});
   if (!changed.content.includes("After")) throw new Error("Read did not see pending edits");
   return env.apps.writeFile({appId:"editable",path:"README.md",expectedRevisionId:file.revisionId,proposalId:changed.proposalId,expectedSequence:changed.sequence,content:"App notes"});
  }`;
		const rejected = await requestEdit(code);
		expect(rejected.sequence).toBe(1);
		expect((await data.getAppCode({ appId: "editable" })).files).toEqual(files);
		await decideOsCollaborationProposal(db, {
			organizationId: scope.organizationId,
			proposalId: rejected.id,
			expectedSequence: rejected.sequence,
			decision: "rejected",
			rationale: "Discard",
			evidenceRefs: "[]",
			decidedByKind: "user",
			decidedById: "u1",
		});
		expect((await data.getAppCode({ appId: "editable" })).revision).toBe(1);
		const pending = await requestEdit(code);
		expect(pending.id).not.toBe(rejected.id);
		const content = JSON.parse(pending.content);
		expect(content.files["server.js"]).toBe(files["server.js"]);
		expect(content.files["README.md"]).toBe("App notes");
		await validateWorkspaceAppSource(testEnv.LOADER, content.files, undefined);
		await decideOsCollaborationProposal(db, {
			organizationId: scope.organizationId,
			proposalId: pending.id,
			expectedSequence: pending.sequence,
			decision: "accepted",
			rationale: "Accept",
			evidenceRefs: "[]",
			decidedByKind: "user",
			decidedById: "u1",
		});
		const decision = {
			organizationId: scope.organizationId,
			proposalId: pending.id,
			expectedSequence: pending.sequence,
			revisionId: "app-after",
			rationale: "Accept",
			evidenceRefs: "[]",
			mergedByKind: "user" as const,
			mergedById: "u1",
		};
		expect((await mergeOsCollaborationProposal(db, decision)).ok).toBe(true);
		expect((await mergeOsCollaborationProposal(db, decision)).ok).toBe(false);
		expect((await data.getAppCode({ appId: "editable" })).revision).toBe(2);
		expect(
			(await data.getAppCode({ appId: "editable" })).files["client.js"],
		).toContain("After");
		expect(
			(await data.getAppCode({ appId: "editable", revisionId: "app-before" }))
				.files,
		).toEqual(files);
		const records = await ws.readChangeRecords(scope, {
			resource: "app_draft",
		});
		expect(records).toHaveLength(4);
		expect(records.every((record) => record.outcome === "applied")).toBe(true);
		for (const broken of [
			{ ...files, "client.js": "const broken = ;" },
			{ ...files, "server.js": "export const App = 1;" },
		])
			await expect(
				validateWorkspaceAppSource(testEnv.LOADER, broken, undefined),
			).rejects.toThrow();
		expect((await data.getAppCode({ appId: "editable" })).revision).toBe(2);
		// Going back stages version 1's whole file set: the README added in
		// version 2 is gone, and accepting saves version 3.
		const restoring = await requestEdit(`export default async env => {
   const versions = await env.apps.versions({appId:"editable"});
   const now = versions.find(v => v.current);
   const first = versions.find(v => v.revision === 1);
   return env.apps.restoreVersion({appId:"editable",revisionId:first.revisionId,expectedRevisionId:now.revisionId});
  }`);
		expect(JSON.parse(restoring.content).files).toEqual(files);
		expect(
			(
				await mergeOsCollaborationProposal(db, {
					...decision,
					proposalId: restoring.id,
					expectedSequence: restoring.sequence,
					revisionId: "app-restored",
				})
			).ok,
		).toBe(false);
		await decideOsCollaborationProposal(db, {
			organizationId: scope.organizationId,
			proposalId: restoring.id,
			expectedSequence: restoring.sequence,
			decision: "accepted",
			rationale: "Accept",
			evidenceRefs: "[]",
			decidedByKind: "user",
			decidedById: "u1",
		});
		expect(
			(
				await mergeOsCollaborationProposal(db, {
					...decision,
					proposalId: restoring.id,
					expectedSequence: restoring.sequence,
					revisionId: "app-restored",
				})
			).ok,
		).toBe(true);
		const restored = await data.getAppCode({ appId: "editable" });
		expect(restored.revision).toBe(3);
		expect(restored.files).toEqual(files);
		expect((await data.listAppVersions({ appId: "editable" })).length).toBe(3);
		await testEnv.DB.prepare(
			"UPDATE os_gadgets SET workspace_id = 'another-workspace' WHERE id = 'editable'",
		).run();
		await expect(
			data.getAppCode({ appId: "editable", revisionId: "app-before" }),
		).rejects.toThrow("not found in this workspace");
	});

	test("the agent creates a new app only after its files pass the check and the person approves", async () => {
		await seedCore();
		await testEnv.DB.batch(
			[osGadgetRevisions, osGadgetCode, osGadgetCodeBlobs].map((table) =>
				testEnv.DB.prepare(ddl(table)),
			),
		);
		await testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS test_app_blob_key ON os_gadget_code_blobs (organization_id, sha256)",
		).run();
		await testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS test_app_name ON os_gadgets (workspace_id, name)",
		).run();
		const db = createDbQueryClient(testEnv.DB);
		const ws = workspace();
		const appRows = async () =>
			(
				await testEnv.DB.prepare(
					"SELECT id, name, current_revision_id, created_by_kind, created_by_id FROM os_gadgets WHERE workspace_id = ? ORDER BY name",
				)
					.bind(scope.workspaceId)
					.all<{
						id: string;
						name: string;
						current_revision_id: string | null;
						created_by_kind: string;
						created_by_id: string;
					}>()
			).results;
		const files = {
			"server.js":
				"export class App { count() { const n = (this.ctx.storage.kv.get('n') ?? 0) + 1; this.ctx.storage.kv.put('n', n); return n; } }",
			"client.js":
				"const root = document.getElementById('app'); root.textContent = String(await tedix.call('app.call', { method: 'count', args: [] }));",
			"README.md": "Counts how often it was opened.",
		};
		const ask = async (input: unknown) => {
			await ws.scriptModel(scope, [
				{
					code: `export default async env => env.apps.create(${JSON.stringify(input)})`,
				},
				{ text: "Done" },
			]);
			const started = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "Build me an app",
			});
			await ws.awaitTurn(scope, started.turnId, 20000);
			return {
				...started,
				events: await ws.readEvents(scope, {
					conversationId: started.conversationId,
					after: 0,
				}),
			};
		};

		// Source that does not load is refused before anyone is asked.
		const broken = await ask({
			name: "Broken",
			files: { ...files, "server.js": "export const App = 1;" },
		});
		expect(
			broken.events.filter((event) => event.type === "approval.requested"),
		).toHaveLength(0);
		expect(
			broken.events.some(
				(event) => event.type === "step.finished" && event.status === "error",
			),
		).toBe(true);
		const missing = await ask({
			name: "Missing",
			files: { "client.js": "" },
		});
		expect(
			missing.events.filter((event) => event.type === "approval.requested"),
		).toHaveLength(0);
		expect(
			JSON.stringify(await ws.readMessages(scope, missing.conversationId)),
		).toContain("server.js is required");
		expect(await appRows()).toEqual([]);
		const createRecords = async () =>
			(await ws.readChangeRecords(scope, { resource: "app" })).filter(
				(record) => record.operation === "create",
			);
		expect(await createRecords()).toEqual([]);

		// Valid source waits on a card; nothing is saved until it is approved.
		const held = await ask({ name: "Visit counter", files });
		const requested = held.events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("Creating an app did not ask for approval");
		expect(requested.title).toBe("Creating a new app");
		expect(requested.input).toEqual({
			name: "Visit counter",
			files: {
				"server.js": `${files["server.js"].length} characters`,
				"client.js": `${files["client.js"].length} characters`,
				"README.md": `${files["README.md"].length} characters`,
			},
		});
		expect(requested.automatic).toBeUndefined();
		expect(await appRows()).toEqual([]);

		// File writes apply at once; a new app never does.
		const second = await ask({ name: "Second counter", files });
		const secondRequest = second.events.find(
			(event) => event.type === "approval.requested",
		);
		if (secondRequest?.type !== "approval.requested")
			throw new Error("A new app was created without asking");
		expect(
			second.events.some((event) => event.type === "approval.executed"),
		).toBe(false);
		expect(await appRows()).toEqual([]);
		await ws.scriptModel(scope, [{ text: "Understood." }]);
		const denied = await ws.decideApproval(scope, {
			approvalId: secondRequest.approvalId,
			decision: "deny",
			by: "u1",
		});
		expect(denied.applied).toBe(false);
		if (denied.turnId) await ws.awaitTurn(scope, denied.turnId, 20000);
		expect(await appRows()).toEqual([]);

		await ws.scriptModel(scope, [{ text: "Your app is ready." }]);
		const applied = await ws.decideApproval(scope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(applied.applied).toBe(true);
		if (applied.turnId) await ws.awaitTurn(scope, applied.turnId, 20000);
		const [row] = await appRows();
		expect(row).toMatchObject({
			name: "Visit counter",
			created_by_kind: "user",
			created_by_id: "u1",
		});
		const executed = (
			await ws.readEvents(scope, {
				conversationId: held.conversationId,
				after: 0,
			})
		).find((event) => event.type === "approval.executed");
		expect(executed).toMatchObject({
			status: "applied",
			app: { appId: row!.id, name: "Visit counter" },
		});
		expect(executed).not.toHaveProperty("output");

		// The saved app is a runnable revision 1 with its files and no grants.
		const data = new TenantDataPort({
			...scope,
			tenant: {} as TenantStoreDb,
			core: db,
			bucket: testEnv.R2_BUCKET,
			actorKind: "user",
			validateAppSource: (source, date) =>
				validateWorkspaceAppSource(testEnv.LOADER, source, date),
			assertWorkspaceAuthority: async () => {},
			commitOutput: async () => {
				throw new Error("unused");
			},
			notifyOutputRevision: async () => {},
		});
		const code = await data.getAppCode({ appId: row!.id });
		expect(code.revision).toBe(1);
		expect(code.revisionId).toBe(row!.current_revision_id);
		expect(code.files).toEqual(files);
		expect(code.manifest).toMatchObject({
			entry: "tedix:runtime/v1",
			capabilities: [],
		});
		expect(code.manifest.resourceGrants).toBeUndefined();
		expect((await data.listApps()).map((app) => app.name)).toEqual([
			"Visit counter",
		]);
		expect((await createRecords()).map((record) => record.outcome)).toEqual([
			"needs_approval",
			"needs_approval",
			"applied",
		]);

		const schedule = {
			appId: row!.id,
			expectedRevisionId: code.revisionId,
			schedule: {
				id: "morning",
				kind: "schedule",
				cron: "0 9 * * *",
				method: "count",
			},
		};
		await ws.scriptModel(scope, [
			{
				code: `export default async env => env.apps.registerSchedule(${JSON.stringify(schedule)})`,
			},
		]);
		const scheduled = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Run the counter every morning",
		});
		await ws.awaitTurn(scope, scheduled.turnId, 20000);
		const scheduleEvents = await ws.readEvents(scope, {
			conversationId: scheduled.conversationId,
			after: 0,
		});
		const scheduleApproval = scheduleEvents.find(
			(event) =>
				event.type === "approval.requested" &&
				event.title === "Registering a scheduled run",
		);
		if (!scheduleApproval || scheduleApproval.type !== "approval.requested")
			throw new Error("Schedule registration did not request approval");
		await ws.scriptModel(scope, [
			{ text: "The schedule is off until you turn it on." },
		]);
		const registration = await ws.decideApproval(scope, {
			approvalId: scheduleApproval.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(registration.applied).toBe(true);
		if (registration.turnId)
			await ws.awaitTurn(scope, registration.turnId, 20000);
		const receipt = (
			await ws.readEvents(scope, {
				conversationId: scheduled.conversationId,
				after: 0,
			})
		).find((event) => event.type === "schedule.registered");
		expect(receipt).toMatchObject({
			gadgetId: row!.id,
			triggerId: "morning",
			name: "Visit counter",
		});
		const updated = await data.getAppCode({ appId: row!.id });
		expect(updated.manifest.config?.triggers).toEqual([schedule.schedule]);
		const switched = await testEnv.DB.prepare(
			"SELECT trigger_enabled FROM os_gadgets WHERE id = ?",
		)
			.bind(row!.id)
			.first<{ trigger_enabled: string }>();
		expect(JSON.parse(switched!.trigger_enabled)).toEqual({ morning: false });

		// A name in use is refused by the check, again without a card.
		const taken = await ask({ name: "Visit counter", files });
		expect(
			taken.events.filter((event) => event.type === "approval.requested"),
		).toHaveLength(0);
		expect(
			JSON.stringify(await ws.readMessages(scope, taken.conversationId)),
		).toContain("already exists in this workspace");
		expect(await appRows()).toHaveLength(1);
	});

	test("a new app may read a sheet of its workspace once the person approves the card that names it", async () => {
		await seedCore();
		await testEnv.DB.batch(
			[osGadgetRevisions, osGadgetCode, osGadgetCodeBlobs].map((table) =>
				testEnv.DB.prepare(ddl(table)),
			),
		);
		await testEnv.DB.prepare(
			"CREATE UNIQUE INDEX IF NOT EXISTS test_app_blob_key ON os_gadget_code_blobs (organization_id, sha256)",
		).run();
		// Its own workspace, so no other test's files or apps are in the way.
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		const ws = workspace(own);
		await ws.outputQuery(own, { op: "initialize" });
		const app = {
			name: "Budget tracker",
			files: {
				"server.js": "export class App {}",
				"client.js":
					"const { settings } = await tedix.call('context'); const sheet = await tedix.call('outputs.read', { slot: settings.reads.budget }); document.getElementById('app').textContent = String(sheet.rows.length);",
			},
		};
		await ws.scriptModel(own, [
			{
				code: `export default async env => {
					const sheet = await env.outputs.create({ title: "Trip budget", content: { kind: "sheet", columns: ["Item", "Cost"], rows: [["Flight", 300]] } });
					return env.apps.create({ ...${JSON.stringify(app)}, reads: { budget: sheet.id } }).catch(() => ({ sheetId: sheet.id }));
				}`,
			},
			{ text: "Waiting." },
		]);
		const started = await ws.sendTurn(own, {
			actorId: "u1",
			actorKind: "user",
			text: "Build an app that shows the Trip budget sheet",
		});
		await ws.awaitTurn(own, started.turnId, 20000);
		const requested = (
			await ws.readEvents(own, {
				conversationId: started.conversationId,
				after: 0,
			})
		).find(
			(event) =>
				event.type === "approval.requested" &&
				event.title === "Creating a new app",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("Creating the app did not ask for approval");
		expect(requested.input).toMatchObject({
			name: "Budget tracker",
			mayRead: ["Trip budget"],
		});

		await ws.scriptModel(own, [{ text: "Your app is ready." }]);
		const applied = await ws.decideApproval(own, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(applied.applied).toBe(true);
		if (applied.turnId) await ws.awaitTurn(own, applied.turnId, 20000);

		// The sheet now has the connection apps read files through, and the
		// app's only grant is to read that one slot.
		const bound = await testEnv.DB.prepare(
			"SELECT slot, provider_resource_id, status FROM os_workspace_resources WHERE workspace_id = ? AND provider_id = 'tedix' AND resource_type = 'output' AND name = 'Trip budget'",
		)
			.bind(own.workspaceId)
			.first<{ slot: string; provider_resource_id: string; status: string }>();
		expect(bound?.status).toBe("active");
		const sheetId = /sheetId\W+([0-9a-f-]{36})/.exec(
			JSON.stringify(await ws.readMessages(own, started.conversationId)),
		)?.[1];
		expect(sheetId).toBeDefined();
		expect(bound?.provider_resource_id).toBe(sheetId);
		const saved = await testEnv.DB.prepare(
			"SELECT r.manifest FROM os_gadget_revisions r JOIN os_gadgets g ON g.current_revision_id = r.id WHERE g.workspace_id = ? AND g.name = 'Budget tracker'",
		)
			.bind(own.workspaceId)
			.first<{ manifest: string }>();
		expect(JSON.parse(saved!.manifest)).toMatchObject({
			resourceGrants: [{ slot: bound!.slot, operations: ["outputs.read"] }],
			config: { settings: { reads: { budget: bound!.slot } } },
		});
	});

	test("typed Doc edits use the canonical document; one that removes a block cannot run before approval", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		const current = async () =>
			(await ws.outputQuery(scope, { op: "get", outputId: "out-doc" }))
				?.currentRevisionId;
		expect(await current()).toBe("rev-doc");
		await ws.scriptModel(scope, [
			{
				code: `export default async env => { const doc = await env.documents.read({outputId:"out-doc"}); return env.documents.edit({outputId:doc.id,expectedRevision:doc.revision,ops:[{op:"replace",index:0,block:{type:"heading",level:1,text:"Agent Doc edit"}}]}); }`,
			},
			{ text: "Saved" },
		]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Edit the document",
		});
		expect(await ws.awaitTurn(scope, started.turnId, 20000)).toMatchObject({
			status: "finished",
			text: "Saved",
		});
		const events = await ws.readEvents(scope, {
			conversationId: started.conversationId,
			after: 0,
		});
		const approval = events.find(
			(event) => event.type === "approval.requested",
		);
		if (approval?.type !== "approval.requested")
			throw new Error("Doc edit was not recorded");
		// An edit that removes nothing applies in the turn; nobody is asked.
		expect(approval.automatic).toBe(true);
		expect(
			events.find((event) => event.type === "approval.executed"),
		).toMatchObject({ approvalId: approval.approvalId, status: "applied" });
		const messages = await ws.readMessages(scope, started.conversationId);
		expect(
			JSON.stringify(
				messages.filter((message) => message.role === "toolResult"),
			),
		).toContain("Agent Doc edit");
		const records = await ws.readChangeRecords(scope, { resource: "output" });
		const edits = records.filter((record) => record.operation === "edit");
		expect(edits.map((record) => record.outcome)).toEqual([
			"needs_approval",
			"applied",
		]);
		expect(edits[1]?.before?.revisionId).toBe("rev-doc");
		const saved = await current();
		expect(saved).not.toBe("rev-doc");
		expect(edits[1]?.after?.revisionId).toBe(saved);

		// Removing a block waits on its card and changes nothing until decided.
		await ws.scriptModel(scope, [
			{
				code: `export default async env => { const doc = await env.documents.read({outputId:"out-doc"}); return env.documents.edit({outputId:doc.id,expectedRevision:doc.revision,ops:[{op:"delete",index:0}]}); }`,
			},
			{ text: "Waiting" },
		]);
		const removal = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Remove the heading",
		});
		await ws.awaitTurn(scope, removal.turnId, 20000);
		const removalEvents = await ws.readEvents(scope, {
			conversationId: removal.conversationId,
			after: 0,
		});
		const held = removalEvents.find(
			(event) => event.type === "approval.requested",
		);
		if (held?.type !== "approval.requested")
			throw new Error("Removing a block did not ask");
		expect(held.title).toBe("Editing document blocks");
		expect(held.automatic).toBeUndefined();
		expect(
			removalEvents.filter(
				(event) =>
					event.type === "approval.decided" ||
					event.type === "approval.executed",
			),
		).toHaveLength(0);
		expect(await current()).toBe(saved);
		await ws.scriptModel(scope, [{ text: "Kept" }]);
		const denied = await ws.decideApproval(scope, {
			approvalId: held.approvalId,
			decision: "deny",
			by: "u1",
		});
		expect(denied.applied).toBe(false);
		await ws.awaitTurn(scope, denied.turnId!, 20000);
		expect(await current()).toBe(saved);
	});

	test("an edit that removes content holds for approval; approving runs it with a receipt and the turn continues", async () => {
		await seedCore();
		// Its own workspace: other tests revise the shared one's files.
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		const ws = workspace(own);
		await seedOutputs(ws, own);
		const current = async () =>
			(await ws.outputQuery(own, { op: "get", outputId: "out-doc" }))
				?.currentRevisionId;
		const REMOVE = `export default async (env) => { const doc = await env.documents.read({ outputId: "out-doc" }); return env.documents.edit({ outputId: doc.id, expectedRevision: doc.revision, ops: [{ op: "delete", index: 0 }] }); }`;
		await ws.scriptModel(own, [{ code: REMOVE }, { text: "unreachable" }]);
		const { turnId, conversationId } = await ws.sendTurn(own, {
			actorId: "u1",
			actorKind: "user",
			text: "Remove the heading",
		});
		const outcome = await ws.awaitTurn(own, turnId, 20_000);
		expect(outcome.status).toBe("finished");
		const events = await ws.readEvents(own, { conversationId, after: 0 });
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		expect(requested?.type).toBe("approval.requested");
		if (requested?.type !== "approval.requested")
			throw new Error("no approval");
		expect(requested.title).toBe("Editing document blocks");
		expect(requested.automatic).toBeUndefined();
		expect(requested.target).toEqual({ id: "out-doc", title: "Priorities" });
		const held = (await ws.readChangeRecords(own, { resource: "output" })).find(
			(record) => record.operation === "edit",
		);
		expect(held?.outcome).toBe("needs_approval");
		expect(held?.id).toBe(requested.approvalId);
		expect(
			events.some(
				(event) =>
					event.type === "approval.decided" ||
					event.type === "approval.executed",
			),
		).toBe(false);
		expect(await current()).toBe("rev-doc");
		// The activity feed says what kind of change waits and nothing about
		// the file: that line is what a push to the people who decide repeats.
		await ws.retryProjections(own);
		const waiting = (
			await testEnv.DB.prepare(
				"SELECT summary FROM workspace_feed_ledger WHERE workspace_id = ? AND entity_id = ? AND change_record_id LIKE 'workspace-event:%' ORDER BY seq",
			)
				.bind(own.workspaceId, turnId)
				.all<{ summary: string }>()
		).results
			.map((row) => JSON.parse(row.summary))
			.filter((summary) => summary.action.operation === "approval.requested");
		expect(waiting.map((summary) => summary.description)).toEqual([
			"Editing document blocks",
		]);
		expect(JSON.stringify(waiting)).not.toContain("Priorities");

		// The approver's decision applies the held call and the model finishes the answer.
		await ws.scriptModel(own, [{ text: "Done: the heading was removed." }]);
		const decided = await ws.decideApproval(own, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decided.applied).toBe(true);
		await ws.awaitTurn(own, decided.turnId!, 20_000);
		const after = await ws.readEvents(own, {
			conversationId,
			after: requested.seq,
		});
		const decision = after.find((event) => event.type === "approval.decided");
		expect(decision).toMatchObject({
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decision).not.toHaveProperty("automatic");
		expect(
			after.find((event) => event.type === "approval.executed"),
		).toMatchObject({
			approvalId: requested.approvalId,
			status: "applied",
			output: { outputId: "out-doc", revision: 2 },
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
		).toContain("documents.edit applied:");
		const applied = (
			await ws.readChangeRecords(own, { resource: "output" })
		).filter((record) => record.operation === "edit");
		expect(applied.map((record) => record.outcome)).toEqual([
			"needs_approval",
			"applied",
		]);
		expect(await current()).not.toBe("rev-doc");
		expect((await ws.readTurn(own, decided.turnId!))?.text).toBe(
			"Done: the heading was removed.",
		);
		expect(
			await ws.decideApproval(own, {
				approvalId: requested.approvalId,
				decision: "approve",
				by: "u1",
			}),
		).toEqual({ ...decided, alreadyDecided: true });
		expect(
			await ws.readEvents(own, { conversationId, after: requested.seq }),
		).toEqual(after);
	});

	test("approving a reply's held removals together applies each and continues once", async () => {
		const ws = workspace();
		// Three new files apply at once; removing a block from each waits.
		const CREATE_THEN_TRIM = `export default async (env) => {
			const docs = [];
			for (const title of ["Budget", "Forecast", "Plan"])
				docs.push(await env.outputs.create({ title, content: { kind: "document", blocks: [{ type: "paragraph", text: "Keep" }, { type: "paragraph", text: "Remove" }] } }));
			return Promise.allSettled(docs.map((doc) => env.documents.edit({ outputId: doc.id, expectedRevision: doc.revision, ops: [{ op: "delete", index: 1 }] })));
		}`;
		await ws.scriptModel(scope, [
			{ code: CREATE_THEN_TRIM },
			{ text: "Waiting." },
		]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Create three documents and trim each",
		});
		await ws.awaitTurn(scope, turnId, 20_000);
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const created = events.flatMap((event) =>
			event.type === "approval.executed" && event.output ? [event.output] : [],
		);
		expect(created.map((output) => output.revision)).toEqual([1, 1, 1]);
		const requested = events.flatMap((event) =>
			event.type === "approval.requested" && !event.automatic ? [event] : [],
		);
		expect(requested).toHaveLength(3);
		expect(requested.map((event) => event.target?.id)).toEqual(
			created.map((output) => output.outputId),
		);
		const last = events.at(-1)!.seq;

		await ws.scriptModel(scope, [{ text: "All three are trimmed." }]);
		const ids = requested.map((event) => event.approvalId);
		const results = await ws.decideApprovals(scope, {
			approvalIds: ids,
			decision: "approve",
			by: "u1",
		});
		expect(results.map((result) => result.applied)).toEqual([true, true, true]);
		const continued = new Set(results.map((result) => result.turnId));
		expect(continued.size).toBe(1);
		const [next] = [...continued];
		await ws.awaitTurn(scope, next!, 20_000);
		const after = await ws.readEvents(scope, { conversationId, after: last });
		const executed = after.flatMap((event) =>
			event.type === "approval.executed" ? [event] : [],
		);
		expect(executed.map((event) => event.approvalId)).toEqual(ids);
		for (const [index, event] of executed.entries()) {
			expect(event.status).toBe("applied");
			expect(event.output).toEqual({
				outputId: created[index]!.outputId,
				revision: 2,
			});
		}
		const started = after.filter((event) => event.type === "turn.started");
		expect(started).toHaveLength(1);
		expect(started[0]?.type === "turn.started" && started[0].displayText).toBe(
			"Approved 3 requested actions.",
		);
		// Deciding again changes nothing: each is reported as already decided,
		// with what the first decision did, and no new answer starts.
		expect(
			await ws.decideApprovals(scope, {
				approvalIds: ids,
				decision: "approve",
				by: "u1",
			}),
		).toEqual(results.map((result) => ({ ...result, alreadyDecided: true })));
		expect(
			(await ws.readEvents(scope, { conversationId, after: last })).filter(
				(event) => event.type === "turn.started",
			),
		).toHaveLength(1);
	});

	test("two people approving the same requests at once apply each change once", async () => {
		const ws = workspace();
		const CREATE_THEN_TRIM = `export default async (env) => {
			const docs = [];
			for (const title of ["Budget", "Forecast", "Plan"])
				docs.push(await env.outputs.create({ title, content: { kind: "document", blocks: [{ type: "paragraph", text: "Keep" }, { type: "paragraph", text: "Remove" }] } }));
			return Promise.allSettled(docs.map((doc) => env.documents.edit({ outputId: doc.id, expectedRevision: doc.revision, ops: [{ op: "delete", index: 1 }] })));
		}`;
		await ws.scriptModel(scope, [
			{ code: CREATE_THEN_TRIM },
			{ text: "Waiting." },
		]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Create three documents and trim each",
		});
		await ws.awaitTurn(scope, turnId, 20_000);
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const ids = events.flatMap((event) =>
			event.type === "approval.requested" && !event.automatic
				? [event.approvalId]
				: [],
		);
		expect(ids).toHaveLength(3);
		const last = events.at(-1)!.seq;

		await ws.scriptModel(scope, [{ text: "All three are trimmed." }]);
		// The second person's batch overlaps the first and arrives while the
		// first is still applying its changes.
		const [first, second] = await Promise.all([
			ws.decideApprovals(scope, {
				approvalIds: ids,
				decision: "approve",
				by: "u1",
			}),
			ws.decideApprovals(scope, {
				approvalIds: [ids[1]!, ids[2]!, ids[0]!],
				decision: "approve",
				by: "u2",
			}),
		]);
		const turnIds = new Set(
			[...first, ...second].flatMap((result) =>
				result.turnId ? [result.turnId] : [],
			),
		);
		for (const id of turnIds) await ws.awaitTurn(scope, id, 20_000);
		const after = await ws.readEvents(scope, { conversationId, after: last });
		const executed = after.flatMap((event) =>
			event.type === "approval.executed" ? [event] : [],
		);
		expect(executed.map((event) => event.approvalId).sort()).toEqual(
			[...ids].sort(),
		);
		expect(executed.map((event) => event.status)).toEqual([
			"applied",
			"applied",
			"applied",
		]);
		expect(executed.map((event) => event.output?.revision)).toEqual([2, 2, 2]);
		expect(
			after.filter((event) => event.type === "approval.decided"),
		).toHaveLength(3);
		// Every change is reported applied to both people; each was decided
		// by exactly one of them.
		expect([...first, ...second].map((result) => result.applied)).toEqual(
			Array.from({ length: 6 }, () => true),
		);
		for (const [index, result] of first.entries()) {
			const other = second[(index + 2) % 3]!;
			expect([result.alreadyDecided, other.alreadyDecided].sort()).toEqual([
				true,
				undefined,
			]);
		}
		// A denial sent after the approval landed is refused and changes nothing.
		expect(
			await ws.decideApproval(scope, {
				approvalId: ids[0]!,
				decision: "deny",
				by: "u2",
			}),
		).toMatchObject({ applied: true, alreadyDecided: true });
		expect(
			(await ws.readEvents(scope, { conversationId, after: last })).filter(
				(event) => event.type === "approval.decided",
			),
		).toHaveLength(3);
	});

	test("a chat sees and decides a request another conversation raised", async () => {
		await seedCore();
		const ws = workspace();
		const TRIM = (title: string) => `export default async (env) => {
			const doc = await env.outputs.create({ title: "${title}", content: { kind: "document", blocks: [{ type: "paragraph", text: "Keep" }, { type: "paragraph", text: "Remove" }] } });
			return Promise.allSettled([env.documents.edit({ outputId: doc.id, expectedRevision: doc.revision, ops: [{ op: "delete", index: 1 }] })]);
		}`;
		const ask = async (title: string) => {
			await ws.scriptModel(scope, [
				{ code: TRIM(title) },
				{ text: "Waiting." },
			]);
			const started = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: `Create ${title} and trim it`,
			});
			await ws.awaitTurn(scope, started.turnId, 20_000);
			const requested = (
				await ws.readEvents(scope, {
					conversationId: started.conversationId,
					after: 0,
				})
			).find(
				(event) => event.type === "approval.requested" && !event.automatic,
			);
			if (requested?.type !== "approval.requested")
				throw new Error("The removal did not wait");
			return { conversationId: started.conversationId, requested };
		};
		const here = await ask("Roadmap");

		// A chat that follows the first conversation.
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
		const frames: Record<string, unknown>[] = [];
		socket.addEventListener("message", (event) => {
			frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
		});
		socket.accept();
		const got = (frame: Record<string, unknown>) =>
			vi.waitFor(
				() => expect(frames).toContainEqual(expect.objectContaining(frame)),
				{ timeout: 20_000 },
			);
		try {
			socket.send(
				JSON.stringify({
					type: "subscribe",
					conversationId: here.conversationId,
					cursor: null,
				}),
			);
			await got({ type: "caught_up" });
			const waitingNow = () =>
				(
					frames.findLast((frame) => frame.type === "hello") as {
						waiting: Array<{ approvalId: string; conversationId: string }>;
					}
				).waiting.filter((item) =>
					[here.conversationId, elsewhere?.conversationId].includes(
						item.conversationId,
					),
				);
			let elsewhere: Awaited<ReturnType<typeof ask>> | undefined;
			expect(waitingNow()).toMatchObject([
				{
					approvalId: here.requested.approvalId,
					requester: { id: "u1", kind: "person" },
					conversationId: here.conversationId,
					title: here.requested.title,
					target: here.requested.target,
					at: here.requested.at,
				},
			]);

			// Another conversation raises a request; the open chat is told.
			elsewhere = await ask("Launch notes");
			expect(elsewhere.conversationId).not.toBe(here.conversationId);
			await got({
				type: "approval.requested",
				approvalId: elsewhere.requested.approvalId,
				conversationId: elsewhere.conversationId,
				requester: { id: "u1", kind: "person" },
			});
			// Nothing else of the other conversation reaches this chat.
			expect(
				frames.filter(
					(frame) =>
						frame.conversationId === elsewhere!.conversationId &&
						!String(frame.type).startsWith("approval."),
				),
			).toEqual([]);

			// The open chat approves both, the other conversation's first.
			await ws.scriptModel(scope, [
				{ text: "Launch notes are trimmed." },
				{ text: "Roadmap is trimmed." },
			]);
			socket.send(
				JSON.stringify({
					type: "decide_approvals",
					runId: "run-1",
					approvalIds: [
						elsewhere.requested.approvalId,
						here.requested.approvalId,
					],
					decision: "approve",
				}),
			);
			await got({
				type: "approvals.decided",
				runId: "run-1",
				decision: "approve",
				total: 2,
				done: 2,
				alreadyDecided: 0,
			});
			await got({
				type: "approval.decided",
				approvalId: elsewhere.requested.approvalId,
				decision: "approve",
			});
			for (const asked of [elsewhere, here]) {
				const after = await ws.readEvents(scope, {
					conversationId: asked.conversationId,
					after: asked.requested.seq,
				});
				expect(
					after.find((event) => event.type === "approval.executed"),
				).toMatchObject({
					approvalId: asked.requested.approvalId,
					status: "applied",
				});
				// Each conversation continues with its own answer.
				const continued = after.filter(
					(event) => event.type === "turn.started",
				);
				expect(continued).toHaveLength(1);
				expect(
					continued[0]?.type === "turn.started" && continued[0].displayText,
				).toBe("Approved the requested action.");
				if (continued[0]?.type === "turn.started")
					await ws.awaitTurn(scope, continued[0].turnId, 20_000);
			}
			// A chat that connects now is owed nothing from either conversation.
			frames.length = 0;
			socket.send(
				JSON.stringify({
					type: "subscribe",
					conversationId: here.conversationId,
					cursor: null,
				}),
			);
			await got({ type: "caught_up" });
			expect(waitingNow()).toEqual([]);

			// Deciding one of them again is answered as already decided.
			socket.send(
				JSON.stringify({
					type: "decide_approval",
					runId: "run-2",
					approvalId: elsewhere.requested.approvalId,
					decision: "deny",
				}),
			);
			await got({
				type: "approvals.decided",
				runId: "run-2",
				decision: "deny",
				total: 1,
				done: 0,
				alreadyDecided: 1,
				stopped: {
					approvalId: elsewhere.requested.approvalId,
					reason: "decided_otherwise",
				},
			});
		} finally {
			socket.close(1000, "test complete");
		}
	});

	test("approving several stops at the first change that fails and leaves the rest waiting", async () => {
		const ws = workspace();
		// Two removals from one document both expect its first revision, so the
		// second cannot apply after the first; a third document waits behind.
		const PROPOSE = `export default async (env) => {
			const blocks = ["Keep", "Remove", "Also remove"].map((text) => ({ type: "paragraph", text }));
			const a = await env.outputs.create({ title: "Stops A", content: { kind: "document", blocks } });
			const b = await env.outputs.create({ title: "Stops B", content: { kind: "document", blocks } });
			return Promise.allSettled([
				env.documents.edit({ outputId: a.id, expectedRevision: a.revision, ops: [{ op: "delete", index: 2 }] }),
				env.documents.edit({ outputId: a.id, expectedRevision: a.revision, ops: [{ op: "delete", index: 1 }] }),
				env.documents.edit({ outputId: b.id, expectedRevision: b.revision, ops: [{ op: "delete", index: 1 }] }),
			]);
		}`;
		await ws.scriptModel(scope, [{ code: PROPOSE }, { text: "Waiting." }]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Create two documents and trim them",
		});
		await ws.awaitTurn(scope, turnId, 20_000);
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const ids = events.flatMap((event) =>
			event.type === "approval.requested" && !event.automatic
				? [event.approvalId]
				: [],
		);
		expect(ids).toHaveLength(3);
		const last = events.at(-1)!.seq;

		await ws.scriptModel(scope, [{ text: "One was trimmed." }]);
		const results = await ws.decideApprovals(scope, {
			approvalIds: ids,
			decision: "approve",
			by: "u1",
		});
		expect(results).toMatchObject([
			{ applied: true },
			{ applied: false, stopped: { reason: "failed" } },
			{ applied: false, left: true },
		]);
		expect(results[1]?.stopped?.error).toBeTruthy();
		expect(results[0]?.turnId).toBeTruthy();
		await ws.awaitTurn(scope, results[0]!.turnId!, 20_000);
		const after = await ws.readEvents(scope, { conversationId, after: last });
		expect(
			after.flatMap((event) =>
				event.type === "approval.executed"
					? [[event.approvalId, event.status]]
					: [],
			),
		).toEqual([
			[ids[0], "applied"],
			[ids[1], "failed"],
		]);
		// The third was never decided: it can still be approved on its own.
		expect(
			after.filter((event) => event.type === "approval.decided"),
		).toHaveLength(2);
		await ws.scriptModel(scope, [{ text: "The other is trimmed too." }]);
		const third = await ws.decideApproval(scope, {
			approvalId: ids[2]!,
			decision: "approve",
			by: "u1",
		});
		expect(third).toMatchObject({ applied: true });
		expect(third.alreadyDecided).toBeUndefined();
		await ws.awaitTurn(scope, third.turnId!, 20_000);
	});

	test("a view shown from sandbox code lands in the answer's events", async () => {
		await seedCore();
		const ws = workspace();
		const SHOW = `export default async (env) => {
			for (const n of [1, 2, 3, 4]) {
				try { await env.views.show({ title: "Open work " + n, data: [{ title: "A", disposition: "accepted" }] }); }
				catch (error) { return error.message; }
			}
		}`;
		await ws.scriptModel(scope, [{ code: SHOW }, { text: "Here it is." }]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Show open work as a table",
		});
		const turn = await ws.awaitTurn(scope, turnId, 20_000);
		expect(turn).toMatchObject({ status: "finished", text: "Here it is." });
		const views = (await ws.readEvents(scope, { conversationId })).filter(
			(event) => event.type === "view.shown",
		);
		expect(views).toHaveLength(3);
		expect(views[0]).toMatchObject({
			turnId,
			appSlug: "tedix-unified",
			resourceUri: "ui://widgets/mcp-app/tedix-unified/r/open-work-1.html",
			toolResult: { rows: [{ title: "A", disposition: "accepted" }] },
		});
	});

	test("asking for a missing account puts one Connect event in the conversation and changes nothing", async () => {
		await seedCore();
		const sources: WorkspaceScope = {
			organizationId: "org_test",
			workspaceId: crypto.randomUUID(),
		};
		await seedWorkspaceRows([sources]);
		await testEnv.DB.batch([
			testEnv.DB.prepare(ddl(connectionInstances)),
			testEnv.DB.prepare(ddl(connectionProviders)),
		]);
		const now = "2026-11-18T10:00:00.000Z";
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				"INSERT OR REPLACE INTO connection_providers (id, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES ('drive', 'Example Drive', '', '', 'storage', 'oauth', 'user', '[]', '[]')",
			),
			// A colleague's account and the organization's; u1 has none.
			testEnv.DB.prepare(
				`INSERT OR REPLACE INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, token_ids, token_sub, created_at, updated_at) VALUES ('colleague-drive', 'u2', NULL, 'drive', 'Drive', '["grant"]', 'subject', ?1, ?1), ('org-mail', 'u2', ?2, 'mail', 'Mail', '["grant"]', 'subject', ?1, ?1)`,
			).bind(now, sources.organizationId),
			...(
				[
					["personal", "drive", "user", "u2", "colleague-drive"],
					["shared", "mail", "tenant", null, "org-mail"],
					["file", "tedix", "tenant", null, null],
				] as const
			).map(([id, providerId, connectionScope, owner, account]) =>
				testEnv.DB.prepare(
					"INSERT INTO os_workspace_resources (id, organization_id, workspace_id, provider_id, connection_scope, personal_owner_user_id, connection_instance_id, required_scopes, resource_type, provider_resource_id, name, metadata, status, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', 'folder', ?, ?, '{}', 'active', 'user', 'u2', ?, ?)",
				).bind(
					`${sources.workspaceId}-${id}`,
					sources.organizationId,
					sources.workspaceId,
					providerId,
					connectionScope,
					owner,
					account,
					id,
					`Team ${id}`,
					now,
					now,
				),
			),
		]);
		const ws = workspace(sources);
		await markMovedOwner(ws);
		const id = (name: string) => `${sources.workspaceId}-${name}`;
		// The object takes the workspace's earlier sources on its first source read.
		await ws.outputQuery(sources, {
			op: "resources",
			query: {
				operation: "get",
				params: { ...sources, resourceId: id("file") },
			},
		});
		const ASK = `export default async (env) => {
			const listed = await env.resources.list();
			const ask = (resourceId, reason) => env.resources.requestConnection({ resourceId, reason });
			return {
				listed: listed.map((row) => [row.name, row.connectionScope, row.connectedForYou]),
				personal: await ask(${JSON.stringify(id("personal"))}, "  To read the planning folder.  "),
				again: await ask(${JSON.stringify(id("personal"))}),
				shared: await ask(${JSON.stringify(id("shared"))}),
				file: await ask(${JSON.stringify(id("file"))}),
				unknown: await ask("missing").catch((error) => error.message),
			};
		}`;
		await ws.scriptModel(sources, [{ code: ASK }, { text: "Connect it." }]);
		const { turnId, conversationId } = await ws.sendTurn(sources, {
			actorId: "u1",
			actorKind: "user",
			text: "What is in the planning folder?",
		});
		expect(await ws.awaitTurn(sources, turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "Connect it.",
		});
		const events = await ws.readEvents(sources, { conversationId });
		// The code step's result is text: a label, then what the code returned.
		const returned =
			events.flatMap((event) =>
				event.type === "step.finished" && event.result?.includes('"listed"')
					? [event.result]
					: [],
			)[0] ?? "";
		const result = JSON.parse(
			returned.slice(returned.indexOf("{"), returned.lastIndexOf("}") + 1),
		) as Record<string, { requested?: boolean; message?: string }>;
		expect(result).toMatchObject({
			listed: [
				["Team file", "organization", null],
				["Team personal", "personal", false],
				["Team shared", "organization", true],
			],
			personal: { requested: true },
			again: { requested: true },
			shared: { requested: false },
			file: { requested: false },
			unknown: expect.stringContaining("No connected source has that id"),
		});
		const asked = events.filter(
			(event) => event.type === "connection.requested",
		);
		// The repeat reuses the request id, so the chat shows one card.
		expect(new Set(asked.map((event) => event.requestId)).size).toBe(1);
		expect(asked[0]).toMatchObject({
			turnId,
			requestId: `${turnId}:${id("personal")}`,
			resourceId: id("personal"),
			resourceName: "Team personal",
			providerId: "drive",
			service: "Example Drive",
			connectionScope: "personal",
			reason: "To read the planning folder.",
		});
		expect(JSON.stringify(asked)).not.toContain("u2");
		// A read: nothing waited for a person and no approval was recorded.
		expect(
			events.filter((event) => event.type.startsWith("approval.")),
		).toEqual([]);
	});

	test("linked account reads use the person who started the turn and replay a held read through the tray", async () => {
		await seedCore();
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		await testEnv.DB.batch([
			...[connectionInstances, connectionProviders, apps, appTools].map(
				(table) => testEnv.DB.prepare(ddl(table)),
			),
			testEnv.DB.prepare(
				"CREATE TABLE IF NOT EXISTS app_tool_csp_domains (id TEXT PRIMARY KEY, app_tool_id TEXT, domain_type TEXT, domain_url TEXT, active INTEGER, created_at TEXT)",
			),
		]);
		const now = "2026-11-19T10:00:00.000Z";
		const db = createDbQueryClient(testEnv.DB);
		const resource = {
			...own,
			id: crypto.randomUUID(),
			name: "Planning folder",
			providerId: "fixture-storage",
			connectionScope: "user" as const,
			personalOwnerUserId: "u1",
			resourceType: "folder",
			providerResourceId: "provider-folder-42",
			createdByKind: "user" as const,
			createdById: "u1",
			createdAt: now,
			updatedAt: now,
		};
		const accountId = crypto.randomUUID();
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				"INSERT INTO connection_providers (id, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES (?, 'Fixture Storage', '', '', 'storage', 'oauth', 'user', '[]', '[]')",
			).bind(resource.providerId),
			testEnv.DB.prepare(
				"INSERT INTO connection_instances (id, owner_user_id, provider_id, label, token_ids, token_sub, created_at, updated_at) VALUES (?, 'u1', ?, 'Storage', '[\"grant\"]', 'subject', ?, ?)",
			).bind(accountId, resource.providerId, now, now),
		]);
		await db.insert(osWorkspaceResources).values([
			{ ...resource, connectionInstanceId: accountId },
			{
				...resource,
				id: "missing-account",
				name: "Other folder",
				connectionInstanceId: "missing",
				providerResourceId: "other",
			},
			{
				...resource,
				id: "internal-file",
				name: "Internal file",
				providerId: "tedix",
				providerResourceId: "file",
			},
		]);
		const appId = crypto.randomUUID();
		await db.insert(apps).values({
			id: appId,
			organizationId: own.organizationId,
			slug: "fixture-reader",
			name: "Fixture reader",
			metadata: {
				mcpConfig: {
					connectionProviderId: resource.providerId,
					connectionInstanceId: accountId,
					connectionScope: "user",
				},
			},
		});
		const tool = {
			appId,
			toolTypeId: "rpc",
			title: "Read folder",
			enabled: true,
			inputSchema: {
				type: "object" as const,
				properties: { folderKey: { type: "string" as const } },
				required: ["folderKey"],
			},
			config: {
				transport: "external",
				connectionReadOnly: true,
				auth: { type: "connection", connectionId: resource.providerId },
				personalResourceBinding: {
					operation: "read",
					resourceType: "folder",
					paths: [["folderKey"]],
				},
			},
		};
		await db.insert(appTools).values([
			{
				...tool,
				id: "fixture-read",
				toolId: "read_folder",
				annotations: { readOnlyHint: true },
			},
			{
				...tool,
				id: "fixture-write",
				toolId: "write_folder",
				annotations: { readOnlyHint: false },
			},
		]);
		const ws = workspace(own);
		const approvalId = crypto.randomUUID();
		const denyId = crypto.randomUUID();
		await markMovedOwner(ws);
		await ws.outputQuery(own, {
			op: "resources",
			query: { operation: "get", params: { ...own, resourceId: resource.id } },
		});
		await ws.scriptAccountReads(own, [
			{ status: "ok", result: { count: 42 } },
			{
				status: "not_connected",
				providerId: resource.providerId,
				scope: "user",
				connectPath: "/account/connections",
			},
			{ status: "refused", message: "Access to this folder was refused." },
			{ status: "approval_required", approvalId },
			{ status: "approval_required", approvalId },
			{ status: "approval_required", approvalId: denyId },
			{ status: "ok", result: { count: 43 } },
		]);
		await ws.scriptModel(own, [
			{
				code: `export default async ({accounts}) => {
				const list = await accounts.list();
				const description = await accounts.describe(list[0].resourceId);
				const read = (id, args) => accounts.read(id, description.tools[0].name, args, "sandbox-cannot-supply-an-approval");
				const args = { folderKey: description.providerResourceId };
				return {
					list, description,
					ok: await read(list[0].resourceId, args),
					connect: await read("missing-account", args).catch(e => e.message),
					refused: await read(list[0].resourceId, args).catch(e => e.message),
					held: await read(list[0].resourceId, args).catch(e => e.message),
					repeated: await read(list[0].resourceId, args).catch(e => e.message),
					denied: await read(list[0].resourceId, { ...args, limit: 2 }).catch(e => e.message)
				};
			}`,
			},
			{ text: "The rest of the turn still runs." },
		]);
		const { turnId, conversationId } = await ws.sendTurn(own, {
			actorKind: "user",
			actorId: "u1",
			tediId: "tedi1",
			text: "Read my planning folder.",
		});
		expect(await ws.awaitTurn(own, turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "The rest of the turn still runs.",
		});
		const events = await ws.readEvents(own, { conversationId });
		const result = events.find(
			(event) =>
				event.type === "step.finished" &&
				event.result?.includes('"description"'),
		);
		expect(result).toMatchObject({
			result: expect.stringContaining('"count": 42'),
		});
		expect(result).toMatchObject({
			result: expect.stringContaining('"folderKey"'),
		});
		expect(result).toMatchObject({
			result: expect.stringContaining("Access to this folder was refused."),
		});
		expect(JSON.stringify(result)).not.toContain("write_folder");
		expect(
			events.filter((event) => event.type === "connection.requested"),
		).toEqual([
			expect.objectContaining({
				resourceId: "missing-account",
				service: "Fixture Storage",
				connectionScope: "personal",
			}),
		]);
		expect(
			events
				.filter((event) => event.type === "approval.requested")
				.map((event) => event.approvalId),
		).toEqual([approvalId, denyId]);
		const prompt = (await ws.readSystemPrompts(own))[0]!;
		expect(prompt).toContain('"Planning folder" ("Fixture Storage")');
		expect(prompt).not.toContain("Other folder");
		expect(prompt).not.toContain("folderKey");
		expect(prompt).not.toContain("provider-folder-42");
		const initial = {
			...own,
			conversationId,
			actor: { kind: "user", id: "u1" },
			resourceId: resource.id,
			toolName: "read_folder",
			args: { folderKey: "provider-folder-42" },
		};
		expect((await ws.readAccountCalls(own))[0]).toEqual(initial);
		expect(
			await ws.decideApproval(own, {
				approvalId,
				by: "u1",
				decision: "approve",
			}),
		).toEqual({
			applied: false,
			stopped: { reason: "failed", error: "Only the approver can decide." },
		});
		await ws.scriptModel(own, [{ text: "Read continued." }]);
		const decided = await ws.decideApproval(own, {
			approvalId,
			by: "approver",
			decision: "approve",
		});
		expect(decided).toMatchObject({ applied: true });
		await ws.awaitTurn(own, decided.turnId!, 20_000);
		expect((await ws.readAccountCalls(own)).at(-1)).toEqual({
			...initial,
			approvalRequestId: approvalId,
		});
		expect((await ws.readModelCalls(own)).at(-1)?.join("\n")).toContain(
			'{"count":43}',
		);
		expect(
			await ws.decideApproval(own, {
				approvalId,
				by: "approver",
				decision: "approve",
			}),
		).toMatchObject({ alreadyDecided: true });
		await ws.scriptModel(own, [{ text: "Read denied." }]);
		const denied = await ws.decideApproval(own, {
			approvalId: denyId,
			by: "approver",
			decision: "deny",
		});
		expect(denied.applied).toBe(false);
		await ws.awaitTurn(own, denied.turnId!, 20_000);
		expect((await ws.readAccountCalls(own)).slice(-3)).toEqual([
			{
				...own,
				conversationId,
				approvalRequestId: approvalId,
				by: "approver",
				decision: "approve",
			},
			{ ...initial, approvalRequestId: approvalId },
			{
				...own,
				conversationId,
				approvalRequestId: denyId,
				by: "approver",
				decision: "deny",
			},
		]);
		const ledger = await ws.readChangeRecords(own, {
			resource: "connected_account",
		});
		expect(ledger).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operation: "read",
					actor: expect.objectContaining({ id: "u1", kind: "user" }),
				}),
			]),
		);
	});

	test.each(["tedi", "service"] as const)(
		"a %s-started turn cannot use connected accounts",
		async (actorKind) => {
			await seedCore();
			const own = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([own]);
			const ws = workspace(own);
			await ws.scriptModel(own, [
				{
					code: `export default async ({accounts}) => await Promise.all([
				accounts.list(), accounts.describe("any"), accounts.read("any", "read", {})
			].map(call => call.catch(e => e.message)))`,
				},
				{ text: "Connected accounts are unavailable in this turn." },
			]);
			const { turnId, conversationId } = await ws.sendTurn(own, {
				actorKind,
				actorId: actorKind === "tedi" ? "tedi1" : "schedule",
				text: "Read a linked account.",
			});
			expect(await ws.awaitTurn(own, turnId, 20_000)).toMatchObject({
				status: "finished",
			});
			const events = await ws.readEvents(own, { conversationId });
			const message =
				"Connected accounts are not available to tedi-started or scheduled turns yet.";
			expect(
				events.filter(
					(event) => event.type === "step.finished" && event.error === message,
				),
			).toHaveLength(3);
			expect((await ws.readSystemPrompts(own))[0]).toContain(message);
			expect(await ws.readAccountCalls(own)).toEqual([]);
		},
	);

	test("a person's turn reads a file on a machine, as the tedi they addressed", async () => {
		await seedCore();
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		const ws = workspace(own);
		const callId = crypto.randomUUID();
		await ws.scriptMachine(own, [
			{ status: "queued", callId, callStatus: "pending" },
			{
				status: "call",
				call: {
					callId,
					machine: "Studio",
					tool: "read_file",
					status: "done",
					result: "# Example",
					createdAt: "2026-11-20T10:00:00.000Z",
				},
			},
		]);
		await ws.scriptModel(own, [
			{
				code: `export default async ({machine}) => machine.call({ machine: "Studio", tool: "read_file", input: { path: "README.md" } })`,
			},
			{ text: "Read it." },
		]);
		const { turnId, conversationId } = await ws.sendTurn(own, {
			actorKind: "user",
			actorId: "u1",
			tediId: "tedi1",
			text: "Read the README on Studio.",
		});
		expect(await ws.awaitTurn(own, turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "Read it.",
		});
		const events = await ws.readEvents(own, { conversationId });
		expect(
			events.find(
				(event) => event.type === "step.finished" && event.tool === undefined,
			),
		).toMatchObject({ result: expect.stringContaining("# Example") });
		expect(await ws.readMachineCalls(own)).toEqual([
			{
				...own,
				userId: "u1",
				tediId: "tedi1",
				op: "call",
				call: {
					machine: "Studio",
					tool: "read_file",
					input: { path: "README.md" },
				},
			},
			{ ...own, userId: "u1", tediId: "tedi1", op: "read", callId },
		]);
	});

	test("reading a web page asks once per domain and returns the page as text", async () => {
		const ws = workspace();
		const READ = `export default async (env) => {
			const page = await env.web.fetch("https://example.com/prices");
			return { title: page.title, text: page.text };
		}`;
		await ws.scriptModel(scope, [{ code: READ }, { text: "unreachable" }]);
		const { turnId, conversationId } = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "What does the team plan cost on example.com/prices?",
		});
		expect(await ws.awaitTurn(scope, turnId, 20_000)).toMatchObject({
			status: "finished",
		});
		const events = await ws.readEvents(scope, { conversationId, after: 0 });
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("no approval card");
		expect(requested.title).toBe("Read example.com");
		expect(requested.input).toBe("https://example.com/prices");
		expect(await ws.webFetchCount(scope)).toBe(0);

		await ws.scriptModel(scope, [{ text: "The team plan costs 12 euros." }]);
		const decided = await ws.decideApproval(scope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decided.applied).toBe(true);
		await ws.awaitTurn(scope, decided.turnId!, 20_000);
		const continuation = (
			await ws.readEvents(scope, { conversationId, after: requested.seq })
		).find(
			(event) =>
				event.type === "turn.started" && event.turnId === decided.turnId,
		);
		expect(
			continuation?.type === "turn.started" && continuation.text,
		).toContain("Team plan costs 12 euros a month.");
		expect(await ws.webFetchCount(scope)).toBe(1);

		// The same domain later in the conversation needs no new approval.
		await ws.scriptModel(scope, [
			{ code: READ },
			{ text: "Still 12 euros a month." },
		]);
		const again = await ws.sendTurn(scope, {
			conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Check it again",
		});
		expect(await ws.awaitTurn(scope, again.turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "Still 12 euros a month.",
		});
		const later = await ws.readEvents(scope, {
			conversationId,
			after: requested.seq,
		});
		expect(
			later.filter((event) => event.type === "approval.requested"),
		).toHaveLength(0);
		expect(await ws.webFetchCount(scope)).toBe(2);
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

	test("a builder starts and steers a run in the linked project, and the chat stores one result notice", async () => {
		await seedCore();
		await testEnv.DB.batch(
			[
				workAttempts,
				workAttemptSteps,
				workAttemptMessages,
				workItemComments,
			].map((table) => testEnv.DB.prepare(ddl(table))),
		);
		const ws = workspace();
		const start =
			'export default async (env) => env.work.startRun({ title: "Fix paging", brief: "Handle an empty page", doneWhen: "Paging tests pass", executor: "codex" })';
		await ws.scriptModel(scope, [{ code: start }, { text: "Run requested." }]);
		const sent = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Start the paging fix",
		});
		await ws.awaitTurn(scope, sent.turnId, 20_000);
		const { conversationId } = sent;
		const startStep = (await ws.readEvents(scope, { conversationId })).find(
			(event) =>
				event.type === "step.finished" && event.tool === "work.startRun",
		);
		expect(startStep).toMatchObject({ status: "ok" });
		const { workItemId } = JSON.parse(
			startStep?.type === "step.finished" ? (startStep.result ?? "{}") : "{}",
		);
		expect(
			await testEnv.DB.prepare(
				"SELECT project_id, work_class, accountable_owner_id, disposition, executor_id, dispatch_state, source_session_key FROM work_items WHERE id = ?",
			)
				.bind(workItemId)
				.first(),
		).toMatchObject({
			project_id: "proj1",
			work_class: "objective",
			accountable_owner_id: "u1",
			disposition: "accepted",
			executor_id: "codex",
			dispatch_state: "ready",
			source_session_key: ["workspace", scope.workspaceId, conversationId].join(
				":",
			),
		});

		// No runner has taken the task yet: the follow-up is saved for the
		// run, and the answer says it is delivered when the run starts.
		await ws.scriptModel(scope, [
			{
				code:
					"export default async (env) => env.work.sendRunMessage({workItemId: " +
					JSON.stringify(workItemId) +
					', message: "Also cover page zero"})',
			},
			{ text: "Saved." },
		]);
		const early = await ws.sendTurn(scope, {
			conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Also cover page zero",
		});
		await ws.awaitTurn(scope, early.turnId, 20_000);
		expect(
			(await ws.readEvents(scope, { conversationId })).find(
				(event) =>
					event.type === "step.finished" && event.turnId === early.turnId,
			),
		).toMatchObject({
			status: "ok",
			result: expect.stringContaining('"delivery":"when_run_starts"'),
		});
		expect(
			await testEnv.DB.prepare(
				"SELECT attempt_id, body, delivered_at FROM work_attempt_messages WHERE work_item_id = ?",
			)
				.bind(workItemId)
				.first(),
		).toEqual({
			attempt_id: "",
			body: "Also cover page zero",
			delivered_at: null,
		});

		const attemptId = crypto.randomUUID();
		const now = new Date().toISOString();
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				"INSERT INTO work_attempts (id, work_item_id, org_id, executor_type, executor_id, runtime_state, attempt_number, started_at, heartbeat_at, expires_at, metadata) VALUES (?, ?, ?, 'external_agent', 'codex', 'running', 1, ?, ?, ?, '{}')",
			).bind(
				attemptId,
				workItemId,
				scope.organizationId,
				now,
				now,
				new Date(Date.now() + 60_000).toISOString(),
			),
			testEnv.DB.prepare(
				"INSERT INTO work_attempt_steps (id, org_id, work_item_id, attempt_id, seq, at, kind, text) VALUES (?, ?, ?, ?, 1, ?, 'started', 'Reading the files')",
			).bind(
				crypto.randomUUID(),
				scope.organizationId,
				workItemId,
				attemptId,
				Date.now(),
			),
		]);
		await ws.scriptModel(scope, [
			{
				code:
					"export default async (env) => { const workItemId = " +
					JSON.stringify(workItemId) +
					'; await env.work.readRun({workItemId}); await env.work.sendRunMessage({workItemId, message: "Include empty pages"}); return env.work.stopRun({workItemId}) }',
			},
			{ text: "Sent." },
		]);
		const follow = await ws.sendTurn(scope, {
			conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Include empty pages, then stop",
		});
		await ws.awaitTurn(scope, follow.turnId, 20_000);
		const runSteps = (await ws.readEvents(scope, { conversationId })).filter(
			(event) =>
				event.type === "step.finished" && event.turnId === follow.turnId,
		);
		expect(runSteps).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					result: expect.stringContaining('"kind":"agent_run_steps"'),
				}),
				expect.objectContaining({
					result: expect.stringContaining('"kind":"agent_run_message"'),
				}),
				expect.objectContaining({
					result: expect.stringContaining('"kind":"agent_run_stop"'),
				}),
			]),
		);
		expect(
			(
				await testEnv.DB.prepare(
					"SELECT kind, body, sender_type, sender_id FROM work_attempt_messages WHERE attempt_id = ? ORDER BY rowid",
				)
					.bind(attemptId)
					.all()
			).results,
		).toEqual([
			{
				kind: "follow_up",
				body: "Include empty pages",
				sender_type: "user",
				sender_id: "u1",
			},
			{ kind: "stop", body: "", sender_type: "user", sender_id: "u1" },
		]);

		const content = 'The run for "Fix paging" ended: cancelled.';
		await ws.appendAgentRunNotice(scope, {
			conversationId,
			attemptId,
			content,
		});
		await ws.appendAgentRunNotice(scope, {
			conversationId,
			attemptId,
			content,
		});
		expect(
			(await ws.readLedger(scope, conversationId)).filter(
				(event) => event.type === "agent_run.ended",
			),
		).toEqual([expect.objectContaining({ text: content })]);

		await testEnv.DB.prepare(
			"INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status, kind) VALUES ('fixture-use-only', ?, 'use-only', 'viewer@example.test', 'viewer', 'active', 'human')",
		)
			.bind(scope.organizationId)
			.run();
		for (const [actorKind, actorId] of [
			["user", "use-only"],
			["tedi", "tedi1"],
			["service", "schedule"],
		] as const) {
			await ws.scriptModel(scope, [{ code: start }, { text: "Refused." }]);
			const denied = await ws.sendTurn(scope, {
				actorId,
				actorKind,
				text: "Start the paging fix",
			});
			await ws.awaitTurn(scope, denied.turnId, 20_000);
			expect(
				await ws.readEvents(scope, { conversationId: denied.conversationId }),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "step.finished",
						status: "error",
						error: expect.stringContaining(
							"A person with build access must request this in workspace chat",
						),
					}),
				]),
			);
		}
	});

	test("a person starts a read-only run from a private workspace in a project it does not link", async () => {
		await seedCore();
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		const projectId = crypto.randomUUID();
		const now = new Date().toISOString();
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				"UPDATE os_workspaces SET visibility = 'private', owner_user_id = 'u1' WHERE id = ?",
			).bind(own.workspaceId),
			testEnv.DB.prepare(
				"UPDATE organization_members SET role = 'owner' WHERE organization_id = ? AND descope_user_id = 'u1'",
			).bind(own.organizationId),
			testEnv.DB.prepare(
				"INSERT INTO projects (id, org_id, key, name, status, created_at, updated_at) VALUES (?, ?, ?, 'Unlinked', 'active', ?, ?)",
			).bind(
				projectId,
				own.organizationId,
				`U${projectId.slice(0, 6)}`,
				now,
				now,
			),
		]);
		const ws = workspace(own);
		const callId = crypto.randomUUID();
		await ws.scriptMachine(own, [
			{
				status: "machines",
				machines: [
					{
						machineName: "Studio",
						executors: ["codex"],
						lastSeenAt: now,
						cliVersion: null,
						machineTools: ["dispatch_work_item"],
						online: true,
					},
				],
			},
			{ status: "queued", callId, callStatus: "pending" },
			{
				status: "call",
				call: {
					callId,
					machine: "Studio",
					tool: "dispatch_work_item",
					status: "done",
					createdAt: now,
				},
			},
		]);
		await ws.scriptModel(own, [
			{
				code: `export default async (env) => ({ projects: await env.work.listProjects(), run: await env.work.startRun({ title: "Explain paging", brief: "Say how paging works", doneWhen: "A short answer", executor: "codex", changesCode: false, projectId: ${JSON.stringify(projectId)} }) })`,
			},
			{ text: "Run requested." },
		]);
		const sent = await ws.sendTurn(own, {
			actorId: "u1",
			actorKind: "user",
			text: "Explain paging in the unlinked project",
		});
		await ws.awaitTurn(own, sent.turnId, 20_000);
		const steps = (
			await ws.readEvents(own, { conversationId: sent.conversationId })
		).flatMap((event) => (event.type === "step.finished" ? [event] : []));
		expect(steps).toContainEqual(
			expect.objectContaining({
				result: expect.stringMatching(`"id":\\s*"${projectId}"`),
			}),
		);
		const run = JSON.parse(
			steps.find((step) => step.tool === "work.startRun")?.result ?? "{}",
		) as { workItemId: string };
		expect(
			await testEnv.DB.prepare(
				"SELECT project_id, work_kind, accountable_owner_id, disposition, dispatch_state, json_extract(metadata, '$.source') AS source FROM work_items WHERE id = ?",
			)
				.bind(run.workItemId)
				.first(),
		).toEqual({
			project_id: projectId,
			work_kind: "research",
			accountable_owner_id: "u1",
			disposition: "accepted",
			dispatch_state: "ready",
			source: "os.workspace.start_run",
		});
		expect((await ws.readMachineCalls(own))[1]).toMatchObject({
			userId: "u1",
			op: "call",
			call: {
				machine: "Studio",
				tool: "dispatch_work_item",
				input: { workItemId: run.workItemId, projectId, executor: "codex" },
			},
		});
		await testEnv.DB.prepare("DELETE FROM work_items WHERE id = ?")
			.bind(run.workItemId)
			.run();
	});

	test("a stale edit fails inside the turn, the model is told and nothing is left waiting", async () => {
		await seedCore();
		const ws = workspace() as Stub & {
			readSystemPrompts(scope: WorkspaceScope): Promise<string[]>;
		};
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
			{ text: "The edit failed because its revision was stale." },
		]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Try the stale edit",
		});
		expect(await ws.awaitTurn(scope, started.turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "The edit failed because its revision was stale.",
		});
		const events = await ws.readEvents(scope, {
			conversationId: started.conversationId,
		});
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("The edit was not recorded");
		expect(requested.automatic).toBe(true);
		expect(
			events
				.filter((event) => event.type.startsWith("approval."))
				.map((event) => event.type),
		).toEqual(["approval.requested", "approval.decided", "approval.executed"]);
		expect(
			events.find((event) => event.type === "approval.decided"),
		).toMatchObject({
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
			automatic: true,
		});
		expect(
			events.find((event) => event.type === "approval.executed"),
		).toMatchObject({
			approvalId: requested.approvalId,
			status: "failed",
			error: expect.stringContaining("revision_conflict"),
		});
		// The model sees a failed call, not a change waiting for someone.
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "step.finished",
				stepId: requested.stepId,
				status: "error",
				error: expect.stringContaining("revision_conflict"),
			}),
		);
		const results = JSON.stringify(
			(await ws.readMessages(scope, started.conversationId)).filter(
				(message) => message.role === "toolResult",
			),
		);
		expect(results).toContain("revision_conflict");
		expect(results).not.toContain("Approval required");
		expect(
			events.filter((event) => event.type === "turn.started"),
		).toHaveLength(1);
		// A decision by hand afterwards changes nothing and starts nothing.
		expect(
			await ws.decideApproval(scope, {
				approvalId: requested.approvalId,
				decision: "approve",
				by: "u1",
			}),
		).toEqual({ applied: false, alreadyDecided: true });
		expect(
			await ws.readEvents(scope, { conversationId: started.conversationId }),
		).toEqual(events);
		expect(
			(await ws.outputQuery(scope, { op: "get", outputId: "out-doc" }))
				?.currentRevisionId,
		).toBe(before?.currentRevisionId);
		// The next turn is not told that anything waits for a decision.
		await ws.scriptModel(scope, [{ text: "Nothing is waiting." }]);
		const next = await ws.sendTurn(scope, {
			conversationId: started.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Is anything waiting?",
		});
		await ws.awaitTurn(scope, next.turnId, 20_000);
		expect((await ws.readSystemPrompts(scope)).at(-1)).not.toContain(
			"<waiting_for_approval",
		);
	});

	test("each refused or failed call ends that call; the model reads why and the turn finishes", async () => {
		await seedCore();
		const ws = workspace();
		await seedOutputs(ws);
		// Where the files stand before anything fails.
		await ws.scriptModel(scope, [
			{
				code: `export default async (env) => [
					(await env.documents.read({ outputId: "out-doc" })).revision,
					(await env.sheets.read({ outputId: "out-sheet" })).revision,
					(await env.outputs.list()).length,
				]`,
			},
			{ text: "Read." },
		]);
		const read = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Read the files",
		});
		await ws.awaitTurn(scope, read.turnId, 20_000);
		const [revision, sheetRevision, files] = (
			JSON.stringify(await ws.readMessages(scope, read.conversationId)).match(
				/return value:\\n\[\\n (\d+),\\n (\d+),\\n (\d+)/,
			) ?? []
		)
			.slice(1)
			.map(Number);
		if (!revision || !sheetRevision || !files)
			throw new Error("The files could not be read");
		// "\\ud83d" reaches the sandbox as the escape \ud83d: half of an emoji.
		const failing: Array<{ code: string; reads: string[] }> = [
			{
				code: `export default async (env) => env.documents.replace({ outputId: "out-doc", expectedRevision: ${revision},
					content: { kind: "document", blocks: "not a list" } })`,
				reads: ["Invalid arguments: blocks: "],
			},
			{
				code: `export default async (env) => env.outputs.revise({ outputId: "out-doc", expectedRevision: 0,
					content: { kind: "document", blocks: [{ type: "paragraph", text: "stale" }] } })`,
				reads: ["revision_conflict"],
			},
			{
				code: `export default async (env) => env.documents.replace({ outputId: "out-doc", expectedRevision: ${revision},
					content: { kind: "document", blocks: [{ type: "paragraph", text: "Half \\ud83d" }] } })`,
				reads: [
					"Nothing was changed: content.blocks[0].text holds half of a character",
					"Send whole characters",
				],
			},
			{
				code: `export default async (env) => env.sheets.edit({ outputId: "out-sheet", expectedRevision: ${sheetRevision},
					startRow: 1, startColumn: 0, cells: [["\\ude00 cut"]] })`,
				reads: ["cells[0][0] holds half of a character"],
			},
			{
				code: `export default async (env) => env.outputs.create({ title: "Notes \\ud83d",
					content: { kind: "document", blocks: [{ type: "paragraph", text: "whole" }] } })`,
				reads: ["title holds half of a character"],
			},
			{
				// An edit that removes a block would wait on a card; this one cannot apply.
				code: `export default async (env) => env.documents.edit({ outputId: "out-doc", expectedRevision: ${revision},
					ops: [{ op: "delete", index: 1 }, { op: "replace", index: 0, block: { type: "heading", level: 1, text: "\\ud83d" } }] })`,
				reads: ["ops[1].block.text holds half of a character"],
			},
			{
				code: `export default async (env) => env.documents.read({ outputId: "no-such-file" })`,
				reads: ["Document not found or unavailable"],
			},
			{
				code: `export default async (env) => env.outputs.shred("out-doc")`,
				reads: ["shred"],
			},
			{
				code: `export default async () => { throw { code: "E_PLAN", hint: "pick another row" }; }`,
				reads: [
					'The code threw {\\"code\\":\\"E_PLAN\\",\\"hint\\":\\"pick another row\\"} instead of an Error',
				],
			},
			{
				code: `export default async () => { throw undefined; }`,
				reads: ["The code threw undefined instead of an Error"],
			},
			{
				code: `export default async () => { console.log("read 4 rows"); throw new RangeError("row 9 is past the end"); }`,
				reads: ["read 4 rows", "error: row 9 is past the end"],
			},
			{
				code: `export default async (env) => {`,
				reads: ["SyntaxError"],
			},
		];
		await ws.scriptModel(scope, [
			...failing.map(({ code }) => ({ code })),
			{
				code: `export default async (env) => {
					const saved = await env.documents.replace({ outputId: "out-doc", expectedRevision: ${revision},
						content: { kind: "document", blocks: [{ type: "paragraph", text: "Whole 😀" }] } });
					const read = await env.documents.read({ outputId: "out-doc" });
					return { revision: saved.revision, text: read.content.blocks[0].text, files: (await env.outputs.list()).length };
				}`,
			},
			{ text: "Twelve calls failed; I read why and saved the file." },
		]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Try each of these",
		});
		expect(await ws.awaitTurn(scope, started.turnId, 30_000)).toMatchObject({
			status: "finished",
			text: "Twelve calls failed; I read why and saved the file.",
		});
		const results = (await ws.readMessages(scope, started.conversationId))
			.filter((message) => message.role === "toolResult")
			.map((message) => ({
				isError: (message as { isError?: boolean }).isError,
				text: JSON.stringify(message.content),
			}));
		expect(results.map((result) => result.isError)).toEqual([
			...failing.map(() => true),
			false,
		]);
		for (const [index, { reads }] of failing.entries())
			for (const text of reads) expect(results[index]?.text).toContain(text);
		// Refused arguments read as fields, not as a schema dump.
		expect(results[0]?.text).not.toContain("invalid_type");
		// None of the failed calls changed or added a file; the corrected one saved once.
		expect(results.at(-1)?.text).toContain(`\\"revision\\": ${revision + 1}`);
		expect(results.at(-1)?.text).toContain(`\\"files\\": ${files}`);
		expect(results.at(-1)?.text).toContain('\\"text\\": \\"Whole 😀\\"');
		const events = await ws.readEvents(scope, {
			conversationId: started.conversationId,
		});
		// Nothing waits for a person, and the chat shows why each step failed.
		expect(
			events.filter(
				(event) => event.type === "approval.requested" && !event.automatic,
			),
		).toEqual([]);
		expect(
			events.filter(
				(event) =>
					event.type === "step.finished" &&
					event.status === "error" &&
					event.error?.includes("holds half of a character"),
			).length,
		).toBeGreaterThanOrEqual(4);
		expect(
			events.filter((event) => event.type === "turn.finished"),
		).toMatchObject([{ status: "done" }]);
	});

	test.each([
		{ where: "in the workspace", isolate: false },
		{ where: "beside it", isolate: true },
	])(
		"code that ran out of time cannot change a file afterwards (turn $where)",
		async ({ isolate }) => {
			await seedCore();
			const own = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([own]);
			const ws = workspace(own);
			await seedOutputs(ws, own);
			// Wide margins on purpose: on a slow machine the second run must
			// still finish well inside the limit.
			await ws.limitCodeRuns(own, 4_000);
			const create = (title: string) =>
				`env.outputs.create({ title: "${title}", content: { kind: "document", blocks: [] } })`;
			// The first run is given up at 4 s and writes at 6 s, while the turn
			// is still running its second piece of code.
			const LATE = `export default async (env) => {
				await new Promise((resolve) => setTimeout(resolve, 6000));
				await ${create("written too late")};
			}`;
			const NEXT = `export default async (env) => {
				const made = await ${create("written in time")};
				await new Promise((resolve) => setTimeout(resolve, 2500));
				return made.title;
			}`;
			await ws.scriptModel(own, [
				{ code: LATE },
				{ code: NEXT },
				{ text: "Done." },
			]);
			const { turnId, conversationId } = await ws.sendTurn(own, {
				actorId: "u1",
				actorKind: "user",
				text: "Write two files",
				isolate,
			});
			expect(await ws.awaitTurn(own, turnId, 30_000)).toMatchObject({
				status: "finished",
			});
			const events = await ws.readEvents(own, { conversationId, after: 0 });
			expect(
				events.flatMap((event) =>
					event.type === "step.finished" && event.error ? [event.error] : [],
				),
			).toEqual([sandboxTimeoutError(4_000)]);
			// Only the run the turn was waiting for reached the workspace.
			const written = events.flatMap((event) =>
				event.type === "step.started" && event.tool === "outputs.create"
					? [(event.input as { title?: string }).title]
					: [],
			);
			expect([...new Set(written)]).toEqual(["written in time"]);
			expect(
				events.filter(
					(event) => event.type === "approval.executed" && event.output,
				),
			).toHaveLength(1);
		},
	);

	test("code that runs out of time, cannot load or exports nothing fails its run, not the caller", async () => {
		const sandbox = createLoaderSandbox(testEnv.LOADER, COMPATIBILITY_DATE);
		const slow = await sandbox.run({
			code: `export default async () => { await new Promise((resolve) => setTimeout(resolve, 3000)); return "late"; }`,
			env: {},
			timeoutMs: 1000,
		});
		expect(slow).toMatchObject({ ok: false, logs: [] });
		expect(slow.error).toBe(sandboxTimeoutError(1000));
		expect(slow.error).toContain("did not finish within 1 s");
		expect(slow.error).toContain("may have taken effect");
		expect(slow.durationMs).toBeLessThan(2500);
		expect(
			await sandbox.run({ code: `export const answer = 42;`, env: {} }),
		).toMatchObject({
			ok: false,
			error: "Module must export default async (env) => …",
		});
		const broken = await sandbox.run({
			code: `import "./missing.js";`,
			env: {},
		});
		expect(broken.ok).toBe(false);
		expect(broken.error).toBeTruthy();
		expect(
			await sandbox.run({
				code: `export default async () => ({ total: 3 })`,
				env: {},
			}),
		).toMatchObject({ ok: true, result: { total: 3 }, logs: [] });
	});

	test("an agent's saved edit tells everyone with the workspace open", async () => {
		await seedCore();
		await testEnv.DB.batch([
			testEnv.DB.prepare(ddl(organizations)),
			testEnv.DB.prepare(
				"INSERT OR REPLACE INTO organizations (id, name, slug) VALUES (?, 'Blue Harbor', 'blueharbor')",
			).bind(scope.organizationId),
		]);
		// Its own workspace: earlier tests revise the shared one's files.
		const own = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([own]);
		const ws = workspace(own);
		await seedOutputs(ws, own);
		await ws.scriptModel(own, [
			{
				code: `export default async (env) => env.outputs.revise({
			outputId: "out-doc", expectedRevision: 1,
			content: { kind: "document", blocks: [{ type: "paragraph", text: "agent edit" }] }
		})`,
			},
			{ text: "Edited." },
		]);
		const started = await ws.sendTurn(own, {
			actorId: "u1",
			actorKind: "user",
			text: "Edit the priorities",
		});
		expect(await ws.awaitTurn(own, started.turnId, 20_000)).toMatchObject({
			status: "finished",
			text: "Edited.",
		});
		// The edit applied in the turn itself; nobody was asked.
		const events = await ws.readEvents(own, {
			conversationId: started.conversationId,
		});
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("The edit was not recorded");
		expect(requested.automatic).toBe(true);
		expect(
			events.find((event) => event.type === "approval.executed"),
		).toMatchObject({
			approvalId: requested.approvalId,
			status: "applied",
			output: { outputId: "out-doc", revision: 2 },
		});
		expect(
			events.filter((event) => event.type === "turn.started"),
		).toHaveLength(1);
		const after = await ws.outputQuery(own, {
			op: "get",
			outputId: "out-doc",
		});
		const room = testEnv.COLLAB_ROOM.getByName(
			workspaceRoomName({
				tenantSlug: "blueharbor",
				workspaceId: own.workspaceId,
			}),
		) as unknown as { notices(): Promise<unknown[]> };
		expect(await room.notices()).toEqual([
			{
				path: WORKSPACE_ROOM_OUTPUT_REVISION_PATH,
				body: {
					outputId: "out-doc",
					revisionId: after!.currentRevisionId,
					revision: 2,
				},
			},
		]);
	});

	test("events replay from a cursor and a guest tedi's profile comes from its own object", async () => {
		await seedCore();
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
		expect(startedEvent).toMatchObject({
			authorId: "u1",
			authorKind: "person",
			respondingTediId: "tedi1",
		});
		const done = replayed.find((event) => event.type === "assistant.done");
		expect(done?.type === "assistant.done" && done.text).toBe(
			"Hello from the guest.",
		);
		const history = await ws.readLedger(scope, conversationId, { limit: 10 });
		expect(history.map((event) => event.type)).toContain("turn.started");
		// Its own prompt leads; the next turn's agent is told who wrote the reply.
		expect((await ws.readSystemPrompts(scope)).at(-1)).toMatch(
			/^You are tedi tedi1\.\n\nRecall for: Say hello\n\nYou are answering in the chat/,
		);
		await ws.scriptModel(scope, [{ text: "Hello from the agent." }]);
		const next = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "And you?",
			conversationId,
		});
		await ws.awaitTurn(scope, next.turnId, 20_000);
		expect((await ws.readSystemPrompts(scope)).at(-1)).toContain(
			"were written by Guest, not by you",
		);
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
		"resolves %s attachments with workspace access checks",
		async (kind) => {
			await seedCore();
			const attachmentScope = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([attachmentScope]);
			const ws = workspace(attachmentScope);
			await seedOutputs(ws, attachmentScope);
			const ownerScope =
				kind === "foreign"
					? { ...attachmentScope, workspaceId: crypto.randomUUID() }
					: attachmentScope;
			const owner = workspace(ownerScope);
			if (kind === "foreign") {
				await seedWorkspaceRows([ownerScope]);
				await seedOutputs(owner, ownerScope);
			}
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
								workspaceId: attachmentScope.workspaceId,
								resourceId: crypto.randomUUID(),
							},
						}
					: {}),
			};
			const body = await storeOutputBody(
				testEnv.R2_BUCKET,
				attachmentScope.organizationId,
				JSON.stringify(content),
			);
			await owner.outputQuery(ownerScope, {
				op: "create",
				output: {
					id: outputId,
					organizationId: attachmentScope.organizationId,
					workspaceId: ownerScope.workspaceId,
					title: "Unavailable attachment",
					kind: "document",
					currentRevisionId: revisionId,
					createdByKind: "user",
					createdById: "u1",
				},
				revision: {
					id: revisionId,
					organizationId: attachmentScope.organizationId,
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
			});
			const turnId = crypto.randomUUID();
			if (kind === "large" || kind === "uploaded") {
				await ws.scriptModel(attachmentScope, [
					{
						code: `export default async env => { const output = await env.outputs.get(${JSON.stringify(outputId)}); return { revisionId: output.revisionId, content: output.content.kind === "document" ? { length: output.content.blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0), file: output.content.file ?? null } : null }; }`,
					},
					{ text: "Read the attached output on demand." },
				]);
				const turn = await ws.sendTurn(attachmentScope, {
					actorId: "u1",
					actorKind: "user",
					text: "Read the attached file",
					attachments: [{ outputId }],
					isolate: true,
				});
				expect(
					(await ws.awaitTurn(attachmentScope, turn.turnId, 20_000)).status,
				).toBe("finished");
				const messages = await ws.readMessages(
					attachmentScope,
					turn.conversationId,
				);
				const user = JSON.stringify(
					messages.filter((message) => message.role === "user"),
				);
				expect(user).toContain(outputId);
				expect(user).toContain(revisionId);
				expect(user).toContain("env.outputs.get");
				expect(user).not.toContain("x".repeat(100));
				const results = messages
					.filter((message) => message.role === "toolResult")
					.flatMap((message) => message.content)
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				expect(results).toContain(revisionId);
				if (kind === "large") expect(results).toContain('"length": 68000');
				else expect(results).toContain(content.file!.resourceId);
				return;
			}
			expect(
				(await rejectedSocketTurn(ws, [{ outputId }], turnId, attachmentScope))
					.message,
			).toContain("unavailable");
			expect(await ws.readTurn(attachmentScope, turnId)).toBeNull();
		},
	);

	test("the agent answers from the end of a long attached file by reading on in parts", async () => {
		await seedCore();
		const fileScope = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([fileScope]);
		const ws = workspace(fileScope);
		await seedOutputs(ws, fileScope);
		const outputId = crypto.randomUUID();
		const revisionId = crypto.randomUUID();
		const resourceId = crypto.randomUUID();
		const lines = Array.from(
			{ length: 1_900 },
			(_, index) => `Clause ${index + 1}: nothing of note in this clause.`,
		);
		lines.push('Clause 1901: the "renewal date" is 14 March 2031.');
		await testEnv.R2_BUCKET.put(
			workspaceFileTextKey(
				fileScope.organizationId,
				fileScope.workspaceId,
				resourceId,
			),
			JSON.stringify({ status: "text", text: lines.join("\n") }),
		);
		const body = await storeOutputBody(
			testEnv.R2_BUCKET,
			fileScope.organizationId,
			JSON.stringify({
				kind: "document",
				blocks: [],
				file: { workspaceId: fileScope.workspaceId, resourceId },
			}),
		);
		await ws.outputQuery(fileScope, {
			op: "create",
			output: {
				id: outputId,
				organizationId: fileScope.organizationId,
				workspaceId: fileScope.workspaceId,
				title: "Contract.pdf",
				kind: "document",
				currentRevisionId: revisionId,
				createdByKind: "user",
				createdById: "u1",
			},
			revision: {
				id: revisionId,
				organizationId: fileScope.organizationId,
				outputId,
				revision: 1,
				content: "",
				...body,
				createdByKind: "user",
				createdById: "u1",
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			},
		});
		// The message carries the first lines; each read continues where the last one stopped.
		const attached = readTextPart(lines, {}, FILE_TEXT_INLINE_CHARS);
		const first = readTextPart(
			lines,
			{ startLine: attached.nextStartLine },
			FILE_TEXT_PART_CHARS,
			encodedLength,
		);
		const second = readTextPart(
			lines,
			{ startLine: first.nextStartLine },
			FILE_TEXT_PART_CHARS,
			encodedLength,
		);
		expect(first.nextStartLine).not.toBeNull();
		expect(second.nextStartLine).toBeNull();
		const read = (startLine: number | null) =>
			`export default async env => env.outputs.readFileText({ outputId: ${JSON.stringify(outputId)}, startLine: ${startLine} })`;
		await ws.scriptModel(fileScope, [
			{ code: read(attached.nextStartLine) },
			{ code: read(first.nextStartLine) },
			{ text: "The renewal date is 14 March 2031." },
		]);
		const turn = await ws.sendTurn(fileScope, {
			actorId: "u1",
			actorKind: "user",
			text: "What is the renewal date in this contract?",
			attachments: [{ outputId }],
		});
		expect((await ws.awaitTurn(fileScope, turn.turnId, 20_000)).status).toBe(
			"finished",
		);
		const messages = await ws.readMessages(fileScope, turn.conversationId);
		const user = JSON.stringify(
			messages.filter((message) => message.role === "user"),
		);
		expect(user).toContain("Clause 1: nothing of note");
		expect(user).toContain(
			`These are lines 1 to ${attached.endLine} of 1901; the rest is not shown here.`,
		);
		expect(user).toContain(`from startLine ${attached.nextStartLine}`);
		expect(user).not.toContain("14 March 2031");
		const results = messages
			.filter((message) => message.role === "toolResult")
			.map((message) =>
				message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n"),
			);
		expect(results).toHaveLength(2);
		expect(results[0]).toContain(`"nextStartLine": ${first.nextStartLine}`);
		expect(results[0]).toContain(`Clause ${first.endLine}: nothing of note`);
		expect(results[0]).not.toContain("14 March 2031");
		expect(results[1]).toContain('the \\"renewal date\\" is 14 March 2031.');
		expect(results[1]).toContain('"nextStartLine": null');
		// Each part arrives whole: nothing was cut by the tool result limit.
		for (const result of results) expect(result).not.toContain("[truncated");
		const events = await ws.readEvents(fileScope, {
			conversationId: turn.conversationId,
		});
		expect(
			events.filter((event) => event.type === "approval.requested"),
		).toEqual([]);
	});

	test("the alarm keeps a live turn until its progress is 15 minutes old", async () => {
		const localScope = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([localScope]);
		const ws = workspace(localScope);
		await ws.scriptModel(localScope, [
			{
				text: "This answer takes several seconds to stream and will be interrupted by the idle watchdog.",
				tokensPerSecond: 1,
			},
		]);
		const turn = await ws.sendTurn(localScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Stream slowly",
		});
		await ws.retryProjections(localScope);
		expect(await ws.readTurn(localScope, turn.turnId)).toMatchObject({
			status: "running",
		});
		await runInDurableObject(ws, (instance, state) => {
			state.storage.sql.exec(
				"UPDATE events SET at = ? WHERE turn_id = ?",
				new Date(Date.now() - 16 * 60_000).toISOString(),
				turn.turnId,
			);
			return instance.alarm!();
		});
		expect(await ws.awaitTurn(localScope, turn.turnId, 1000)).toMatchObject({
			status: "failed",
			error: "Stopped: no progress for 15 minutes.",
		});
		const events = await ws.readEvents(localScope);
		expect(
			events.filter((event) => event.type === "turn.finished"),
		).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({
			type: "turn.finished",
			status: "error",
		});
	});

	test.each(["stop", "alarm"])(
		"%s closes a running row without an executor and preserves its steps",
		async (path) => {
			const localScope = { ...scope, workspaceId: crypto.randomUUID() };
			await seedWorkspaceRows([localScope]);
			const ws = workspace(localScope);
			await ws.listConversations(localScope);
			await runInDurableObject(ws, (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('orphan', 'Orphan', '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:00.000Z')",
				);
				state.storage.sql.exec(
					"INSERT INTO turns (turn_id, conversation_id, started_at, status, actor_id, actor_kind) VALUES ('orphan', 'orphan', '2026-10-22T10:00:00.000Z', 'running', 'u1', 'user')",
				);
				state.storage.sql.exec(
					"INSERT INTO events (conversation_id, turn_id, at, type, body) VALUES ('orphan', 'orphan', '2026-10-22T10:00:00.000Z', 'step.started', ?)",
					JSON.stringify({
						type: "step.started",
						turnId: "orphan",
						stepId: "kept",
						label: "Read data",
						kind: "read",
					}),
				);
			});
			if (path === "stop")
				expect(await ws.cancelTurn(localScope, "orphan")).toBe(true);
			else await ws.retryProjections(localScope);
			expect(await ws.readTurn(localScope, "orphan")).toMatchObject({
				status: path === "stop" ? "cancelled" : "failed",
			});
			const events = await ws.readEvents(localScope);
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({ type: "step.started", stepId: "kept" });
			expect(events[1]).toMatchObject({
				type: "turn.finished",
				status: path === "stop" ? "cancelled" : "error",
			});
			expect(await ws.cancelTurn(localScope, "orphan")).toBe(false);
			expect(await ws.readEvents(localScope)).toEqual(events);
		},
	);

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

	test("a chat whose history is tens of megabytes replays in bounded pages", async () => {
		await seedCore();
		const scope = {
			organizationId: "org_large_ledger",
			workspaceId: crypto.randomUUID(),
		};
		await seedWorkspaceRows([scope]);
		const ws = workspace(scope);
		await ws.scriptModel(scope, [{ text: "A short answer." }]);
		const started = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Edit the deck",
		});
		await ws.awaitTurn(scope, started.turnId, 20_000);
		const conversationId = started.conversationId;
		// Each write of a 1.2 MB deck leaves its whole payload in the ledger
		// twice: the step and its approval request. Twenty writes are 48 MB.
		const deck = "d".repeat(1_200_000);
		await runInDurableObject(
			ws as unknown as DurableObjectStub,
			(_instance, state) => {
				for (let write = 0; write < 20; write += 1) {
					const stepId = `write-${write}`;
					for (const body of [
						{
							type: "step.started",
							turnId: started.turnId,
							stepId,
							label: "Saving a presentation revision",
							kind: "write",
							tool: "presentations.replace",
							input: { deck },
						},
						{
							type: "approval.requested",
							turnId: started.turnId,
							stepId,
							approvalId: `approval-${write}`,
							title: "Save the deck",
							reason: "fixture",
							input: { deck },
						},
						{
							type: "step.finished",
							turnId: started.turnId,
							stepId,
							status: "ok",
							durationMs: 1,
						},
					])
						state.storage.sql.exec(
							"INSERT INTO events (conversation_id, turn_id, at, type, body) VALUES (?, ?, ?, ?, ?)",
							conversationId,
							started.turnId,
							"2026-11-16T09:30:00.000Z",
							body.type,
							JSON.stringify(body),
						);
				}
			},
		);

		const open = async (query: string) => {
			const socket = (
				await ws.fetch(
					new Request(`https://workspace.test/subscribe${query}`, {
						headers: {
							Upgrade: "websocket",
							"X-Workspace-Org": scope.organizationId,
							"X-Workspace-Id": scope.workspaceId,
							"X-Workspace-Actor-Id": "u1",
						},
					}),
				)
			).webSocket;
			if (!socket) throw new Error("upgrade did not return a WebSocket");
			const frames: Record<string, unknown>[] = [];
			socket.addEventListener("message", (event) => {
				frames.push(JSON.parse(String(event.data)));
			});
			socket.accept();
			/** Index of the first frame at or after `from` with one of `types`. */
			const until = (from: number, ...types: string[]) =>
				vi.waitFor(
					() => {
						const index = frames.findIndex(
							(frame, at) => at >= from && types.includes(String(frame.type)),
						);
						if (index < 0) throw new Error(`waiting for ${types.join("/")}`);
						return index;
					},
					{ timeout: 10_000 },
				);
			return { socket, frames, until };
		};
		const chars = (frames: Record<string, unknown>[]) =>
			frames
				.filter((frame) => typeof frame.seq === "number")
				.reduce((total, frame) => total + JSON.stringify(frame).length, 0);
		const seqs = (frames: Record<string, unknown>[]) =>
			frames
				.filter((frame) => typeof frame.seq === "number")
				.map((frame) => Number(frame.seq));
		// One event may overshoot the budget; a page never holds a second one.
		const pageLimit = EVENT_PAGE_CHARS + 1_300_000;

		// A tab that reconnects with an old cursor: the whole gap, page by page.
		const stale = await open("?after=0");
		try {
			expect(await stale.until(0, "hello")).toBe(0);
			const latest = Number(stale.frames[0]?.cursor);
			let from = 0;
			let pages = 0;
			for (;;) {
				const mark = await stale.until(from, "replay.more", "caught_up");
				expect(chars(stale.frames.slice(from, mark))).toBeLessThan(pageLimit);
				const frame = stale.frames[mark]!;
				from = mark + 1;
				if (frame.type === "caught_up") break;
				pages += 1;
				expect(frame.cursor).toBe(seqs(stale.frames).at(-1));
				stale.socket.send(
					JSON.stringify({
						type: "subscribe",
						conversationId: null,
						cursor: frame.cursor,
					}),
				);
			}
			expect(pages).toBeGreaterThan(5);
			// Nothing lost, nothing sent twice, in order.
			expect(seqs(stale.frames)).toEqual(
				Array.from({ length: latest }, (_, index) => index + 1),
			);
		} finally {
			stale.socket.close(1000, "test complete");
		}

		// A new tab on the conversation: its newest page, then earlier on request.
		const fresh = await open("");
		try {
			fresh.socket.send(
				JSON.stringify({ type: "subscribe", conversationId, cursor: null }),
			);
			const done = await fresh.until(0, "caught_up");
			const first = fresh.frames.slice(0, done);
			const shown = seqs(first);
			expect(chars(first)).toBeLessThan(pageLimit);
			expect(shown.at(-1)).toBe(fresh.frames[0]?.cursor);
			expect(shown[0]).toBeGreaterThan(1);
			expect(first).toContainEqual({
				type: "ledger.page",
				conversationId,
				events: [],
				hasMore: true,
			});
			fresh.socket.send(
				JSON.stringify({
					type: "read_ledger",
					conversationId,
					before: shown[0],
					limit: 40,
				}),
			);
			const earlier = fresh.frames[await fresh.until(done, "ledger.page")] as {
				events: Array<{ seq: number }>;
				hasMore: boolean;
			};
			expect(JSON.stringify(earlier.events).length).toBeLessThan(pageLimit);
			expect(earlier.events.at(-1)?.seq).toBe(shown[0]! - 1);
			expect(earlier.hasMore).toBe(true);
		} finally {
			fresh.socket.close(1000, "test complete");
		}

		// A new tab on no conversation has nothing to fold: no replay at all.
		const blank = await open("");
		try {
			blank.socket.send(
				JSON.stringify({
					type: "subscribe",
					conversationId: null,
					cursor: null,
				}),
			);
			const done = await blank.until(0, "caught_up");
			expect(seqs(blank.frames.slice(0, done))).toEqual([]);
		} finally {
			blank.socket.close(1000, "test complete");
		}
	});

	test("the MCP entry negotiates discovery, lists tools and completes a workspace turn", async () => {
		const ws = workspace();
		const headers = {
			"Content-Type": "application/json",
			"X-Workspace-Org": scope.organizationId,
			"X-Workspace-Id": scope.workspaceId,
			"X-Workspace-Actor-Id": "u1",
			"X-Workspace-Actor-Kind": "user",
			"X-Workspace-Scopes": "mcp:apps.read mcp:apps.write",
		};
		const discovered = await ws.fetch(
			new Request("https://workspace.test/mcp", {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: "discover",
					method: "server/discover",
				}),
			}),
		);
		expect(await discovered.json()).toEqual({
			jsonrpc: "2.0",
			id: "discover",
			result: {
				resultType: "complete",
				supportedVersions: ["2026-07-28", "2025-06-18"],
				capabilities: { tools: {} },
			},
		});
		const listed = await ws.fetch(
			new Request("https://workspace.test/mcp", {
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {
						_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
					},
				}),
			}),
		);
		const listBody = (await listed.json()) as {
			result: { tools: Array<{ name: string }> };
		};
		expect(listBody.result).toMatchObject({
			resultType: "complete",
			_meta: {
				"io.modelcontextprotocol/serverInfo": {
					name: "tedix-workspace",
					version: "1",
				},
			},
		});
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
						_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
					},
				}),
			}),
		);
		const callBody = (await called.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(callBody.result).toMatchObject({
			resultType: "complete",
			_meta: {
				"io.modelcontextprotocol/serverInfo": {
					name: "tedix-workspace",
					version: "1",
				},
			},
		});
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
		// The conversation an agent opened names that agent as its starter.
		expect((await ws.listConversations(actionScope))[0]?.startedBy).toEqual({
			kind: "agent",
			id: "u1",
		});
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

test("a slow workspace feed does not hold a file save", async () => {
	await seedCore();
	const ws = workspace();
	const id = "slow-feed-file";
	const now = new Date().toISOString();
	const body = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify({ kind: "document", blocks: [] }),
	);
	const core = createDbQueryClient(testEnv.DB);
	await ws.delayProjections(scope, 5_000);
	try {
		const started = Date.now();
		await ws.outputQuery(scope, {
			op: "create",
			output: {
				id,
				...scope,
				kind: "document",
				title: "Slow feed file",
				currentRevisionId: "slow-feed-r1",
				createdByKind: "user",
				createdById: "u1",
				createdAt: now,
				updatedAt: now,
			},
			revision: {
				id: "slow-feed-r1",
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
		// The save returns after the bounded wait, not after the slow publish.
		expect(Date.now() - started).toBeLessThan(4_500);
		expect(
			await getWorkspaceOutputIndexCurrent(core, {
				organizationId: scope.organizationId,
				outputId: id,
			}),
		).toBeFalsy();
		// The next save does not queue behind the first file's publish either.
		const second = Date.now();
		await ws.outputQuery(scope, {
			op: "create",
			output: {
				id: `${id}-2`,
				...scope,
				kind: "document",
				title: "Second slow feed file",
				currentRevisionId: "slow-feed-r2",
				createdByKind: "user",
				createdById: "u1",
				createdAt: now,
				updatedAt: now,
			},
			revision: {
				id: "slow-feed-r2",
				organizationId: scope.organizationId,
				outputId: `${id}-2`,
				revision: 1,
				content: "",
				...body,
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
				createdByKind: "user",
				createdById: "u1",
				createdAt: now,
			},
		});
		expect(Date.now() - second).toBeLessThan(4_500);
		expect(
			(await ws.outputQuery(scope, { op: "get", outputId: id }))
				?.currentRevisionId,
		).toBe("slow-feed-r1");
	} finally {
		await ws.delayProjections(scope, 0);
	}
	// The publish carries on; the alarm finishes whatever is left.
	await ws.retryProjections(scope);
	expect(
		await getWorkspaceOutputIndexCurrent(core, {
			organizationId: scope.organizationId,
			outputId: id,
		}),
	).toMatchObject({ revisionId: "slow-feed-r1", title: "Slow feed file" });
}, 30_000);

test("a one-cell 150-row sheet save stays under 1.5 seconds with a slow feed", async () => {
	await seedCore();
	const ws = workspace();
	const id = "sheet-save-budget";
	const now = new Date().toISOString();
	const content = {
		kind: "sheet",
		columns: ["Name", "Status"],
		rows: Array.from({ length: 150 }, (_, n) => [`Row ${n}`, "Pending"]),
	};
	const body = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		JSON.stringify(content),
	);
	const author = { createdByKind: "user" as const, createdById: "u1" };
	await ws.outputQuery(scope, {
		op: "create",
		output: {
			id,
			...scope,
			kind: "sheet",
			title: "Save fixture",
			currentRevisionId: `${id}-1`,
			...author,
			createdAt: now,
			updatedAt: now,
		},
		revision: {
			id: `${id}-1`,
			organizationId: scope.organizationId,
			outputId: id,
			revision: 1,
			content: "",
			...body,
			...author,
			createdAt: now,
		},
	});
	content.rows[74]![1] = "Saved";
	await ws.delayProjections(scope, 5_000);
	try {
		const started = Date.now();
		const stored = await storeOutputBody(
			testEnv.R2_BUCKET,
			scope.organizationId,
			JSON.stringify(content),
		);
		const result = await ws.outputQuery(scope, {
			op: "revise",
			params: {
				id: `${id}-2`,
				organizationId: scope.organizationId,
				outputId: id,
				expectedRevision: 1,
				...stored,
				...author,
			},
		});
		const elapsed = Date.now() - started;
		console.info("150-row slow-feed revision milliseconds", elapsed);
		expect(result).toMatchObject({ ok: true, revision: { revision: 2 } });
		expect(elapsed).toBeLessThan(1_500);
	} finally {
		await ws.delayProjections(scope, 0);
	}
	await ws.retryProjections(scope);
	expect(
		await getWorkspaceOutputIndexCurrent(createDbQueryClient(testEnv.DB), {
			organizationId: scope.organizationId,
			outputId: id,
		}),
	).toMatchObject({ revision: 2 });
});

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
	const checkpoint = () =>
		runInDurableObject(ws, (_instance, state) =>
			state.storage.kv.get<number>(`output-history-through:${id}`),
		);
	expect(await checkpoint()).toBe(2);
	await evictDurableObject(ws);
	const third = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		"third body",
	);
	expect(
		await ws.outputQuery(scope, {
			op: "revise",
			params: {
				id: "coalesced-r3",
				organizationId: scope.organizationId,
				outputId: id,
				expectedRevision: 2,
				...third,
				createdByKind: "user",
				createdById: "u1",
			},
		}),
	).toMatchObject({ ok: true });
	expect(await checkpoint()).toBe(3);
	await ws.failNextProjection(scope);
	const fourth = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		"fourth body",
	);
	await ws.outputQuery(scope, {
		op: "revise",
		params: {
			id: "coalesced-r4",
			organizationId: scope.organizationId,
			outputId: id,
			expectedRevision: 3,
			...fourth,
			createdByKind: "user",
			createdById: "u1",
		},
	});
	expect(await checkpoint()).toBe(3);
	const fifth = await storeOutputBody(
		testEnv.R2_BUCKET,
		scope.organizationId,
		"fifth body",
	);
	await ws.outputQuery(scope, {
		op: "revise",
		params: {
			id: "coalesced-r5",
			organizationId: scope.organizationId,
			outputId: id,
			expectedRevision: 4,
			...fifth,
			createdByKind: "user",
			createdById: "u1",
		},
	});
	await ws.retryProjections(scope);
	expect(await checkpoint()).toBe(5);
	expect(
		(
			await testEnv.DB.prepare(
				"SELECT revision FROM workspace_output_index WHERE output_id = ? ORDER BY revision",
			)
				.bind(id)
				.all()
		).results,
	).toEqual([1, 2, 3, 4, 5].map((revision) => ({ revision })));
});

test("clears a save's search text when the save stores no revision, and keeps it for a publish still owed", async () => {
	await seedCore();
	const ws = workspace();
	const id = "excerpt-file";
	const now = new Date().toISOString();
	const envelope = JSON.stringify({ version: 1, sources: [] });
	const author = { createdByKind: "user" as const, createdById: "u1" };
	const text = (revisionId: string) =>
		runInDurableObject(ws, (_instance, state) =>
			state.storage.kv.get<string>(`output-excerpt:${revisionId}`),
		);
	const body = (words: string) =>
		storeOutputBody(
			testEnv.R2_BUCKET,
			scope.organizationId,
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: words }],
			}),
		);
	const create = (organizationId: string, revisionId: string) =>
		body("first").then((stored) =>
			ws.outputQuery(scope, {
				op: "create",
				excerpt: "first words",
				output: {
					id,
					...scope,
					organizationId,
					kind: "document",
					title: "Excerpt file",
					currentRevisionId: revisionId,
					...author,
					createdAt: now,
					updatedAt: now,
				},
				revision: {
					id: revisionId,
					organizationId,
					outputId: id,
					revision: 1,
					content: "",
					...stored,
					accessEnvelope: envelope,
					...author,
					createdAt: now,
				},
			}),
		);
	const revise = async (
		revisionId: string,
		expectedRevision: number,
		words: string,
	) =>
		ws.outputQuery(scope, {
			op: "revise",
			excerpt: words,
			params: {
				id: revisionId,
				organizationId: scope.organizationId,
				outputId: id,
				expectedRevision,
				...(await body(words)),
				accessEnvelope: envelope,
				...author,
			},
		});

	// A create that is refused throws before anything is stored.
	await expect(create("another-org", "excerpt-refused")).rejects.toThrow();
	expect(await text("excerpt-refused")).toBeUndefined();

	await create(scope.organizationId, "excerpt-r1");
	expect(await text("excerpt-r1")).toBeUndefined();

	// A save from a stale copy is answered, not thrown, and stores nothing.
	expect(await revise("excerpt-stale", 7, "stale words")).toMatchObject({
		ok: false,
		reason: "revision_conflict",
	});
	expect(await text("excerpt-stale")).toBeUndefined();

	// A stored revision whose publish failed still needs its text.
	await ws.failNextProjection(scope);
	expect((await revise("excerpt-r2", 1, "second words")).ok).toBe(true);
	expect(await text("excerpt-r2")).toBe("second words");
	await ws.retryProjections(scope);
	expect(await text("excerpt-r2")).toBeUndefined();
	expect(
		await getWorkspaceOutputIndexCurrent(createDbQueryClient(testEnv.DB), {
			organizationId: scope.organizationId,
			outputId: id,
		}),
	).toMatchObject({ revisionId: "excerpt-r2", searchText: "second words" });
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
		// A post and a finished turn publish at once, so the failure is set up
		// before the turn; whatever it left behind is published by the retries.
		await ws.failEventProjection(eventScope, when);
		const started = await ws.sendTurn(eventScope, {
			actorId: "requesting-agent",
			actorKind: "external_agent",
			text: "Private question secret-marker",
		});
		expect(
			(await ws.awaitTurn(eventScope, started.turnId, 20_000)).status,
		).toBe("finished");
		const source = { source: "events" as const };
		await ws.retryProjections(eventScope);
		expect(await ws.reconcileActivity(eventScope, source)).toMatchObject({
			checked: 4,
			coverage: "recorded_workspace_events",
		});
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

test("a workspace chat reaches the core's workspace summary and survives a core snapshot", async () => {
	await seedCore();
	const summaryScope = { ...scope, workspaceId: crypto.randomUUID() };
	await seedWorkspaceRows([summaryScope]);
	await testEnv.DB.prepare(
		"INSERT INTO os_workspace_projects (id, organization_id, workspace_id, project_id, status, created_by_kind, created_by_id, created_at) VALUES (?, ?, ?, 'proj1', 'active', 'user', 'u1', '2026-11-07T10:00:00.000Z')",
	)
		.bind(
			crypto.randomUUID(),
			summaryScope.organizationId,
			summaryScope.workspaceId,
		)
		.run();
	const core = createDbQueryClient(testEnv.DB);
	const read = async () => {
		const row = await getOsWorkspaceSummary(core, summaryScope);
		return row ? parseOsWorkspaceSummaryPayload(row) : null;
	};
	const ws = workspace(summaryScope);
	await ws.scriptModel(summaryScope, [{ text: "First answer." }]);
	const first = await ws.sendTurn(summaryScope, {
		actorId: "u1",
		actorKind: "user",
		text: "First question",
	});
	await ws.awaitTurn(summaryScope, first.turnId, 20_000);
	await ws.retryProjections(summaryScope);
	const afterFirst = await read();
	expect(afterFirst?.usage).toMatchObject({
		conversationCount: 1,
		messageCount: 2,
		runCount: 1,
	});
	expect(afterFirst?.runStatus).toMatchObject({
		activeRunCount: 0,
		latestRun: { id: first.turnId, status: "completed" },
	});
	// The first row carries the workspace's active Work links from the core.
	expect(afterFirst?.workLinks.map((link) => link.projectId)).toEqual([
		"proj1",
	]);

	// The core's own snapshot counts kernel rows, which a workspace object's
	// chat never writes. It still owns the Work links, not the chat counts.
	await applyOsWorkspaceSummary(core, {
		...summaryScope,
		revision: Date.now() + 60_000,
		usage: JSON.stringify({
			conversationCount: 0,
			messageCount: 0,
			runCount: 0,
		}),
		runStatus: JSON.stringify({ activeRunCount: 0, latestRun: null }),
		workLinks: "[]",
		publishedAt: new Date().toISOString(),
		appliedAt: new Date().toISOString(),
	});
	const afterCore = await read();
	expect(afterCore?.workLinks).toEqual([]);
	expect(afterCore?.usage).toMatchObject({
		conversationCount: 1,
		messageCount: 2,
		runCount: 1,
	});
	expect(afterCore?.runStatus.latestRun?.id).toBe(first.turnId);

	await ws.scriptModel(summaryScope, [{ text: "Second answer." }]);
	const second = await ws.sendTurn(summaryScope, {
		actorId: "u1",
		actorKind: "user",
		text: "Second question",
	});
	await ws.awaitTurn(summaryScope, second.turnId, 20_000);
	await ws.retryProjections(summaryScope);
	const afterSecond = await read();
	expect(afterSecond?.usage).toMatchObject({
		conversationCount: 2,
		messageCount: 4,
		runCount: 2,
	});
	// The object's later write leaves the core's Work links as they were.
	expect(afterSecond?.workLinks).toEqual([]);

	// A rebuild from the object restores a lost row.
	await testEnv.DB.prepare(
		"DELETE FROM os_workspace_summaries WHERE workspace_id = ?",
	)
		.bind(summaryScope.workspaceId)
		.run();
	await ws.replayActivity(summaryScope, { source: "events" });
	expect((await read())?.usage).toMatchObject({ conversationCount: 2 });
});

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
	await from.outputQuery(source, { op: "initialize" });
	await to.outputQuery(target, { op: "initialize" });
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
	const destinationActivity = await listWorkspaceActivity(
		createDbQueryClient(testEnv.DB),
		{ organizationId: target.organizationId, viewer: { userIds: ["u1"] } },
		{ workspaceId: target.workspaceId, kinds: ["output"] },
	);
	expect(destinationActivity.some((row) => row.entityId === outputId)).toBe(
		true,
	);
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
	await to.failTransferReply(target);
	let retryError: unknown;
	try {
		await from.transferOutput(source, outputId, target.workspaceId);
	} catch (error) {
		retryError = error;
	}
	expect(retryError).toBeInstanceOf(Error);
	expect((retryError as Error).message).toBe("Injected lost transfer reply");
	expect(
		await from.transferOutput(source, outputId, target.workspaceId),
	).toMatchObject({ ok: true, output: { title: "Back home" } });
});

test("groups workspace-store auto-saves while indexing every revision and recovering projections", async () => {
	await seedCore();
	const scope = {
		organizationId: "org_test",
		workspaceId: crypto.randomUUID(),
	};
	await seedWorkspaceRows([scope]);
	const ws = workspace(scope);
	await seedOutputs(ws, scope);
	const outputId = "out-doc";
	for (let revision = 2; revision <= 5; revision++) {
		const body = await storeOutputBody(
			testEnv.R2_BUCKET,
			scope.organizationId,
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: `save ${revision}` }],
			}),
		);
		if (revision === 3) await ws.failNextProjection(scope);
		const result = await ws.outputQuery(scope, {
			op: "revise",
			params: {
				...scope,
				outputId,
				id: `burst-r${revision}`,
				...body,
				createdByKind: "user",
				createdById: "u1",
				note: revision === 5 ? "Named milestone" : "Saved automatically",
				expectedRevision: revision - 1,
			},
		});
		expect(result.ok).toBe(true);
	}
	await ws.retryProjections(scope);
	const db = createDbQueryClient(testEnv.DB);
	const activity = await listWorkspaceActivity(
		db,
		{ organizationId: scope.organizationId, viewer: { userIds: ["u1"] } },
		{ workspaceId: scope.workspaceId, kinds: ["output"] },
	);
	expect(
		activity
			.filter((row) => row.entityId === outputId)
			.map((row) => row.changeRecordId),
	).toEqual(["burst-r5", "burst-r2", "rev-doc"]);
	const history = await ws.outputQuery(scope, { op: "history", outputId });
	expect(history.map((row) => row.revision)).toEqual([5, 4, 3, 2, 1]);
	const index = await testEnv.DB.prepare(
		"SELECT revision, is_current FROM workspace_output_index WHERE workspace_id = ? AND output_id = ? ORDER BY revision",
	)
		.bind(scope.workspaceId, outputId)
		.all();
	expect(index.results).toEqual(
		[1, 2, 3, 4, 5].map((revision) => ({
			revision,
			is_current: revision === 5 ? 1 : 0,
		})),
	);
	await db.insert(osShareLinks).values({
		id: crypto.randomUUID(),
		organizationId: scope.organizationId,
		resourceType: "output",
		resourceId: outputId,
		tokenHash: crypto.randomUUID(),
		revisionMode: "pinned",
		pinnedRevisionId: "burst-r4",
		createdByKind: "user",
		createdById: "u1",
	});
	const thinning = {
		op: "thin" as const,
		outputId,
		revisionIds: ["rev-doc", "burst-r2", "burst-r3", "burst-r4", "burst-r5"],
		olderThan: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
		autosaveNote: "Saved automatically",
		dryRun: true,
	};
	expect(await ws.outputQuery(scope, thinning)).toEqual(["burst-r3"]);
	expect(await ws.outputQuery(scope, { ...thinning, dryRun: false })).toEqual([
		"burst-r3",
	]);
	expect(
		(await ws.outputQuery(scope, { op: "history", outputId })).map(
			(row) => row.revision,
		),
	).toEqual([5, 4, 2, 1]);
	// A lost deletion reply can safely be repeated so the caller can clean its index.
	expect(
		await ws.outputQuery(scope, {
			...thinning,
			revisionIds: ["burst-r3"],
			dryRun: false,
		}),
	).toEqual(["burst-r3"]);
});

describe("stopped, failed and interrupted turns", () => {
	const slowReply = {
		text: "one two three four five six seven eight nine ten eleven twelve",
		tokensPerSecond: 4,
	};

	async function untilMessages(
		ws: Stub,
		conversationId: string,
		roles: string[],
	) {
		for (let i = 0; i < 100; i += 1) {
			const messages = await ws.readMessages(scope, conversationId);
			if (messages.length >= roles.length) return messages;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error("messages were not saved");
	}

	test.each([false, true])(
		"Stop is stored as cancelled and keeps the user's message (isolate=%s)",
		async (isolate) => {
			await seedCore();
			await seedCore();
			const ws = workspace();
			await ws.scriptModel(scope, [slowReply]);
			const turn = await ws.sendTurn(scope, {
				actorId: "u1",
				actorKind: "user",
				text: "Tell me slowly",
				isolate,
			});
			await untilMessages(ws, turn.conversationId, ["user"]);
			expect(await ws.cancelTurn(scope, turn.turnId)).toBe(true);
			const outcome = await ws.awaitTurn(scope, turn.turnId, 5_000);
			expect(outcome).toMatchObject({
				status: "cancelled",
				error: "cancelled by user",
			});
			const messages = await ws.readMessages(scope, turn.conversationId);
			expect(messages[0]).toMatchObject({
				role: "user",
				content: "Tell me slowly",
			});
			const finished = (
				await ws.readEvents(scope, { conversationId: turn.conversationId })
			).find((event) => event.type === "turn.finished");
			expect(finished).toMatchObject({ status: "cancelled" });
		},
	);

	test("Stop ends a turn in a conversation longer than 40 messages", async () => {
		await seedCore();
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
		// About 16 seconds to finish on its own, so a loaded CI runner still
		// tells a stopped turn apart from one that ran to the end.
		await ws.scriptModel(scope, [{ ...slowReply, tokensPerSecond: 1 }]);
		const turn = await ws.sendTurn(scope, {
			conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "long chat, then stop",
		});
		await untilMessages(ws, turn.conversationId, new Array(43).fill("m"));
		await ws.cancelTurn(scope, turn.turnId);
		const startedStop = Date.now();
		const outcome = await ws.awaitTurn(scope, turn.turnId, 10_000);
		expect(outcome.status).toBe("cancelled");
		expect(Date.now() - startedStop).toBeLessThan(8_000);
	});

	test("a failed turn keeps its user message and finished steps", async () => {
		await seedCore();
		const ws = workspace();
		// The script runs out after the tool call, so the second model call fails.
		await ws.scriptModel(scope, [
			{ code: "export default async () => 41 + 1" },
		]);
		const turn = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Compute it",
		});
		expect((await ws.awaitTurn(scope, turn.turnId, 20_000)).status).toBe(
			"failed",
		);
		const messages = await ws.readMessages(scope, turn.conversationId);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(JSON.stringify(messages[2])).toContain("42");
	});

	test("an interrupted turn keeps its steps and the next turn continues from them", async () => {
		await seedCore();
		const ws = workspace();
		await ws.scriptModel(scope, [
			{ code: "export default async () => 'wrote it'", tokensPerSecond: 4 },
			slowReply,
		]);
		const turn = await ws.sendTurn(scope, {
			actorId: "u1",
			actorKind: "user",
			text: "Write, then explain",
		});
		await untilMessages(ws, turn.conversationId, [
			"user",
			"assistant",
			"toolResult",
		]);
		// A crash or deploy restart: the object resets mid-turn.
		await runInDurableObject(ws, (_instance, state) =>
			state.abort("restart"),
		).catch(() => {});
		const restarted = workspace();
		expect(await restarted.readTurn(scope, turn.turnId)).toMatchObject({
			status: "failed",
			error: "interrupted",
		});
		const kept = await restarted.readMessages(scope, turn.conversationId);
		expect(kept.slice(0, 3).map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
		expect(JSON.stringify(kept[2])).toContain("wrote it");

		await restarted.scriptModel(scope, [{ text: "Already written; done." }]);
		const next = await restarted.sendTurn(scope, {
			conversationId: turn.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Continue",
		});
		expect(await restarted.awaitTurn(scope, next.turnId, 20_000)).toMatchObject(
			{
				status: "finished",
				text: "Already written; done.",
			},
		);
	});
});

/** Every identity and row below belongs to a fictional, local tenant. */
describe("workspace transport authorization", () => {
	async function fixture() {
		await seedCore();
		const privateScope = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([privateScope]);
		await testEnv.DB.prepare(
			"UPDATE os_workspaces SET visibility = 'private', owner_user_id = 'u1' WHERE id = ?",
		)
			.bind(privateScope.workspaceId)
			.run();
		for (const [userId, role] of [
			["fictional-builder", "build"],
			["fictional-user", "use"],
		] as const) {
			await grantOsWorkspaceAccess(createDbQueryClient(testEnv.DB), {
				...privateScope,
				now: "2026-11-15T00:00:00Z",
				edges: [
					{
						kind: "user",
						targetUserId: userId,
						targetEmail: null,
						targetName: null,
						sharerUserId: "u1",
						role,
					},
				],
			});
		}
		const ws = workspace(privateScope);
		await seedOutputs(ws, privateScope);
		return { ws, privateScope };
	}
	function headers(
		privateScope: WorkspaceScope,
		actorId = "u1",
		actorKind = "user",
		scopes = "mcp:apps.read mcp:apps.write",
	) {
		return {
			"Content-Type": "application/json",
			"X-Workspace-Org": privateScope.organizationId,
			"X-Workspace-Id": privateScope.workspaceId,
			"X-Workspace-Actor-Id": actorId,
			"X-Workspace-Actor-Kind": actorKind,
			"X-Workspace-Scopes": scopes,
		};
	}
	function mcp(
		ws: Stub,
		h: Record<string, string>,
		name: string,
		args: Record<string, unknown> = {},
	) {
		return ws.fetch(
			new Request("https://workspace.test/mcp", {
				method: "POST",
				headers: h,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			}),
		);
	}
	async function open(
		ws: Stub,
		privateScope: WorkspaceScope,
		actorId = "fictional-builder",
	) {
		const response = await ws.fetch(
			new Request("https://workspace.test/subscribe", {
				headers: { ...headers(privateScope, actorId), Upgrade: "websocket" },
			}),
		);
		expect(response.status).toBe(101);
		if (!response.webSocket) throw new Error("No socket");
		return response.webSocket;
	}
	test.each(["fictional-user", "fictional-stranger"])(
		"MCP and chat refuse private workspace access for %s",
		async (actorId) => {
			const { ws, privateScope } = await fixture();
			for (const name of [
				"read_events",
				"read_turn",
				"read_change_records",
				"send_turn",
				"decide_approval",
			]) {
				const response = await mcp(ws, headers(privateScope, actorId), name, {
					text: "Unauthorized write",
					decision: "approve",
				});
				expect(response.status).toBe(403);
				expect(await response.text()).not.toContain("out-doc");
			}
			const chat = await ws.fetch(
				new Request("https://workspace.test/subscribe?after=0", {
					headers: { ...headers(privateScope, actorId), Upgrade: "websocket" },
				}),
			);
			expect(chat.status).toBe(403);
			expect(await ws.listConversations(privateScope)).toEqual([]);
		},
	);
	test.each(["u1", "fictional-builder"])(
		"MCP and chat permit current owner/build access for %s",
		async (actorId) => {
			const { ws, privateScope } = await fixture();
			expect(
				(await mcp(ws, headers(privateScope, actorId), "read_events")).status,
			).toBe(200);
			await ws.scriptModel(privateScope, [
				{ text: "Fictional authorized answer" },
			]);
			const response = await mcp(
				ws,
				headers(privateScope, actorId),
				"send_turn",
				{ text: "Authorized task", waitSeconds: 1 },
			);
			expect(await response.json()).toMatchObject({
				result: { isError: false },
			});
			const socket = await open(ws, privateScope, actorId);
			try {
				const replay = socketFramesUntil(
					socket,
					(frame) => frame.type === "caught_up",
				);
				socket.send(
					JSON.stringify({
						type: "subscribe",
						conversationId: null,
						cursor: 0,
					}),
				);
				const frames = await replay;
				expect(frames.some((frame) => frame.type === "turn.started")).toBe(
					true,
				);
			} finally {
				socket.close(1000, "test complete");
			}
		},
	);
	test.each(["u1", "fictional-builder"])(
		"current owner/build %s can approve a held removal on an existing socket",
		async (actorId) => {
			const { ws, privateScope } = await fixture();
			await ws.scriptModel(privateScope, [
				{
					code: `export default async env => { const doc = await env.documents.read({outputId:"out-doc"}); return env.documents.edit({outputId:doc.id,expectedRevision:doc.revision,ops:[{op:"delete",index:0}]}); }`,
				},
			]);
			const started = await ws.sendTurn(privateScope, {
				actorId: "u1",
				actorKind: "user",
				text: "Remove the heading of a fictional output",
			});
			await ws.awaitTurn(privateScope, started.turnId, 20_000);
			const requested = (
				await ws.readEvents(privateScope, {
					conversationId: started.conversationId,
				})
			).find((event) => event.type === "approval.requested");
			if (requested?.type !== "approval.requested")
				throw new Error("Missing pending approval");
			expect(requested.automatic).toBeUndefined();
			const current = async () =>
				(await ws.outputQuery(privateScope, { op: "get", outputId: "out-doc" }))
					?.currentRevisionId;
			expect(await current()).toBe("rev-doc");
			await ws.scriptModel(privateScope, [
				{ text: "Saved the authorized output" },
			]);
			const socket = await open(ws, privateScope, actorId);
			try {
				const executed = socketFramesUntil(
					socket,
					(frame) =>
						frame.type === "approval.executed" || frame.type === "error",
				);
				socket.send(
					JSON.stringify({
						type: "decide_approval",
						approvalId: requested.approvalId,
						decision: "approve",
					}),
				);
				expect((await executed).at(-1)).toMatchObject({
					type: "approval.executed",
					approvalId: requested.approvalId,
					status: "applied",
					output: { outputId: "out-doc", revision: 2 },
				});
				expect(await current()).not.toBe("rev-doc");
			} finally {
				socket.close(1000, "test complete");
			}
		},
	);

	test("MCP tedi access requires the active personal binding and operation scopes", async () => {
		const { ws, privateScope } = await fixture();
		const tediId = crypto.randomUUID();
		await testEnv.DB.prepare(
			"INSERT INTO tedis (id, organization_id, name, slug, scope, owner_user_id, status, created_at, updated_at) VALUES (?, ?, 'Fictional tedi', ?, 'personal', 'u1', 'active', '2026-11-15', '2026-11-15')",
		)
			.bind(tediId, privateScope.organizationId, tediId)
			.run();
		const impersonation = await mcp(
			ws,
			headers(privateScope, "fictional-builder"),
			"send_turn",
			{ text: "Impersonate the owner's tedi", tediId },
		);
		expect(await impersonation.json()).toMatchObject({
			result: { isError: true },
		});
		expect(await ws.listConversations(privateScope)).toEqual([]);
		const socket = await open(ws, privateScope);
		try {
			const denied = socketFramesUntil(
				socket,
				(frame) => frame.type === "error",
			);
			socket.send(
				JSON.stringify({
					type: "send_turn",
					clientTurnId: "impersonation",
					text: "Impersonate the owner's tedi",
					tediId,
				}),
			);
			expect((await denied).at(-1)).toMatchObject({
				type: "error",
				message: "Tedi access denied",
			});
			expect(await ws.listConversations(privateScope)).toEqual([]);
		} finally {
			socket.close(1000, "test complete");
		}
		const h = headers(privateScope, tediId, "tedi", "mcp:apps.read");
		expect((await mcp(ws, h, "read_events")).status).toBe(200);
		const deniedWrite = await mcp(ws, h, "send_turn", {
			text: "Read grant cannot write",
		});
		expect(await deniedWrite.json()).toMatchObject({
			result: { isError: true },
		});
		expect(await ws.listConversations(privateScope)).toEqual([]);
		await ws.scriptModel(privateScope, [{ text: "Fictional tedi answer" }]);
		const allowedWrite = await mcp(
			ws,
			headers(privateScope, tediId, "tedi"),
			"send_turn",
			{ text: "Authorized tedi task", waitSeconds: 1 },
		);
		expect(await allowedWrite.json()).toMatchObject({
			result: { isError: false },
		});
		// Revoking the binding affects the same already-issued caller identity.
		await testEnv.DB.prepare(
			"UPDATE tedis SET owner_user_id = 'fictional-stranger' WHERE id = ?",
		)
			.bind(tediId)
			.run();
		for (const name of ["read_events", "send_turn", "decide_approval"])
			expect((await mcp(ws, h, name)).status).toBe(403);
		await testEnv.DB.prepare(
			"UPDATE tedis SET owner_user_id = 'u1', status = 'paused' WHERE id = ?",
		)
			.bind(tediId)
			.run();
		expect((await mcp(ws, h, "read_events")).status).toBe(403);
	});
	test("another organization and an app identity confer no workspace authority", async () => {
		const { ws, privateScope } = await fixture();
		const foreignScope = {
			organizationId: "fictional-other-org",
			workspaceId: privateScope.workspaceId,
		};
		const foreign = workspace(foreignScope);
		for (const name of ["read_events", "send_turn", "decide_approval"]) {
			expect((await mcp(foreign, headers(foreignScope), name)).status).toBe(
				403,
			);
			expect(
				(
					await mcp(
						ws,
						headers(privateScope, "app:fictional", "external_agent"),
						name,
					)
				).status,
			).toBe(403);
		}
		expect(
			(
				await foreign.fetch(
					new Request("https://workspace.test/subscribe", {
						headers: { ...headers(foreignScope), Upgrade: "websocket" },
					}),
				)
			).status,
		).toBe(403);
	});
	const deniedFrames = [
		{ type: "subscribe", conversationId: null, cursor: 0 },
		{ type: "read_ledger", conversationId: "fictional-conversation" },
		{
			type: "send_turn",
			clientTurnId: "fictional-write",
			text: "Unauthorized task",
		},
		{ type: "cancel_turn", turnId: "fictional-turn" },
		{
			type: "decide_approval",
			approvalId: "fictional-approval",
			decision: "approve",
		},
		{
			type: "decide_approval",
			approvalId: "fictional-approval",
			decision: "deny",
		},
	];
	for (const change of ["revoke", "downgrade"] as const) {
		test.each(deniedFrames)(
			`an existing socket denies $type after ${change}`,
			async (frame) => {
				const { ws, privateScope } = await fixture();
				// Real pending rows make the approval test detect an unauthorized mutation.
				await runInDurableObject(ws, async (_instance, state) => {
					state.storage.sql.exec(
						"INSERT INTO approvals (approval_id, turn_id, conversation_id, step_id, binding, method, args, resource, args_hash, actor_id, actor_kind, status) VALUES ('fictional-approval','fictional-turn','fictional-conversation','step','outputs','create','{}','output','hash','u1','user','pending')",
					);
				});
				const socket = await open(ws, privateScope);
				try {
					if (change === "revoke")
						await testEnv.DB.prepare(
							"DELETE FROM os_workspace_access_edges WHERE workspace_id = ? AND target_user_id = 'fictional-builder'",
						)
							.bind(privateScope.workspaceId)
							.run();
					else
						await testEnv.DB.prepare(
							"UPDATE os_workspace_access_edges SET role = 'use' WHERE workspace_id = ? AND target_user_id = 'fictional-builder'",
						)
							.bind(privateScope.workspaceId)
							.run();
					const rejected = socketFramesUntil(
						socket,
						(event) => event.type === "error",
					);
					socket.send(JSON.stringify(frame));
					expect((await rejected).at(-1)).toMatchObject({
						type: "error",
						code: "access_denied",
					});
					expect(await ws.listConversations(privateScope)).toEqual([]);
					await runInDurableObject(ws, async (_instance, state) => {
						expect(
							state.storage.sql
								.exec<{ status: string }>(
									"SELECT status FROM approvals WHERE approval_id = 'fictional-approval'",
								)
								.one().status,
						).toBe("pending");
					});
					for (const name of ["read_events", "send_turn"])
						expect(
							(await mcp(ws, headers(privateScope, "fictional-builder"), name))
								.status,
						).toBe(403);
				} finally {
					socket.close(1000, "test complete");
				}
			},
		);
	}
	test("revocation cuts outbound events without another client frame", async () => {
		const { ws, privateScope } = await fixture();
		const socket = await open(ws, privateScope);
		const received: unknown[] = [];
		socket.addEventListener("message", (e) => received.push(e.data));
		socket.accept();
		const closed = new Promise<CloseEvent>((resolve) =>
			socket.addEventListener("close", resolve, { once: true }),
		);
		await testEnv.DB.prepare(
			"DELETE FROM os_workspace_access_edges WHERE workspace_id = ? AND target_user_id = 'fictional-builder'",
		)
			.bind(privateScope.workspaceId)
			.run();
		await ws.scriptModel(privateScope, [{ text: "Secret after revocation" }]);
		const started = await ws.sendTurn(privateScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Owner task after revocation",
		});
		expect((await closed).code).toBe(1008);
		await ws.awaitTurn(privateScope, started.turnId, 1000);
		expect(received).toEqual([]);
	});

	test("a closed socket, a failed alarm and a wake each leave a line without chat content", async () => {
		const lines: Record<string, unknown>[] = [];
		const spies = (["info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation((line: unknown) => {
				if (line && typeof line === "object")
					lines.push(line as Record<string, unknown>);
			}),
		);
		try {
			const { ws, privateScope } = await fixture();
			const socket = await open(ws, privateScope);
			socket.accept();
			const closed = new Promise<CloseEvent>((resolve) =>
				socket.addEventListener("close", resolve, { once: true }),
			);
			await testEnv.DB.prepare(
				"DELETE FROM os_workspace_access_edges WHERE workspace_id = ? AND target_user_id = 'fictional-builder'",
			)
				.bind(privateScope.workspaceId)
				.run();
			await ws.scriptModel(privateScope, [{ text: "Secret answer text" }]);
			const started = await ws.sendTurn(privateScope, {
				actorId: "u1",
				actorKind: "user",
				text: "Secret question text",
			});
			expect((await closed).code).toBe(1008);
			await ws.awaitTurn(privateScope, started.turnId, 1000);
			expect(lines).toContainEqual(
				expect.objectContaining({
					component: "workspace.object",
					event: "workspace.socket_denied",
					where: "push",
					reason: "access_denied",
					closeCode: 1008,
					workspaceId: privateScope.workspaceId,
				}),
			);

			// The alarm still fails, so the runtime retries it; the line says why.
			await runInDurableObject(ws, async (instance, state) => {
				state.storage.sql.exec("DROP TABLE change_records");
				await expect(instance.alarm!()).rejects.toThrow("change_records");
			});
			expect(lines).toContainEqual(
				expect.objectContaining({
					event: "workspace.alarm_failed",
					retryCount: 0,
					turns: { finished: 1 },
				}),
			);

			await runInDurableObject(ws, (_instance, state) =>
				state.abort("restart"),
			).catch(() => {});
			await workspace(privateScope).listConversations(privateScope);
			expect(lines).toContainEqual(
				expect.objectContaining({
					event: "workspace.woke",
					interrupted: 0,
					sockets: 0,
					turns: { finished: 1 },
				}),
			);
			expect(JSON.stringify(lines)).not.toMatch(/Secret (question|answer)/);
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
	});
});

describe("chat goes on while changes wait for approval", () => {
	const waitingScope: WorkspaceScope = {
		...scope,
		workspaceId: "11111111-1111-4111-8111-1111111111a1",
	};
	type WaitingStub = Stub & {
		readSystemPrompts(scope: WorkspaceScope): Promise<string[]>;
	};
	async function waitingWorkspace(): Promise<WaitingStub> {
		await seedCore();
		const now = "2026-11-07T10:00:00.000Z";
		await testEnv.DB.batch([
			testEnv.DB.prepare(
				`INSERT OR REPLACE INTO os_workspaces (id, organization_id, name, description, status, created_by_kind, created_by_id, created_at, updated_at, visibility) VALUES (?, ?, 'Waiting workspace', '', 'active', 'user', 'u1', ?, ?, 'org')`,
			).bind(waitingScope.workspaceId, waitingScope.organizationId, now, now),
			testEnv.DB.prepare(
				`INSERT OR REPLACE INTO os_workspace_projects (id, organization_id, workspace_id, project_id, status, created_by_kind, created_by_id, created_at) VALUES ('wp-waiting', ?, ?, 'proj1', 'active', 'user', 'u1', ?)`,
			).bind(waitingScope.organizationId, waitingScope.workspaceId, now),
		]);
		const ws = workspace(waitingScope) as WaitingStub;
		await seedOutputs(ws, waitingScope);
		return ws;
	}
	const create = (title: string) =>
		`export default async (env) => env.outputs.create({ title: ${JSON.stringify(title)}, content: { kind: "document", blocks: [] } })`;
	// Removing a block is a file change that still waits for a person.
	// A decision is remembered for the exact change, so each test removes
	// something different.
	const removeBlocks = (...indexes: number[]) =>
		`export default async (env) => { const doc = await env.documents.read({ outputId: "out-doc" }); return env.documents.edit({ outputId: doc.id, expectedRevision: doc.revision, ops: ${JSON.stringify(indexes.map((index) => ({ op: "delete", index })))} }); }`;
	const currentDoc = async (ws: WaitingStub) =>
		(await ws.outputQuery(waitingScope, { op: "get", outputId: "out-doc" }))
			?.currentRevisionId;

	test("a held removal does not stop the turn and the next turn knows it is still waiting", async () => {
		const ws = await waitingWorkspace();
		await ws.scriptModel(waitingScope, [
			{ code: removeBlocks(1) },
			{
				text: "Removing the list waits for your approval. Here is the outline meanwhile.",
			},
		]);
		const first = await ws.sendTurn(waitingScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Remove the list from Priorities and outline it",
		});
		const outcome = await ws.awaitTurn(waitingScope, first.turnId, 20_000);
		expect(outcome).toMatchObject({
			status: "finished",
			text: "Removing the list waits for your approval. Here is the outline meanwhile.",
		});
		const events = await ws.readEvents(waitingScope, {
			conversationId: first.conversationId,
			after: 0,
		});
		const requested = events.find(
			(event) => event.type === "approval.requested",
		);
		if (requested?.type !== "approval.requested")
			throw new Error("no approval card");
		expect(requested.automatic).toBeUndefined();
		const results = JSON.stringify(
			(await ws.readMessages(waitingScope, first.conversationId)).filter(
				(message) => message.role === "toolResult",
			),
		);
		expect(results).toContain("carry on with work that does not depend on it");

		await ws.scriptModel(waitingScope, [
			{ text: "The removal is still waiting." },
		]);
		const second = await ws.sendTurn(waitingScope, {
			conversationId: first.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "What else is open?",
		});
		await ws.awaitTurn(waitingScope, second.turnId, 20_000);
		const prompt = (await ws.readSystemPrompts(waitingScope)).at(-1) ?? "";
		expect(prompt).toContain("<waiting_for_approval");
		expect(prompt).toContain("- Editing document blocks: Priorities");

		const before = await currentDoc(ws);
		await ws.scriptModel(waitingScope, [{ text: "Understood." }]);
		const denied = await ws.decideApproval(waitingScope, {
			approvalId: requested.approvalId,
			decision: "deny",
			by: "u1",
		});
		expect(denied.applied).toBe(false);
		await ws.awaitTurn(waitingScope, denied.turnId!, 20_000);
		expect(await currentDoc(ws)).toBe(before);
	});

	test("a decision made while a turn works waits for it, then one turn answers", async () => {
		const ws = await waitingWorkspace();
		await ws.scriptModel(waitingScope, [
			{ code: removeBlocks(0) },
			{ text: "Removing the heading waits for your approval." },
		]);
		const first = await ws.sendTurn(waitingScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Remove the heading of Priorities",
		});
		await ws.awaitTurn(waitingScope, first.turnId, 20_000);
		const requested = (
			await ws.readEvents(waitingScope, {
				conversationId: first.conversationId,
				after: 0,
			})
		)
			.filter((event) => event.type === "approval.requested")
			.at(-1);
		if (requested?.type !== "approval.requested")
			throw new Error("no approval card");
		expect(requested.automatic).toBeUndefined();

		// The person keeps chatting; a slow answer is still streaming.
		await ws.scriptModel(waitingScope, [
			{ text: "word ".repeat(40), tokensPerSecond: 40 },
		]);
		const chat = await ws.sendTurn(waitingScope, {
			conversationId: first.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Meanwhile, summarise the plan",
		});
		const decided = await ws.decideApproval(waitingScope, {
			approvalId: requested.approvalId,
			decision: "approve",
			by: "u1",
		});
		expect(decided).toEqual({ applied: true });
		await ws.awaitTurn(waitingScope, chat.turnId, 20_000);
		const continuation = await vi.waitFor(
			async () => {
				const started = (
					await ws.readEvents(waitingScope, {
						conversationId: first.conversationId,
						after: requested.seq,
					})
				).filter(
					(event) =>
						event.type === "turn.started" && event.turnId !== chat.turnId,
				);
				expect(started).toHaveLength(1);
				return started[0]!;
			},
			{ timeout: 15_000, interval: 100 },
		);
		if (continuation.type !== "turn.started") throw new Error("no turn");
		expect(continuation.displayText).toBe("Approved the requested action.");
		expect(continuation.text).toContain("documents.edit applied:");
		await ws.awaitTurn(waitingScope, continuation.turnId, 20_000);
	});

	test("new files and edits apply at once; removing content, a new app, a web page and Work still wait", async () => {
		const ws = await waitingWorkspace();
		await testEnv.DB.batch(
			[osGadgetRevisions, osGadgetCode, osGadgetCodeBlobs].map((table) =>
				testEnv.DB.prepare(ddl(table)),
			),
		);
		// A create and an edit that removes nothing, in one reply.
		await ws.scriptModel(waitingScope, [
			{
				code: `export default async (env) => {
					const plan = await env.outputs.create({ title: "Auto plan", content: { kind: "document", blocks: [{ type: "paragraph", text: "Draft" }] } });
					return env.documents.edit({ outputId: plan.id, expectedRevision: plan.revision, ops: [{ op: "insert", index: 1, block: { type: "paragraph", text: "Second thought" } }] });
				}`,
			},
			{ text: "Created Auto plan." },
		]);
		const turn = await ws.sendTurn(waitingScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Create an Auto plan doc and add a line",
		});
		expect(await ws.awaitTurn(waitingScope, turn.turnId, 20_000)).toMatchObject(
			{ status: "finished", text: "Created Auto plan." },
		);
		const events = await ws.readEvents(waitingScope, {
			conversationId: turn.conversationId,
			after: 0,
		});
		const requested = events.flatMap((event) =>
			event.type === "approval.requested" ? [event] : [],
		);
		expect(requested.map((event) => event.title)).toEqual([
			"Creating a new output",
			"Editing document blocks",
		]);
		for (const event of requested) expect(event.automatic).toBe(true);
		const decided = events.flatMap((event) =>
			event.type === "approval.decided" ? [event] : [],
		);
		expect(decided).toHaveLength(2);
		for (const [index, event] of decided.entries())
			expect(event).toMatchObject({
				approvalId: requested[index]!.approvalId,
				decision: "approve",
				by: "u1",
				automatic: true,
			});
		const executed = events.flatMap((event) =>
			event.type === "approval.executed" ? [event] : [],
		);
		expect(executed.map((event) => event.status)).toEqual([
			"applied",
			"applied",
		]);
		expect(executed.map((event) => event.approvalId)).toEqual(
			requested.map((event) => event.approvalId),
		);
		expect(executed.map((event) => event.output?.revision)).toEqual([1, 2]);
		expect(executed[1]!.output?.outputId).toBe(executed[0]!.output?.outputId);
		// No continuation turn: the running turn got each result itself.
		expect(
			events.filter((event) => event.type === "turn.started"),
		).toHaveLength(1);
		const results = JSON.stringify(
			(await ws.readMessages(waitingScope, turn.conversationId)).filter(
				(message) => message.role === "toolResult",
			),
		);
		expect(results).toContain("Second thought");
		expect(results).not.toContain("Approval required");
		// Nobody is asked, so the activity feed must not record a request:
		// that is what tells people "needs your approval".
		const asked = (
			await testEnv.DB.prepare(
				"SELECT summary FROM workspace_feed_ledger WHERE workspace_id = ? AND entity_id = ? AND change_record_id LIKE 'workspace-event:%' ORDER BY seq",
			)
				.bind(waitingScope.workspaceId, turn.turnId)
				.all<{ summary: string }>()
		).results
			.map((row) => JSON.parse(row.summary).action.operation as string)
			.filter((operation) => operation.startsWith("approval."));
		expect(asked).toContain("approval.automatic");
		expect(asked).not.toContain("approval.requested");
		const creates = (
			await ws.readChangeRecords(waitingScope, { resource: "output" })
		).filter((record) => record.operation === "create");
		const heldAt = creates.findIndex(
			(record) => record.id === requested[0]!.approvalId,
		);
		expect(
			creates.slice(heldAt, heldAt + 2).map((record) => record.outcome),
		).toEqual(["needs_approval", "applied"]);
		const saved = await ws.outputQuery(waitingScope, {
			op: "get",
			outputId: executed[0]!.output!.outputId,
		});
		expect(saved?.title).toBe("Auto plan");
		// The next turn is not told that anything waits for a decision.
		await ws.scriptModel(waitingScope, [{ text: "Nothing is waiting." }]);
		const quiet = await ws.sendTurn(waitingScope, {
			conversationId: turn.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Is anything waiting?",
		});
		await ws.awaitTurn(waitingScope, quiet.turnId, 20_000);
		expect((await ws.readSystemPrompts(waitingScope)).at(-1)).not.toContain(
			"<waiting_for_approval",
		);

		// Filing Work, removing a block, a new app and a web page still ask.
		const appFiles = {
			"server.js": "export class App { hello() { return 'hello'; } }",
			"client.js":
				"document.getElementById('app').textContent = String(await tedix.call('app.call', { method: 'hello', args: [] }));",
			"README.md": "Says hello.",
		};
		const docBefore = await currentDoc(ws);
		const fetchesBefore = await ws.webFetchCount(waitingScope);
		await ws.scriptModel(waitingScope, [
			{
				code: `export default async (env) => env.work.create({ title: "Must not be filed without asking", description: "Outside the workspace." })`,
			},
			{ code: removeBlocks(0, 0) },
			{
				code: `export default async (env) => env.apps.create(${JSON.stringify({ name: "Must wait app", files: appFiles })})`,
			},
			{
				code: `export default async (env) => env.web.fetch("https://example.com/prices")`,
			},
			{ text: "All four wait for you." },
		]);
		const excluded = await ws.sendTurn(waitingScope, {
			actorId: "u1",
			actorKind: "user",
			text: "File a Work Item, empty Priorities, build an app and read a page",
		});
		expect(
			await ws.awaitTurn(waitingScope, excluded.turnId, 20_000),
		).toMatchObject({ status: "finished", text: "All four wait for you." });
		const later = await ws.readEvents(waitingScope, {
			conversationId: excluded.conversationId,
			after: 0,
		});
		const held = later.flatMap((event) =>
			event.type === "approval.requested" ? [event] : [],
		);
		expect(held.map((event) => event.title)).toEqual([
			"Filing a Work Item",
			"Editing document blocks",
			"Creating a new app",
			"Read example.com",
		]);
		for (const event of held) expect(event.automatic).toBeUndefined();
		expect(
			later.filter(
				(event) =>
					event.type === "approval.decided" ||
					event.type === "approval.executed",
			),
		).toHaveLength(0);
		const filed = await testEnv.DB.prepare(
			"SELECT id FROM work_items WHERE title = ?",
		)
			.bind("Must not be filed without asking")
			.all();
		expect(filed.results).toHaveLength(0);
		expect(await currentDoc(ws)).toBe(docBefore);
		const apps = await testEnv.DB.prepare(
			"SELECT id FROM os_gadgets WHERE workspace_id = ? AND name = ?",
		)
			.bind(waitingScope.workspaceId, "Must wait app")
			.all();
		expect(apps.results).toHaveLength(0);
		expect(await ws.webFetchCount(waitingScope)).toBe(fetchesBefore);

		// There is no rule to turn on: the old frame is unknown, and the
		// chat's first frame carries no rules.
		const socket = (
			await ws.fetch(
				new Request("https://workspace.test/subscribe?after=0", {
					headers: {
						Upgrade: "websocket",
						"X-Workspace-Org": waitingScope.organizationId,
						"X-Workspace-Id": waitingScope.workspaceId,
						"X-Workspace-Actor-Id": "u1",
					},
				}),
			)
		).webSocket;
		if (!socket) throw new Error("No socket");
		try {
			const refused = socketFramesUntil(
				socket,
				(frame) => frame.type === "error",
			);
			socket.send(
				JSON.stringify({
					type: "set_auto_approval",
					kind: "files",
					enabled: true,
				}),
			);
			const frames = await refused;
			expect(frames.at(-1)).toMatchObject({
				type: "error",
				code: "unknown_frame",
			});
			expect(frames.find((frame) => frame.type === "hello")).toBeDefined();
			expect(JSON.stringify(frames)).not.toContain("autoApprovals");
			expect(frames.some((frame) => frame.type === "auto_approvals")).toBe(
				false,
			);
		} finally {
			socket.close(1000, "test complete");
		}
	});
});

describe("a message sent while the agent works", () => {
	const midTurnScope = scope;
	type MidTurnStub = Stub & {
		readModelCalls(scope: WorkspaceScope): Promise<string[][]>;
		readSystemPrompts(scope: WorkspaceScope): Promise<string[]>;
	};
	function midTurnWorkspace(): MidTurnStub {
		return workspace(midTurnScope) as MidTurnStub;
	}
	const SLOW_STEP =
		"export default async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return 42; }";
	const events = (ws: Stub, conversationId: string) =>
		ws.readEvents(midTurnScope, { conversationId, after: 0 });

	test.each([false, true])(
		"reaches the working turn before its next model call and starts no second turn (isolate=%s)",
		async (isolate) => {
			await seedCore();
			const ws = midTurnWorkspace();
			const callsBefore = (await ws.readModelCalls(midTurnScope)).length;
			await ws.scriptModel(midTurnScope, [
				{ code: SLOW_STEP },
				{ text: "Done, in euros." },
			]);
			const turn = await ws.sendTurn(midTurnScope, {
				actorId: "u1",
				actorKind: "user",
				text: "Total the invoices",
				isolate,
			});
			const messageId = crypto.randomUUID();
			const added = {
				turnId: messageId,
				conversationId: turn.conversationId,
				actorId: "u1",
				actorKind: "user" as const,
				text: "Use euros, not dollars",
			};
			const queued = await ws.sendTurn(midTurnScope, added);
			expect(queued).toMatchObject({
				turnId: turn.turnId,
				conversationId: turn.conversationId,
				queued: true,
			});
			// A retried frame is the same message, not a second one.
			expect(await ws.sendTurn(midTurnScope, added)).toEqual(queued);

			expect(
				await ws.awaitTurn(midTurnScope, turn.turnId, 20_000),
			).toMatchObject({ status: "finished", text: "Done, in euros." });

			const calls = (await ws.readModelCalls(midTurnScope)).slice(callsBefore);
			expect(calls).toEqual([
				["Total the invoices"],
				["Total the invoices", "Use euros, not dollars"],
			]);
			const ledger = await events(ws, turn.conversationId);
			expect(
				ledger.filter((event) => event.type === "turn.started"),
			).toHaveLength(1);
			const about = ledger.filter(
				(event) =>
					event.type.startsWith("message.") &&
					"messageId" in event &&
					event.messageId === messageId,
			);
			expect(about.map((event) => event.type)).toEqual([
				"message.queued",
				"message.read",
			]);
			expect(about[0]).toMatchObject({
				turnId: turn.turnId,
				text: "Use euros, not dollars",
				authorId: "u1",
				authorKind: "person",
			});
			const finished = ledger.find((event) => event.type === "turn.finished");
			expect(about[1]!.seq).toBeLessThan(finished!.seq);
			expect(
				(await ws.readMessages(midTurnScope, turn.conversationId)).map(
					(message) => message.role,
				),
			).toEqual(["user", "assistant", "toolResult", "user", "assistant"]);
			expect(
				(await ws.listConversations(midTurnScope)).find(
					(row) => row.id === turn.conversationId,
				)?.running,
			).toBeUndefined();
		},
	);

	test("starts a separate turn for a guest tedi addressed while another agent works", async () => {
		await seedCore();
		const ws = midTurnWorkspace();
		await ws.scriptModel(midTurnScope, [
			{ code: SLOW_STEP },
			{ text: "Review complete." },
		]);
		const turn = await ws.sendTurn(midTurnScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Start the review",
		});
		const messageId = crypto.randomUUID();
		const queued = await ws.sendTurn(midTurnScope, {
			turnId: messageId,
			conversationId: turn.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Guest, review the notes",
			tediId: "tedi1",
		});
		expect(queued).toMatchObject({ turnId: turn.turnId, queued: true });
		expect(await ws.awaitTurn(midTurnScope, turn.turnId, 20_000)).toMatchObject(
			{
				status: "finished",
				text: "Review complete.",
			},
		);
		await vi.waitFor(
			async () => {
				expect(
					await ws.awaitTurn(midTurnScope, messageId, 20_000),
				).toMatchObject({
					status: "finished",
					text: "Review complete.",
				});
			},
			{ timeout: 30_000, interval: 100 },
		);
		expect((await ws.readSystemPrompts(midTurnScope)).at(-1)).toContain(
			"You are tedi tedi1.",
		);
		const ledger = await events(ws, turn.conversationId);
		expect(
			ledger.find((event) => event.type === "message.queued"),
		).toMatchObject({
			messageId,
			authorId: "u1",
			authorKind: "person",
		});
		expect(
			ledger.find(
				(event) => event.type === "turn.started" && event.turnId === messageId,
			),
		).toMatchObject({
			authorId: "u1",
			authorKind: "person",
		});
	});

	test("starts the next turn when the working turn ended before reading it", async () => {
		await seedCore();
		const ws = midTurnWorkspace();
		// One model call and no tool step: nothing reads a message sent now.
		await ws.scriptModel(midTurnScope, [
			{ text: "one two three four five six", tokensPerSecond: 4 },
		]);
		const turn = await ws.sendTurn(midTurnScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Count slowly",
		});
		const messageId = crypto.randomUUID();
		const queued = await ws.sendTurn(midTurnScope, {
			turnId: messageId,
			conversationId: turn.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Then count backwards",
		});
		expect(queued).toMatchObject({ turnId: turn.turnId, queued: true });
		expect(await ws.awaitTurn(midTurnScope, turn.turnId, 20_000)).toMatchObject(
			{ status: "finished" },
		);
		const next = await vi.waitFor(
			async () => {
				const outcome = await ws.awaitTurn(midTurnScope, messageId, 20_000);
				expect(outcome.status).toBe("finished");
				return outcome;
			},
			{ timeout: 30_000, interval: 100 },
		);
		expect(next.status).toBe("finished");
		const ledger = await events(ws, turn.conversationId);
		const started = ledger.filter((event) => event.type === "turn.started");
		expect(started.map((event) => event.turnId)).toEqual([
			turn.turnId,
			messageId,
		]);
		expect(started[1]).toMatchObject({
			text: "Then count backwards",
			authorId: "u1",
		});
		const firstFinished = ledger.find(
			(event) => event.type === "turn.finished" && event.turnId === turn.turnId,
		);
		// One after the other, never side by side.
		expect(started[1]!.seq).toBeGreaterThan(firstFinished!.seq);
		expect(
			ledger
				.filter((event) => event.type.startsWith("message."))
				.map((event) => event.type),
		).toEqual(["message.queued"]);
		expect(
			(await ws.readMessages(midTurnScope, turn.conversationId)).map(
				(message) => message.role,
			),
		).toEqual(["user", "assistant", "user", "assistant"]);
	});

	test("Stop hands an unread message back and starts nothing", async () => {
		await seedCore();
		const ws = midTurnWorkspace();
		await ws.scriptModel(midTurnScope, [
			{ text: "one two three four five six seven eight", tokensPerSecond: 1 },
		]);
		const turn = await ws.sendTurn(midTurnScope, {
			actorId: "u1",
			actorKind: "user",
			text: "Count very slowly",
		});
		const messageId = crypto.randomUUID();
		await ws.sendTurn(midTurnScope, {
			turnId: messageId,
			conversationId: turn.conversationId,
			actorId: "u1",
			actorKind: "user",
			text: "Skip the odd numbers",
		});
		expect(await ws.cancelTurn(midTurnScope, turn.turnId)).toBe(true);
		expect(await ws.awaitTurn(midTurnScope, turn.turnId, 5_000)).toMatchObject({
			status: "cancelled",
		});
		// Long enough for a turn that should not exist to have started.
		await new Promise((resolve) => setTimeout(resolve, 300));
		const ledger = await events(ws, turn.conversationId);
		expect(
			ledger.filter((event) => event.type === "turn.started"),
		).toHaveLength(1);
		const returned = ledger.find((event) => event.type === "message.returned");
		expect(returned).toMatchObject({
			messageId,
			turnId: turn.turnId,
			text: "Skip the odd numbers",
		});
		const finished = ledger.find((event) => event.type === "turn.finished");
		expect(returned!.seq).toBeLessThan(finished!.seq);
		expect(
			JSON.stringify(await ws.readMessages(midTurnScope, turn.conversationId)),
		).not.toContain("Skip the odd numbers");
	});
});

describe("managing conversations", () => {
	async function fixture() {
		await seedCore();
		const privateScope = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([privateScope]);
		await testEnv.DB.prepare(
			"UPDATE os_workspaces SET visibility = 'private', owner_user_id = 'u1' WHERE id = ?",
		)
			.bind(privateScope.workspaceId)
			.run();
		await grantOsWorkspaceAccess(createDbQueryClient(testEnv.DB), {
			...privateScope,
			now: "2026-11-15T00:00:00Z",
			edges: [
				{
					kind: "user",
					targetUserId: "fictional-builder",
					targetEmail: null,
					targetName: null,
					sharerUserId: "u1",
					role: "build",
				},
			],
		});
		const ws = workspace(privateScope);
		await seedOutputs(ws, privateScope);
		const say = async (text: string) => {
			await ws.scriptModel(privateScope, [{ text: `Answer to ${text}` }]);
			const started = await ws.sendTurn(privateScope, {
				actorId: "u1",
				actorKind: "user",
				text,
			});
			await ws.awaitTurn(privateScope, started.turnId, 20_000);
			return started.conversationId;
		};
		return { ws, privateScope, say };
	}
	/** An open chat that follows one conversation, or none. */
	async function chat(
		ws: Stub,
		privateScope: WorkspaceScope,
		conversationId: string | null,
	) {
		const response = await ws.fetch(
			new Request("https://workspace.test/subscribe", {
				headers: {
					Upgrade: "websocket",
					"X-Workspace-Org": privateScope.organizationId,
					"X-Workspace-Id": privateScope.workspaceId,
					"X-Workspace-Actor-Id": "fictional-builder",
					"X-Workspace-Actor-Kind": "user",
				},
			}),
		);
		expect(response.status).toBe(101);
		const socket = response.webSocket;
		if (!socket) throw new Error("No socket");
		const frames: Record<string, unknown>[] = [];
		socket.addEventListener("message", (event) =>
			frames.push(JSON.parse(String(event.data)) as Record<string, unknown>),
		);
		socket.accept();
		const send = (frame: Record<string, unknown>) =>
			socket.send(JSON.stringify(frame));
		const got = (frame: Record<string, unknown>) =>
			vi.waitFor(() =>
				expect(frames).toContainEqual(expect.objectContaining(frame)),
			);
		send({ type: "subscribe", conversationId, cursor: null });
		await got({ type: "caught_up" });
		return {
			frames,
			send,
			got,
			/** What the object says to a chat that connects now. */
			async hello() {
				frames.length = 0;
				send({ type: "subscribe", conversationId, cursor: null });
				await got({ type: "caught_up" });
				return frames.find((frame) => frame.type === "hello") as {
					conversations: Array<Record<string, unknown>>;
					archived: Array<Record<string, unknown>>;
				};
			},
			close: () => socket.close(1000, "test complete"),
		};
	}

	test("a rename, an archive and a restore reach every open chat", async () => {
		const { ws, privateScope, say } = await fixture();
		const first = await say("Plan the launch");
		const second = await say("Draft the budget");
		const here = await chat(ws, privateScope, first);
		const elsewhere = await chat(ws, privateScope, second);
		try {
			here.send({
				type: "rename_conversation",
				conversationId: first,
				title: "  Launch   plan  ",
			});
			for (const open of [here, elsewhere])
				await open.got({
					type: "conversation.updated",
					conversationId: first,
					title: "Launch plan",
				});
			expect(
				(await ws.listConversations(privateScope)).find(
					(row) => row.id === first,
				)?.title,
			).toBe("Launch plan");

			here.send({
				type: "rename_conversation",
				conversationId: first,
				title: " ",
			});
			await here.got({ type: "error", message: "A conversation needs a name" });

			elsewhere.send({
				type: "archive_conversation",
				conversationId: first,
				archived: true,
			});
			for (const open of [here, elsewhere])
				await open.got({
					type: "conversation.updated",
					conversationId: first,
					archivedAt: expect.any(String),
				});
			expect(
				(await ws.listConversations(privateScope)).map((row) => row.id),
			).toEqual([second]);
			const archived = await elsewhere.hello();
			expect(archived.conversations.map((row) => row.id)).toEqual([second]);
			expect(archived.archived).toEqual([
				expect.objectContaining({
					id: first,
					title: "Launch plan",
					archivedAt: expect.any(String),
				}),
			]);

			here.send({
				type: "archive_conversation",
				conversationId: first,
				archived: false,
			});
			await elsewhere.got({
				type: "conversation.updated",
				conversationId: first,
				archivedAt: null,
			});
			const restored = await elsewhere.hello();
			expect(restored.archived).toEqual([]);
			expect(restored.conversations.map((row) => row.id).sort()).toEqual(
				[first, second].sort(),
			);
		} finally {
			here.close();
			elsewhere.close();
		}
	});

	test("the list says how many changes wait for a decision", async () => {
		const { ws, privateScope, say } = await fixture();
		const conversationId = await say("Plan the launch");
		await runInDurableObject(ws, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO approvals (approval_id, turn_id, conversation_id, step_id, binding, method, args, resource, args_hash, actor_id, actor_kind, status) VALUES ('fictional-approval','fictional-turn',?,'step','outputs','create','{}','output','hash','u1','user','pending')",
				conversationId,
			);
		});
		expect(await ws.listConversations(privateScope)).toEqual([
			expect.objectContaining({ id: conversationId, pendingApprovals: 1 }),
		]);
	});

	test("a delete removes the conversation for good and tells every open chat", async () => {
		const { ws, privateScope, say } = await fixture();
		const kept = await say("Draft the budget");
		const gone = await say("Plan the launch");
		const here = await chat(ws, privateScope, gone);
		const elsewhere = await chat(ws, privateScope, kept);
		try {
			await runInDurableObject(ws, async (_instance, state) => {
				state.storage.sql.exec(
					"INSERT INTO turns (turn_id, conversation_id, started_at, status, actor_id, actor_kind) VALUES ('fictional-working', ?, '2026-11-18T00:00:00Z', 'running', 'u1', 'user')",
					gone,
				);
			});
			here.send({ type: "delete_conversation", conversationId: gone });
			await here.got({
				type: "error",
				message: "Stop the reply before you delete this conversation",
			});
			await runInDurableObject(ws, async (_instance, state) => {
				state.storage.sql.exec(
					"DELETE FROM turns WHERE turn_id = 'fictional-working'",
				);
			});

			here.send({ type: "delete_conversation", conversationId: gone });
			for (const open of [here, elsewhere])
				await open.got({ type: "conversation.deleted", conversationId: gone });
			expect(
				(await ws.listConversations(privateScope)).map((row) => row.id),
			).toEqual([kept]);
			expect(
				await ws.readEvents(privateScope, { conversationId: gone, after: 0 }),
			).toEqual([]);
			await runInDurableObject(ws, async (_instance, state) => {
				for (const table of ["messages", "turns", "approvals"])
					expect(
						state.storage.sql
							.exec(`SELECT 1 FROM ${table} WHERE conversation_id = ?`, gone)
							.toArray(),
					).toEqual([]);
				expect(
					state.storage.sql
						.exec("SELECT 1 FROM messages WHERE conversation_id = ?", kept)
						.toArray().length,
				).toBeGreaterThan(0);
			});
			const hello = await elsewhere.hello();
			expect(hello.conversations.map((row) => row.id)).toEqual([kept]);
			expect(hello.archived).toEqual([]);

			here.send({ type: "delete_conversation", conversationId: gone });
			await here.got({ type: "error", message: "Unknown conversation" });
		} finally {
			here.close();
			elsewhere.close();
		}
	});

	test.each([
		{ type: "rename_conversation", title: "Taken over" },
		{ type: "archive_conversation", archived: true },
		{ type: "delete_conversation" },
	])("a person who can only view is refused $type", async (frame) => {
		const { ws, privateScope, say } = await fixture();
		const conversationId = await say("Plan the launch");
		const viewer = await chat(ws, privateScope, null);
		try {
			await testEnv.DB.prepare(
				"UPDATE os_workspace_access_edges SET role = 'use' WHERE workspace_id = ? AND target_user_id = 'fictional-builder'",
			)
				.bind(privateScope.workspaceId)
				.run();
			viewer.send({ ...frame, conversationId });
			await viewer.got({ type: "error", code: "access_denied" });
			expect(await ws.listConversations(privateScope)).toEqual([
				expect.objectContaining({
					id: conversationId,
					title: "Plan the launch",
				}),
			]);
		} finally {
			viewer.close();
		}
	});
});
describe("document transfer primitive", () => {
	async function fixture() {
		await seedCore();
		const source = { ...scope, workspaceId: crypto.randomUUID() };
		const target = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([source, target]);
		const from = workspace(source),
			to = workspace(target);
		await from.outputQuery(source, { op: "initialize" });
		await seedOutputs(to, target);
		const outputId = crypto.randomUUID();
		const body = await storeOutputBody(
			testEnv.R2_BUCKET,
			source.organizationId,
			'{"kind":"document","blocks":[]}',
		);
		await from.outputQuery(source, {
			op: "create",
			output: {
				id: outputId,
				...source,
				title: "Transfer",
				kind: "document",
				currentRevisionId: `${outputId}-1`,
				createdByKind: "user",
				createdById: "u1",
			},
			revision: {
				id: `${outputId}-1`,
				organizationId: source.organizationId,
				outputId,
				revision: 1,
				content: "",
				...body,
				createdByKind: "user",
				createdById: "u1",
			},
		});
		const nextBody = await storeOutputBody(
			testEnv.R2_BUCKET,
			source.organizationId,
			'{"kind":"document","blocks":[{"type":"paragraph","text":"Second revision"}]}',
		);
		const revised = await from.outputQuery(source, {
			op: "revise",
			params: {
				id: `${outputId}-2`,
				organizationId: source.organizationId,
				outputId,
				expectedRevision: 1,
				...nextBody,
				createdByKind: "user",
				createdById: "u1",
			},
		});
		expect(revised).toMatchObject({
			ok: true,
			revision: { id: `${outputId}-2`, revision: 2 },
		});
		const transfer = {
			transferId: crypto.randomUUID(),
			outputId,
			sourceWorkspaceId: source.workspaceId,
			targetWorkspaceId: target.workspaceId,
		};
		return { source, target, from, to, transfer, body };
	}

	test("retries each step across eviction and keeps the destination readable before source removal", async () => {
		const { source, target, from, to, transfer, body } = await fixture();
		const payload = await from.prepareDocumentTransfer(source, transfer);
		await evictDurableObject(from);
		expect(await from.prepareDocumentTransfer(source, transfer)).toEqual(
			payload,
		);
		await to.importDocumentTransfer(target, payload);
		const receipt = await runInDurableObject(to, async (_instance, state) =>
			state.storage.kv.get<Record<string, unknown>>(
				`document-transfer-import:${transfer.transferId}`,
			),
		);
		expect(Object.keys(receipt!).sort()).toEqual([
			"payloadSha256",
			"snapshot",
			"transfer",
		]);
		expect(JSON.stringify(receipt).length).toBeLessThan(
			JSON.stringify(payload).length,
		);
		const conflicting = structuredClone(payload);
		conflicting.batches[0]!.rows[0]!.title = "Tampered batch";
		await expect(() =>
			to.importDocumentTransfer(target, conflicting),
		).rejects.toThrow("conflicts with its receipt");
		expect(
			await from.prepareDocumentTransfer(source, {
				targetWorkspaceId: transfer.targetWorkspaceId,
				sourceWorkspaceId: transfer.sourceWorkspaceId,
				outputId: transfer.outputId,
				transferId: transfer.transferId,
			}),
		).toEqual(payload);
		await evictDurableObject(to);
		await to.importDocumentTransfer(target, payload);
		expect(await to.confirmDocumentTransfer(target, transfer)).toEqual(
			payload.snapshot,
		);
		await expect(() =>
			from.removeDocumentTransfer(source, transfer),
		).rejects.toThrow("index is not repointed");
		const { repointDocumentTransferIndex } =
			await import("@tedix/db/queries/workspace-feed/document-transfer");
		const core = createDbQueryClient(testEnv.DB);
		await repointDocumentTransferIndex(core, source.organizationId, payload);
		await repointDocumentTransferIndex(core, source.organizationId, payload);
		await from.prepareDocumentTransfer(source, transfer);
		await to.confirmDocumentTransfer(target, transfer);
		await evictDurableObject(from);
		await evictDurableObject(to);
		expect(
			await from.outputQuery(source, {
				op: "get",
				outputId: transfer.outputId,
			}),
		).toBeDefined();
		expect(
			await to.outputQuery(target, { op: "get", outputId: transfer.outputId }),
		).toMatchObject({
			workspaceId: target.workspaceId,
			currentRevisionId: `${transfer.outputId}-2`,
		});
		expect(payload.snapshot.revisions).toHaveLength(2);
		for (const revision of payload.snapshot.revisions) {
			expect(
				await to.outputQuery(target, {
					op: "revision",
					revisionId: revision.id,
				}),
			).toMatchObject({ bodyR2Key: revision.bodyR2Key });
		}
		await expect(() =>
			from.outputQuery(source, {
				op: "update",
				outputId: transfer.outputId,
				patch: { title: "Blocked" },
			}),
		).rejects.toThrow("transfer in progress");
		await expect(() =>
			to.outputQuery(target, { op: "delete", outputId: transfer.outputId }),
		).rejects.toThrow("transfer in progress");
		await expect(() =>
			from.outputQuery(source, {
				op: "rebody",
				revisionId: `${transfer.outputId}-1`,
				previousSha256: body.contentSha256,
				bodyR2Key: "other-body",
				contentSha256: "a".repeat(64),
				contentBytes: 10,
			}),
		).rejects.toThrow("transfer in progress");
		await from.removeDocumentTransfer(source, transfer);
		await from.removeDocumentTransfer(source, transfer);
		expect(
			await from.outputQuery(source, {
				op: "get",
				outputId: transfer.outputId,
			}),
		).toBeUndefined();
		expect(
			await from.outputQuery(source, {
				op: "history",
				outputId: transfer.outputId,
			}),
		).toEqual([]);
		expect(
			(await from.prepareDocumentTransfer(source, transfer)).completed,
		).toBe(true);
		expect(
			(await from.prepareDocumentTransfer(source, transfer)).batches,
		).toEqual([]);
		await to.outputQuery(target, {
			op: "update",
			outputId: transfer.outputId,
			patch: { title: "After move" },
		});
		const back = {
			...transfer,
			transferId: crypto.randomUUID(),
			sourceWorkspaceId: target.workspaceId,
			targetWorkspaceId: source.workspaceId,
		};
		const returning = await to.prepareDocumentTransfer(target, back);
		await from.importDocumentTransfer(source, returning);
		await repointDocumentTransferIndex(core, source.organizationId, returning);
		await to.removeDocumentTransfer(target, back);
		// A delayed removal retry must not delete the document that has returned.
		await from.removeDocumentTransfer(source, transfer);
		expect(
			await from.outputQuery(source, {
				op: "get",
				outputId: transfer.outputId,
			}),
		).toMatchObject({ title: "After move" });
	});

	test("destination conflict rolls back imports and leaves source and index intact", async () => {
		const { source, target, from, to, transfer, body } = await fixture();
		await to.outputQuery(target, {
			op: "create",
			output: {
				id: transfer.outputId,
				...target,
				kind: "document",
				title: "Conflicting",
				currentRevisionId: "conflicting-revision",
				createdByKind: "user",
				createdById: "u1",
			},
			revision: {
				id: "conflicting-revision",
				organizationId: target.organizationId,
				outputId: transfer.outputId,
				revision: 1,
				content: "",
				...body,
				createdByKind: "user",
				createdById: "u1",
			},
		});
		const before = await testEnv.DB.prepare(
			"SELECT * FROM workspace_output_index WHERE output_id = ?",
		)
			.bind(transfer.outputId)
			.all();
		const payload = await from.prepareDocumentTransfer(source, transfer);
		await expect(() =>
			to.importDocumentTransfer(target, payload),
		).rejects.toThrow();
		await expect(() =>
			to.confirmDocumentTransfer(target, transfer),
		).rejects.toThrow("not confirmed");
		await expect(() =>
			from.removeDocumentTransfer(source, transfer),
		).rejects.toThrow("not confirmed");
		expect(
			await from.outputQuery(source, {
				op: "get",
				outputId: transfer.outputId,
			}),
		).toBeDefined();
		expect(
			(
				await testEnv.DB.prepare(
					"SELECT * FROM workspace_output_index WHERE output_id = ?",
				)
					.bind(transfer.outputId)
					.all()
			).results,
		).toEqual(before.results);
	});
});

describe("empty document owners", () => {
	test("refuses files before initialization, then initializes once and survives eviction", async () => {
		await seedCore();
		const empty = { ...scope, workspaceId: "empty-owner" };
		await createDbQueryClient(testEnv.DB).insert(osWorkspaces).values({
			id: empty.workspaceId,
			organizationId: empty.organizationId,
			name: "Empty owner",
			createdByKind: "user",
			createdById: "u1",
		});
		const ws = workspace(empty);
		expect(await ws.outputQuery(empty, { op: "authority" })).toBe("shared");
		await expect(() => ws.outputQuery(empty, { op: "purge" })).rejects.toThrow(
			"does not own",
		);
		expect(await ws.outputQuery(empty, { op: "initialize" })).toBe("object");
		await evictDurableObject(ws);
		expect(await ws.outputQuery(empty, { op: "initialize" })).toBe("object");
		expect(await ws.outputQuery(empty, { op: "authority" })).toBe("object");
		expect(await ws.outputQuery(empty, { op: "list" })).toEqual([]);
	});
});

test("keeps a document placement plan through eviction and a changed candidate list", async () => {
	await seedCore();
	const empty = { ...scope, workspaceId: "placement-owner" };
	await createDbQueryClient(testEnv.DB).insert(osWorkspaces).values({
		id: empty.workspaceId,
		organizationId: empty.organizationId,
		name: "Placement owner",
		createdByKind: "user",
		createdById: "u1",
	});
	const ws = workspace(empty);
	await ws.outputQuery(empty, { op: "initialize" });
	const documents = [
		{
			transferId: "save:doc",
			outputId: "doc",
			sourceWorkspaceId: scope.workspaceId,
			targetWorkspaceId: empty.workspaceId,
		},
	];
	expect(
		await ws.outputQuery(empty, {
			op: "placementPlan",
			planId: "save",
			documents,
		}),
	).toEqual(documents);
	await evictDurableObject(ws);
	expect(
		await ws.outputQuery(empty, {
			op: "placementPlan",
			planId: "save",
			documents: [],
		}),
	).toEqual(documents);
	const next = {
		...documents[0]!,
		outputId: "second",
		transferId: "save:second",
	};
	expect(
		await ws.outputQuery(empty, {
			op: "placementPlan",
			planId: "save",
			documents: [
				{ ...documents[0]!, sourceWorkspaceId: "changed-candidate" },
				next,
			],
		}),
	).toEqual([...documents, next]);
});

test("requires EU placement and routes initialization through that namespace", async () => {
	const calls: string[] = [];
	const runtimeEnv = {
		DO_JURISDICTION: "eu",
		WORKSPACE: {
			jurisdiction(value: string) {
				calls.push(value);
				return {
					getByName(name: string) {
						calls.push(name);
						return {
							async outputQuery(bound: WorkspaceScope, query: { op: string }) {
								expect(bound).toEqual(scope);
								expect(query.op).toBe("initialize");
								return "object";
							},
						};
					},
				};
			},
		},
	} as unknown as WorkspaceEnv;
	const service = new InternalEntrypoint(createExecutionContext(), runtimeEnv);
	expect(await service.outputQuery(scope, { op: "initialize" })).toBe("object");
	expect(calls).toEqual(["eu", `${scope.organizationId}:${scope.workspaceId}`]);
	const unconfigured = new InternalEntrypoint(createExecutionContext(), {
		...runtimeEnv,
		DO_JURISDICTION: "",
	});
	expect(() => unconfigured.outputQuery(scope, { op: "initialize" })).toThrow(
		"requires EU jurisdiction",
	);
	expect(calls).toHaveLength(2);
	const local = new InternalEntrypoint(createExecutionContext(), {
		...runtimeEnv,
		DO_JURISDICTION: "",
		ENVIRONMENT: "development",
		WORKSPACE: {
			getByName: () => ({ outputQuery: async () => "object" }),
		},
	} as unknown as WorkspaceEnv);
	expect(await local.outputQuery(scope, { op: "initialize" })).toBe("object");
});

describe("workspace index ownership", () => {
	test("an initialized empty owner writes and projects its first document", async () => {
		await seedCore();
		const fresh = { ...scope, workspaceId: crypto.randomUUID() };
		await seedWorkspaceRows([fresh]);
		const ws = workspace(fresh);
		expect(await ws.outputQuery(fresh, { op: "authority" })).toBe("shared");
		await ws.outputQuery(fresh, { op: "initialize" });
		const outputId = crypto.randomUUID(),
			revisionId = crypto.randomUUID();
		const body = await storeOutputBody(
			testEnv.R2_BUCKET,
			fresh.organizationId,
			'{"kind":"document","blocks":[]}',
		);
		await ws.outputQuery(fresh, {
			op: "create",
			output: {
				id: outputId,
				organizationId: fresh.organizationId,
				workspaceId: fresh.workspaceId,
				kind: "document",
				title: "First",
				currentRevisionId: revisionId,
				createdByKind: "user",
				createdById: "u1",
			},
			revision: {
				id: revisionId,
				organizationId: fresh.organizationId,
				outputId,
				revision: 1,
				content: "",
				...body,
				createdByKind: "user",
				createdById: "u1",
			},
		});
		await ws.refreshOutputProjection(fresh, outputId);
		expect(
			await getWorkspaceOutputIndexCurrent(createDbQueryClient(testEnv.DB), {
				organizationId: fresh.organizationId,
				outputId,
			}),
		).toMatchObject({
			workspaceId: fresh.workspaceId,
			revisionId,
			title: "First",
		});
	});
});

test("purges object documents, revisions and resources in one retryable RPC", async () => {
	await seedCore();
	const purgeScope = {
		organizationId: "org_test",
		workspaceId: crypto.randomUUID(),
	};
	await seedWorkspaceRows([purgeScope]);
	const ws = workspace(purgeScope);
	await ws.importRows(purgeScope, {
		batchId: "purge-directory",
		table: "os_workspaces",
		rows: [
			{
				id: purgeScope.workspaceId,
				organization_id: purgeScope.organizationId,
				name: "Purge",
				status: "archived",
				visibility: "private",
				owner_user_id: "u1",
				created_by_kind: "user",
				created_by_id: "u1",
				created_at: "2026-11-13T00:00:00Z",
				updated_at: "2026-11-13T00:00:00Z",
			},
		],
	});
	await seedOutputs(ws, purgeScope);
	await ws.outputQuery(purgeScope, {
		op: "resources",
		query: {
			operation: "create",
			params: {
				...purgeScope,
				id: "purge-resource",
				providerId: "example",
				connectionScope: "tenant",
				resourceType: "document",
				providerResourceId: "example",
				name: "Example",
				createdByKind: "user",
				createdById: "u1",
			},
		},
	});
	await runInDurableObject(ws, async (_instance, state) => {
		state.storage.sql.exec(
			"CREATE TRIGGER fail_resource_delete BEFORE DELETE ON os_workspace_resources BEGIN SELECT RAISE(ABORT, 'purge blocked'); END",
		);
	});
	const failure = await runInDurableObject(ws, async (instance) => {
		try {
			await (instance as unknown as WorkspaceRpc).outputQuery(purgeScope, {
				op: "purge",
			});
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	});
	expect(failure).toContain('delete from "os_workspace_resources"');
	expect(await ws.outputQuery(purgeScope, { op: "list" })).toHaveLength(2);
	expect(
		await ws.outputQuery(purgeScope, { op: "history", outputId: "out-doc" }),
	).toHaveLength(1);
	await runInDurableObject(ws, async (_instance, state) => {
		state.storage.sql.exec("DROP TRIGGER fail_resource_delete");
	});
	await ws.outputQuery(purgeScope, { op: "purge" });
	await ws.outputQuery(purgeScope, { op: "purge" });
	expect(await ws.outputQuery(purgeScope, { op: "authority" })).toBe("object");
	expect(await ws.outputQuery(purgeScope, { op: "list" })).toEqual([]);
	expect(
		await ws.outputQuery(purgeScope, { op: "history", outputId: "out-doc" }),
	).toEqual([]);
	expect(
		await ws.outputQuery(purgeScope, {
			op: "resources",
			query: {
				operation: "get",
				params: { ...purgeScope, resourceId: "purge-resource" },
			},
		}),
	).toBeUndefined();
	await evictDurableObject(ws);
	expect(await ws.outputQuery(purgeScope, { op: "authority" })).toBe("object");
	await ws.outputQuery(purgeScope, { op: "purge" });
	expect(await ws.outputQuery(purgeScope, { op: "list" })).toEqual([]);
});

test("sandbox memory uses SQL revisions, trusted provenance, review approval and rollback", async () => {
	await seedCore();
	const own = { ...scope, workspaceId: crypto.randomUUID() };
	await seedWorkspaceRows([own]);
	const ws = workspace(own);
	const revisions = () =>
		runInDurableObject(ws, async (_instance, state) =>
			state.storage.sql
				.exec<{ record: string }>(
					"SELECT record FROM workspace_memory_revisions WHERE key = 'language' ORDER BY revision",
				)
				.toArray()
				.map(
					(row) =>
						JSON.parse(
							row.record,
						) as import("@tedix/agent-governance/types").MemoryRevision,
				),
		);
	const ask = async (code: string) => {
		await ws.scriptModel(own, [{ code }]);
		const turn = await ws.sendTurn(own, {
			actorId: "u1",
			actorKind: "user",
			text: "Update workspace memory",
		});
		await ws.awaitTurn(own, turn.turnId, 20_000);
		const events = await ws.readEvents(own, {
			conversationId: turn.conversationId,
		});
		const approval = events.find(
			(event) => event.type === "approval.requested",
		);
		if (approval?.type !== "approval.requested")
			throw new Error(`Missing memory approval: ${JSON.stringify(events)}`);
		return { turn, approval };
	};
	const decide = async (
		approvalId: string,
		decision: "approve" | "deny" = "approve",
	) => {
		await ws.scriptModel(own, [{ text: "Decision recorded." }]);
		const result = await ws.decideApproval(own, {
			approvalId,
			decision,
			by: "u1",
		});
		if (result.turnId) await ws.awaitTurn(own, result.turnId, 20_000);
		return result;
	};
	const first = await ask(
		`export default async env => env.memory.write({key:"language",value:"German",review:"approved",provenance:{actor:{id:"forged"},source:{surface:"forged"}}})`,
	);
	expect(first.approval.automatic).toBeUndefined();
	expect(await revisions()).toEqual([]);
	expect((await decide(first.approval.approvalId)).applied).toBe(true);
	const [pending] = await revisions();
	expect(pending).toMatchObject({
		value: "German",
		review: "pending",
		provenance: {
			actor: { id: "u1", kind: "user", organizationId: own.organizationId },
			source: { surface: "workspace_object", traceId: first.turn.turnId },
		},
	});
	const approve = await ask(
		`export default async env => { const entry = await env.memory.read("language"); return env.memory.review({revisionId:entry.current.revisionId,decision:"approve",note:"Checked"}); }`,
	);
	expect((await revisions())[0]?.review).toBe("pending");
	expect((await decide(approve.approval.approvalId)).applied).toBe(true);
	expect((await revisions())[0]).toMatchObject({
		review: "approved",
		reviewedBy: "u1",
		reviewNote: "Checked",
	});

	const denied = await ask(
		`export default async env => env.memory.write({key:"language",value:"never saved"})`,
	);
	expect((await decide(denied.approval.approvalId, "deny")).applied).toBe(
		false,
	);
	expect(await revisions()).toHaveLength(1);
	const second = await ask(
		`export default async env => env.memory.write({key:"language",value:"wrong"})`,
	);
	expect((await decide(second.approval.approvalId)).applied).toBe(true);
	const reject = await ask(
		`export default async env => { const entry = await env.memory.read("language"); return env.memory.review({revisionId:entry.current.revisionId,decision:"reject"}); }`,
	);
	expect((await decide(reject.approval.approvalId)).applied).toBe(true);
	expect((await revisions())[1]?.review).toBe("rejected");
	const rollback = await ask(
		`export default async env => { const history = await env.memory.history("language"); return env.memory.rollback({key:"language",toRevisionId:history[0].revisionId}); }`,
	);
	expect((await decide(rollback.approval.approvalId)).applied).toBe(true);
	await evictDurableObject(ws);
	const history = await revisions();
	expect(history).toHaveLength(3);
	expect(history[2]).toMatchObject({
		value: "German",
		review: "approved",
		rolledBackFrom: pending!.revisionId,
		provenance: { source: { traceId: rollback.turn.turnId } },
	});
	await ws.scriptModel(own, [
		{ code: `export default async env => env.memory.list("lang")` },
	]);
	const read = await ws.sendTurn(own, {
		actorId: "u1",
		actorKind: "user",
		text: "Read memory",
	});
	await ws.awaitTurn(own, read.turnId, 20_000);
	const readEvents = await ws.readEvents(own, {
		conversationId: read.conversationId,
	});
	expect(readEvents.some((event) => event.type === "approval.requested")).toBe(
		false,
	);
	expect(
		readEvents.some(
			(event) => event.type === "step.finished" && event.status === "error",
		),
	).toBe(false);
	const records = await ws.readChangeRecords(own, { resource: "memory" });
	for (const operation of [
		"write",
		"review",
		"rollback",
		"list",
		"read",
		"history",
	])
		expect(
			records.some(
				(record) =>
					record.operation === operation && record.outcome === "applied",
			),
		).toBe(true);
	expect(
		records.find(
			(record) => record.operation === "write" && record.outcome === "applied",
		)?.after?.revisionId,
	).toBe(pending!.revisionId);
});
