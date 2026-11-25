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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type GatewayCallGates,
	GatewayAccountabilityAdapter,
	UNSTORED_SEQUENCE,
	admitGatewayCall,
	guardGatewayCall,
	recordGatewayRefusal,
} from "./gateway-adapters";
import type { ServerContext } from "./server-context";

afterEach(() => {
	vi.restoreAllMocks();
});

type StoredRecord = Record<string, unknown> & {
	id: string;
	sequence: number;
	resource: string;
	actor: { id: string };
};

/**
 * The gateway adapter over a stand-in for the organization's log store: one
 * chain per organization, each id stored once. The API procedures between
 * them are stood in for by their contract schemas and the organization the
 * gateway's client is bound to.
 */
function setup() {
	const stores = new Map<string, StoredRecord[]>();
	const storeOf = (orgId: string) => {
		const records = stores.get(orgId) ?? [];
		stores.set(orgId, records);
		return records;
	};
	const context = (orgId = "org-a") => {
		const records = storeOf(orgId);
		return {
			app: { organizationId: orgId },
			apiClient: {
				audit: {
					appendChangeRecord: async (input: ChangeRecordInput) => {
						const parsed = GatewayChangeRecordInputSchema.parse(input);
						const id = parsed.id ?? crypto.randomUUID();
						const existing = records.find((record) => record.id === id);
						if (existing) return structuredClone(existing);
						const record = {
							...parsed,
							actor: { ...parsed.actor, organizationId: orgId },
							id,
							sequence: records.length + 1,
							recordedAt: parsed.recordedAt ?? new Date().toISOString(),
						};
						records.push(record);
						return structuredClone(record);
					},
					listChangeRecords: async (query: LedgerQuery) => {
						const q = GatewayLedgerQuerySchema.parse(query);
						return structuredClone(
							records
								.filter(
									(record) =>
										(q.resource === undefined ||
											record.resource === q.resource) &&
										(q.actorId === undefined ||
											record.actor.id === q.actorId) &&
										(q.afterSequence === undefined ||
											record.sequence > q.afterSequence),
								)
								.slice(0, q.limit),
						);
					},
					getChangeRecord: async ({ id }: { id: string }) =>
						structuredClone(records.find((record) => record.id === id) ?? null),
				},
			},
			callerIdentity: { authType: "user", userId: "user-a" },
		} as unknown as ServerContext;
	};
	const stored = () => [...stores.values()].flat();
	return { context, stored };
}
const tool = {
	toolId: "get_example",
	title: "Get example",
	inputSchema: { type: "object" },
} as never;
const ok = { content: [{ type: "text" as const, text: "ok" }] };

