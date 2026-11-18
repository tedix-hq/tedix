import { describeGovernanceConformance } from "@tedix/agent-governance/conformance";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import type {
	ChangeRecordInput,
	LedgerQuery,
} from "@tedix/agent-governance/types";
import {
	GatewayChangeRecordInputSchema,
	GatewayLedgerQuerySchema,
} from "@tedix/api-contract/schemas/audit";
import {
	appendGatewayChangeRecord,
	getGatewayChangeRecord,
	listGatewayChangeRecords,
} from "@tedix/db/queries/gateway-change-records";
import { createDbQueryClient } from "@tedix/db/query-client";
import { gatewayChangeRecords } from "@tedix/db/schema/gateway-change-records";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	GatewayAccountabilityAdapter,
	UNSTORED_SEQUENCE,
	admitGatewayCall,
	guardGatewayCall,
	recordGatewayRefusal,
} from "./gateway-adapters";
import type { ServerContext } from "./server-context";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});

/**
 * The gateway adapter over the real ledger table and queries. The API
 * procedures between them are stood in for by their contract schemas and the
 * organization the gateway's client is bound to.
 */
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(gatewayChangeRecords));
	const context = (orgId = "org-a") => {
		const db = createDbQueryClient(createD1Facade(sqlite));
		return {
			app: { organizationId: orgId },
			apiClient: {
				audit: {
					appendChangeRecord: (input: ChangeRecordInput) => {
						const record = GatewayChangeRecordInputSchema.parse(input);
						return appendGatewayChangeRecord(db, orgId, {
							...record,
							actor: { ...record.actor, organizationId: orgId },
						});
					},
					listChangeRecords: (query: LedgerQuery) =>
						listGatewayChangeRecords(
							db,
							orgId,
							GatewayLedgerQuerySchema.parse(query),
						),
					getChangeRecord: ({ id }: { id: string }) =>
						getGatewayChangeRecord(db, orgId, id),
				},
			},
			callerIdentity: { authType: "user", userId: "user-a" },
		} as unknown as ServerContext;
	};
	return { context, sqlite };
}
const tool = {
	toolId: "get_example",
	title: "Get example",
	inputSchema: { type: "object" },
} as never;
const ok = { content: [{ type: "text" as const, text: "ok" }] };

