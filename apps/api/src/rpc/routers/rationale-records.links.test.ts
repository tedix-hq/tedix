/**
 * decision↔execution coupling tests.
 *
 * Verifies the two hard invariants on the rationale write path:
 * 1. `create` (write_rationale) REJECTS records with no execution link
 *    (runId / workItemId / toolCallRefs) with a typed BAD_REQUEST.
 * 2. `complete` (complete_rationale) maps a proof-less `success` claim to
 *    `unverified`, never `success` — and keeps `success` when a
 *    span-checkable proofRef is provided.
 *
 * Runs the real contract router against an in-memory sqlite D1 facade
 * (same harness as work-items.test.ts); integrations are stubbed.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { rationaleRecordsContractRouter } from "./rationale-records";

vi.mock("./cognitive-runtime", () => ({
	insertRuntimeEvent: vi.fn(async () => {}),
	resolveTediRuntimeBackend: vi.fn(async () => "cloudflare-agents"),
}));

vi.mock("@tedix/db/queries/memory-graph/optimization-signals", () => ({
	createOptimizationSignal: vi.fn(async () => {}),
	findOpenOptimizationSignal: vi.fn(async () => null),
}));

vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	getFactsByIds: vi.fn(async () => []),
	recordFactAccess: vi.fn(async () => {}),
	recordFactUsage: vi.fn(async () => {}),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TEDI_ID = "44444444-4444-4444-8444-444444444444";

const RATIONALE_DDL = `
CREATE TABLE tedi_rationale_records (
	id TEXT PRIMARY KEY,
	tedi_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	action TEXT NOT NULL,
	rationale TEXT NOT NULL,
	category TEXT NOT NULL DEFAULT 'custom',
	confidence REAL NOT NULL DEFAULT 0.5,
	evidence TEXT NOT NULL DEFAULT '{}',
	outcome TEXT,
	outcome_status TEXT NOT NULL DEFAULT 'pending',
	approval_request_id TEXT,
	objective_id TEXT,
	run_id TEXT,
	work_item_id TEXT,
	tool_call_refs TEXT,
	proof_ref TEXT,
	created_at TEXT NOT NULL,
	completed_at TEXT,
	blame_chain TEXT
);
`;

function d1Facade(db: DatabaseSync): D1Database {
	const wrap = (sql: string) => {
		const stmt = db.prepare(sql);
		let bound: Array<null | number | bigint | string | Uint8Array> = [];
		const prepared = {
			bind: (...vals: unknown[]) => {
				bound = vals as Array<null | number | bigint | string | Uint8Array>;
				return prepared;
			},
			all: async () => ({
				results: stmt.all(...bound),
				success: true,
				meta: {},
			}),
			run: async () => {
				const result = stmt.run(...bound);
				return {
					success: true,
					meta: {
						changes: Number(result.changes),
						last_row_id: Number(result.lastInsertRowid),
						duration: 0,
					},
				};
			},
			first: async (col?: string) => {
				const row = stmt.get(...bound) as Record<string, unknown> | undefined;
				return col ? (row?.[col] ?? null) : (row ?? null);
			},
			raw: async () =>
				(stmt.all(...bound) as Array<Record<string, unknown>>).map((row) =>
					Object.values(row),
				),
		};
		return prepared;
	};

	return {
		prepare: wrap,
		batch: async (stmts: Array<{ all: () => Promise<unknown> }>) =>
			Promise.all(stmts.map((stmt) => stmt.all())),
		exec: async (sql: string) => {
			db.exec(sql);
			return { count: 0, duration: 0 };
		},
		dump: async () => new ArrayBuffer(0),
	} as unknown as D1Database;
}

let sqlite: DatabaseSync;
let client: ReturnType<typeof makeClient>;

function makeContext(): BaseContext {
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: createDbClient(d1Facade(sqlite)) as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/rationale-records"),
		waitUntil: () => {},
	} as unknown as BaseContext;
}

function makeClient() {
	return createRouterClient(rationaleRecordsContractRouter, {
		context: makeContext(),
	});
}

function baseCreateInput() {
	return {
		tediId: TEDI_ID,
		orgId: ORG_ID,
		action: "Deploy Tedix OS frontend",
		rationale: "Ship the validated Tedix OS patch to production",
		category: "deployment" as const,
		confidence: 0.9,
		evidence: {},
	};
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(RATIONALE_DDL);
	client = makeClient();
});

describe("write_rationale execution-link invariant", () => {
	it("rejects an unlinked write with a typed BAD_REQUEST", async () => {
		await expect(client.create(baseCreateInput())).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("UNLINKED_RATIONALE"),
		});
		const count = sqlite
			.prepare("SELECT count(*) AS cnt FROM tedi_rationale_records")
			.get() as {
			cnt: number;
		};
		expect(count.cnt).toBe(0);
	});

	it("accepts a runId-linked write and persists the links", async () => {
		const record = await client.create({
			...baseCreateInput(),
			runId: `${TEDI_ID}:mcp:171`,
			toolCallRefs: [`${TEDI_ID}:mcp:171:step:0:0:deploy_worker`],
		});
		expect(record.runId).toBe(`${TEDI_ID}:mcp:171`);
		expect(record.toolCallRefs).toEqual([
			`${TEDI_ID}:mcp:171:step:0:0:deploy_worker`,
		]);
		const row = sqlite
			.prepare(
				"SELECT run_id, tool_call_refs FROM tedi_rationale_records WHERE id = ?",
			)
			.get(record.id) as { run_id: string; tool_call_refs: string };
		expect(row.run_id).toBe(`${TEDI_ID}:mcp:171`);
		expect(JSON.parse(row.tool_call_refs)).toHaveLength(1);
	});

	it("accepts a workItemId-only link", async () => {
		const record = await client.create({
			...baseCreateInput(),
			workItemId: "55555555-5555-4555-8555-555555555555",
		});
		expect(record.workItemId).toBe("55555555-5555-4555-8555-555555555555");
	});
});

describe("proof-gated complete_rationale", () => {
	async function createLinked() {
		return client.create({
			...baseCreateInput(),
			runId: `${TEDI_ID}:mcp:200`,
		});
	}

	it("maps a proof-less success claim to unverified", async () => {
		const record = await createLinked();
		const completed = await client.complete({
			id: record.id,
			outcome: "It worked, trust me",
			outcomeStatus: "success",
		});
		expect(completed.outcomeStatus).toBe("unverified");
		expect(completed.proofRef).toBeNull();
	});

	it("keeps success when a span-checkable proofRef is provided", async () => {
		const record = await createLinked();
		const completed = await client.complete({
			id: record.id,
			outcome: "Deploy verified via run ledger",
			outcomeStatus: "success",
			proofRef: { kind: "run", ref: `${TEDI_ID}:mcp:200` },
		});
		expect(completed.outcomeStatus).toBe("success");
		expect(completed.proofRef).toEqual({
			kind: "run",
			ref: `${TEDI_ID}:mcp:200`,
		});
	});

	it("treats a replayed proof-less success claim as idempotent", async () => {
		const record = await createLinked();
		await client.complete({
			id: record.id,
			outcome: "It worked, trust me",
			outcomeStatus: "success",
		});
		const replay = await client.complete({
			id: record.id,
			outcome: "It worked, trust me",
			outcomeStatus: "success",
		});
		expect(replay.outcomeStatus).toBe("unverified");
	});

	it("failure needs no proof and stays failure", async () => {
		const record = await createLinked();
		const completed = await client.complete({
			id: record.id,
			outcome: "Deploy failed on smoke test",
			outcomeStatus: "failure",
		});
		expect(completed.outcomeStatus).toBe("failure");
	});

	it("write+close success uses the execution link as the proof span", async () => {
		const record = await client.create({
			...baseCreateInput(),
			runId: `${TEDI_ID}:mcp:300`,
			outcomeStatus: "success",
			outcome: "Dispatched and settled in-run",
		});
		expect(record.outcomeStatus).toBe("success");
		expect(record.proofRef).toEqual({
			kind: "run",
			ref: `${TEDI_ID}:mcp:300`,
		});
	});
});