describe("durable gateway ledger", () => {
	it.each(["native", "code_mode"])(
		"records every Work call, reads and heartbeats included, through %s",
		async (surface) => {
			const { context } = setup();
			const agent = context();
			const pending: Promise<unknown>[] = [];
			Object.assign(agent, {
				env: {},
				ctx: {
					waitUntil: (promise: Promise<unknown>) => pending.push(promise),
				},
			});
			const calls = [
				["get_work_case", "workItems/getCase", "read"],
				["heartbeat_work_attempt", "workItems/heartbeatAttempt", "liveness"],
				["settle_work_attempt", "workItems/settleAttempt", "change"],
			] as const;
			for (const [toolId, endpoint, kind] of calls) {
				const gates: GatewayCallGates = {
					agent,
					tool: {
						toolId,
						title: toolId,
						inputSchema: { type: "object", properties: {} },
						config: { transport: "rpc", endpoint, _aggregateNamespace: "cto" },
						meta: {
							"com.tedix/policy": {
								riskTier: kind === "read" ? "read" : "bounded_write",
								blastRadius: kind === "read" ? "none" : "single_resource",
								...(kind === "liveness"
									? { skipAppliedChangeRecord: true }
									: {}),
							},
						},
					},
					args: {},
					annotations: undefined,
					toolName: surface === "native" ? toolId : `cto.${toolId}`,
				};
				if (surface === "native") await guardGatewayCall(gates, async () => ok);
				else {
					const admission = await admitGatewayCall(gates);
					await admission.settle({ status: "applied" });
				}
			}
			await Promise.all(pending);
			const records = await new GatewayAccountabilityAdapter(context()).list();
			expect(records.map((record) => record.operation)).toEqual(
				calls.map(([toolId]) =>
					surface === "native" ? toolId : `cto.${toolId}`,
				),
			);
			expect(records.every((record) => record.outcome === "applied")).toBe(
				true,
			);
		},
	);

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
		const { context, stored } = setup();
		await guardGatewayCall(
			{
				agent: context(),
				tool,
				args: { secret: "do-not-store" },
				annotations: { readOnlyHint: true },
			},
			async () => ok,
		);
		const rows = stored();
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain("do-not-store");
		expect(rows[0]!.argsHash).toMatch(/\S/);
	});
	it("stores the approval evidence of a confirmed call, never its arguments", async () => {
		const { context, stored } = setup();
		const args = {
			secret: "do-not-store",
			confirmDestructive: true,
			reason: "owner asked to remove it",
		};
		const confirmed = await guardGatewayCall(
			{
				agent: context(),
				tool,
				args,
				annotations: { destructiveHint: true },
				approval: { args },
			},
			async () => ok,
		);
		const rows = stored();
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain("do-not-store");
		const read = await new GatewayAccountabilityAdapter(context()).get(
			confirmed.record.id,
		);
		expect(read?.approval).toEqual({
			kind: "self_confirmation",
			approverId: "user-a",
			approvedAt: confirmed.record.approval!.approvedAt,
			singleUse: false,
			reason: "owner asked to remove it",
		});
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
	it("retries a failed background write with the same record until it is stored", async () => {
		vi.useFakeTimers();
		const { context } = setup();
		const agent = context();
		const background: Promise<unknown>[] = [];
		(agent as { ctx: unknown }).ctx = {
			waitUntil: (work: Promise<unknown>) => background.push(work),
		};
		const append = agent.apiClient.audit.appendChangeRecord;
		let failures = 2;
		agent.apiClient.audit.appendChangeRecord = vi.fn(async (input) => {
			if (failures-- > 0) throw new Error("storage unavailable");
			return append(input);
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const guarded = await guardGatewayCall(
			{ agent, tool, args: {}, annotations: { readOnlyHint: true } },
			async () => ok,
		);
		expect(guarded.result).toBe(ok);
		await vi.runAllTimersAsync();
		await Promise.all(background);
		vi.useRealTimers();
		expect(logged).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
			event: "gateway_change_record_write_failed",
			changeRecordId: guarded.record.id,
		});
		expect(
			await new GatewayAccountabilityAdapter(context()).get(guarded.record.id),
		).toMatchObject({
			id: guarded.record.id,
			recordedAt: guarded.record.recordedAt,
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
		// Each organization has its own store: the same id from another
		// organization is that organization's record and reveals nothing.
		const other =
			await context("org-b").apiClient.audit.appendChangeRecord(again);
		expect(other.actor.organizationId).toBe("org-b");
		expect(await new GatewayAccountabilityAdapter(agent).list()).toEqual([
			first.record,
		]);
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
	it("stores no record for an applied read or liveness report, but keeps their failures and refusals", async () => {
		const { context, stored } = setup();
		const agent = context();
		const waitUntil = vi.fn();
		(agent as { ctx: unknown }).ctx = { waitUntil };
		// No rate limiter bindings: the tier limit is not under test.
		(agent as { env: unknown }).env = {};
		const withPolicy = (toolId: string, policy: Record<string, unknown>) =>
			({
				toolId,
				title: toolId,
				inputSchema: { type: "object" },
				meta: { "com.tedix/policy": policy },
			}) as never;
		const read = withPolicy("list_example", {
			riskTier: "read",
			blastRadius: "none",
		});
		const liveness = withPolicy("heartbeat_example", {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
			skipAppliedChangeRecord: true,
		});
		const write = withPolicy("update_example", {
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		});
		const failed = { isError: true, content: [{ type: "text", text: "no" }] };

		const appliedRead = await guardGatewayCall(
			{ agent, tool: read, args: {}, annotations: undefined },
			async () => ok,
		);
		const appliedLiveness = await guardGatewayCall(
			{ agent, tool: liveness, args: {}, annotations: undefined },
			async () => ok,
		);
		// Unstored, but callers still get a record object.
		expect(appliedRead.record).toMatchObject({
			outcome: "applied",
			sequence: UNSTORED_SEQUENCE,
		});
		expect(appliedLiveness.record.sequence).toBe(UNSTORED_SEQUENCE);
		expect(waitUntil).not.toHaveBeenCalled();
		expect(stored()).toEqual([]);

		await guardGatewayCall(
			{ agent, tool: read, args: {}, annotations: undefined },
			async () => failed as never,
		);
		await guardGatewayCall(
			{ agent, tool: liveness, args: {}, annotations: undefined },
			async () => failed as never,
		);
		await recordGatewayRefusal(
			{ agent, tool: read, args: {}, annotations: undefined },
			"tool_scope",
			"native_tool_scope_denied",
		);
		await guardGatewayCall(
			{ agent, tool: write, args: {}, annotations: undefined },
			async () => ok,
		);
		const background = waitUntil.mock.calls.map(([work]) => work);
		await Promise.all(background);
		const listed = await new GatewayAccountabilityAdapter(context()).list();
		expect(listed.map((r) => [r.operation, r.outcome])).toEqual([
			["list_example", "not_applied"],
			["heartbeat_example", "not_applied"],
			["list_example", "denied"],
			["update_example", "applied"],
		]);
	});
});

// The shared contract suite, with the gateway ledger as the accountability
// adapter over a stand-in for the organization log store. The gateway has no memory adapter and its
// compliance adapter needs a live request, so those two come from the
// reference adapters: only the ledger case exercises gateway code.
describeGovernanceConformance("gateway ledger conformance", () => ({
	...createInMemoryAdapters(),
	accountability: new GatewayAccountabilityAdapter(setup().context()),
}));