describe("durable gateway ledger", () => {
	it("stores allowed and refused calls once and reads them through a new request", async () => {
		const { context } = setup();
		const execute = vi.fn(async () => ok);
		const allowed = await guardGatewayCall(
			{
				agent: context(),
				tool,
				args: { secret: "do-not-store" },
				annotations: { readOnlyHint: true },
			},
			execute,
		);
		const refused = await guardGatewayCall(
			{
				agent: context(),
				tool,
				args: { secret: "do-not-store" },
				annotations: { destructiveHint: true },
				approval: {
					extra: {
						_meta: { "com.tedix/expectedAnnotations": { destructive: false } },
					},
				},
			},
			execute,
		);
		// An assertion mismatch is refused before execution.
		expect(refused.decision.verdict).toBe("deny");
		expect(execute).toHaveBeenCalledTimes(1);
		const fresh = new GatewayAccountabilityAdapter(context());
		const records = await fresh.list();
		expect(records).toEqual([allowed.record, refused.record]);
		expect(records.map((r) => r.outcome)).toEqual(["applied", "denied"]);
		expect(records[1]!.sequence).toBeGreaterThan(records[0]!.sequence);
		expect(await fresh.get(allowed.record.id)).toEqual(allowed.record);
		expect((await fresh.export()).records).toEqual(records);
		expect(JSON.stringify(records)).not.toContain("do-not-store");
		expect(
			await fresh.list({
				afterSequence: records[0]!.sequence,
				actorId: "user-a",
				limit: 1,
			}),
		).toEqual([records[1]]);
		expect(await fresh.list({ resource: "tool:other" })).toEqual([]);
		expect(await fresh.list({ actorId: "other" })).toEqual([]);
		const other = new GatewayAccountabilityAdapter(context("org-b"));
		expect(await other.get(allowed.record.id)).toBeNull();
		expect((await other.export()).records).toEqual([]);
	});
	it("settles an admitted call only once, including concurrent settlement", async () => {
		const { context } = setup();
		const admission = await admitGatewayCall({
			agent: context(),
			tool,
			args: {},
			annotations: { readOnlyHint: true },
		});
		await Promise.all([
			admission.settle({ status: "applied" }),
			admission.settle({ status: "applied" }),
		]);
		expect(
			await new GatewayAccountabilityAdapter(context()).list(),
		).toHaveLength(1);
	});
	it("records a refusal from a gate that runs before admission", async () => {
		const { context } = setup();
		const refusal = await recordGatewayRefusal(
			{
				agent: context(),
				tool,
				args: { secret: "do-not-store" },
				annotations: undefined,
			},
			"tool_scope",
			"native_tool_scope_denied",
		);
		expect(await new GatewayAccountabilityAdapter(context()).list()).toEqual([
			refusal,
		]);
		expect(refusal).toMatchObject({
			outcome: "denied",
			decision: { verdict: "deny", gate: "tool_scope" },
			actor: { id: "user-a", organizationId: "org-a" },
		});
		expect(JSON.stringify(refusal)).not.toContain("do-not-store");
	});
	it("stores only the argument hash", async () => {
		const { context, sqlite } = setup();
		await guardGatewayCall(
			{
				agent: context(),
				tool,
				args: { secret: "do-not-store" },
				annotations: { readOnlyHint: true },
			},
			async () => ok,
		);
		const rows = sqlite.prepare("SELECT * FROM gateway_change_records").all();
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain("do-not-store");
		expect(JSON.parse(String(rows[0]!.record)).argsHash).toMatch(/\S/);
	});
	it("lets the call finish and logs loudly when the ledger write fails", async () => {
		const { context } = setup();
		const agent = context();
		agent.apiClient.audit.appendChangeRecord = vi.fn(async () => {
			throw new Error("storage unavailable");
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const execute = vi.fn(async () => ok);
		const guarded = await guardGatewayCall(
			{
				agent,
				tool,
				args: { secret: "do-not-store" },
				annotations: { readOnlyHint: true },
			},
			execute,
		);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(guarded.result).toBe(ok);
		expect(guarded.record).toMatchObject({
			sequence: UNSTORED_SEQUENCE,
			outcome: "applied",
		});
		expect(logged).toHaveBeenCalledTimes(1);
		const line = String(logged.mock.calls[0]?.[0]);
		expect(JSON.parse(line)).toMatchObject({
			event: "gateway_change_record_write_failed",
			error: "storage unavailable",
			organizationId: "org-a",
			operation: "get_example",
			outcome: "applied",
		});
		expect(line).not.toContain("do-not-store");
		expect(await new GatewayAccountabilityAdapter(context()).list()).toEqual(
			[],
		);
	});
	it("still refuses a call when the refusal cannot be stored", async () => {
		const { context } = setup();
		const agent = context();
		agent.apiClient.audit.appendChangeRecord = vi.fn(async () => {
			throw new Error("storage unavailable");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const execute = vi.fn(async () => ok);
		const refused = await guardGatewayCall(
			{
				agent,
				tool,
				args: {},
				annotations: { destructiveHint: true },
				approval: {
					extra: {
						_meta: { "com.tedix/expectedAnnotations": { destructive: false } },
					},
				},
			},
			execute,
		);
		expect(refused.decision.verdict).toBe("deny");
		expect(refused.failure?.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});
	it("gives up on a ledger write that does not answer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const { context } = setup();
			const agent = context();
			const append = vi.fn(() => new Promise<never>(() => {}));
			agent.apiClient.audit.appendChangeRecord = append;
			const logged = vi.spyOn(console, "error").mockImplementation(() => {});
			const pending = guardGatewayCall(
				{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
				async () => ok,
			);
			while (append.mock.calls.length === 0)
				await new Promise((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(3000);
			expect((await pending).record.sequence).toBe(UNSTORED_SEQUENCE);
			expect(String(logged.mock.calls[0]?.[0])).toContain("timed out");
		} finally {
			vi.useRealTimers();
		}
	});
	it("answers an allowed call without waiting for its ledger write", async () => {
		const { context } = setup();
		const agent = context();
		const background: Promise<unknown>[] = [];
		const waitUntil = vi.fn((work: Promise<unknown>) => {
			background.push(work);
		});
		(agent as { ctx: unknown }).ctx = { waitUntil };
		const stored = agent.apiClient.audit.appendChangeRecord;
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const append = vi.fn(async (input: ChangeRecordInput) => {
			await held;
			return stored(input);
		});
		agent.apiClient.audit.appendChangeRecord = append as never;

		// Resolves while the ledger write is still held open.
		const guarded = await guardGatewayCall(
			{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
			async () => ok,
		);
		expect(guarded.result).toBe(ok);
		expect(guarded.record).toMatchObject({
			outcome: "applied",
			sequence: UNSTORED_SEQUENCE,
		});
		expect(waitUntil).toHaveBeenCalledTimes(1);
		expect(append).toHaveBeenCalledTimes(1);
		const reader = new GatewayAccountabilityAdapter(context());
		expect(await reader.list()).toEqual([]);

		release();
		await Promise.all(background);
		const [row] = await reader.list();
		expect(row).toEqual({ ...guarded.record, sequence: row!.sequence });
		expect(row!.sequence).toBeGreaterThan(UNSTORED_SEQUENCE);
		expect(await reader.get(guarded.record.id)).toEqual(row);
	});
	it("logs a failed background write without failing the call", async () => {
		const { context } = setup();
		const agent = context();
		const background: Promise<unknown>[] = [];
		(agent as { ctx: unknown }).ctx = {
			waitUntil: (work: Promise<unknown>) => background.push(work),
		};
		agent.apiClient.audit.appendChangeRecord = vi.fn(async () => {
			throw new Error("storage unavailable");
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const guarded = await guardGatewayCall(
			{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
			async () => ok,
		);
		expect(guarded.result).toBe(ok);
		await Promise.all(background);
		expect(logged).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
			event: "gateway_change_record_write_failed",
			changeRecordId: guarded.record.id,
		});
	});
	it("waits for a refusal's record even when it could run in the background", async () => {
		const { context } = setup();
		const agent = context();
		const waitUntil = vi.fn();
		(agent as { ctx: unknown }).ctx = { waitUntil };
		const refused = await guardGatewayCall(
			{
				agent,
				tool,
				args: {},
				annotations: { destructiveHint: true },
				approval: {
					extra: {
						_meta: { "com.tedix/expectedAnnotations": { destructive: false } },
					},
				},
			},
			async () => ok,
		);
		expect(refused.decision.verdict).toBe("deny");
		expect(waitUntil).not.toHaveBeenCalled();
		expect(refused.record.sequence).toBeGreaterThan(UNSTORED_SEQUENCE);
		expect(await new GatewayAccountabilityAdapter(context()).list()).toEqual([
			refused.record,
		]);
	});
	it("stores a record once when the same id is appended again", async () => {
		const { context } = setup();
		const agent = context();
		const first = await guardGatewayCall(
			{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
			async () => ok,
		);
		const { sequence: _sequence, ...again } = first.record;
		expect(await agent.apiClient.audit.appendChangeRecord(again)).toEqual(
			first.record,
		);
		expect(await new GatewayAccountabilityAdapter(agent).list()).toEqual([
			first.record,
		]);
		// The same id from another organization is neither stored nor revealed.
		await expect(
			context("org-b").apiClient.audit.appendChangeRecord(again),
		).rejects.toThrow("was not stored");
		expect(
			await new GatewayAccountabilityAdapter(context("org-b")).list(),
		).toEqual([]);
	});
	it("pages every record on export", async () => {
		const { context } = setup();
		const agent = context();
		const first = await guardGatewayCall(
			{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
			async () => ok,
		);
		const records = Array.from({ length: 1001 }, (_, i) => ({
			...first.record,
			sequence: i + 1,
		}));
		agent.apiClient.audit.listChangeRecords = vi.fn(
			async ({ afterSequence = 0, limit = 1000 }) =>
				records.filter((r) => r.sequence > afterSequence).slice(0, limit),
		);
		expect(
			(await new GatewayAccountabilityAdapter(agent).export()).records,
		).toEqual(records);
		expect(agent.apiClient.audit.listChangeRecords).toHaveBeenCalledTimes(2);
	});
});

// The shared contract suite, with the gateway ledger as the accountability
// adapter over the real table. The gateway has no memory adapter and its
// compliance adapter needs a live request, so those two come from the
// reference adapters: only the ledger case exercises gateway code.
describeGovernanceConformance("gateway ledger conformance", () => ({
	...createInMemoryAdapters(),
	accountability: new GatewayAccountabilityAdapter(setup().context()),
}));
