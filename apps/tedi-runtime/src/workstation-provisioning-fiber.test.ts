/**
 * Structural guard for the durable workstation provisioning handoff.
 *
 * The Tedi edge persists the receipt without booting a Sandbox. The Agent DO
 * must then durably accept the cold wake, checkpoint the exact lease selection,
 * and recover only this named fiber without intercepting other Agent fibers.
 * The Agent owns the fiber wiring (exercised below against the real DO
 * methods); the extracted engine (`workstation-provisioning.ts`) owns the
 * reconcile-until-settled loop.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { nativeToolMarkers, tediDo as tediProbe } from "../test/tedi-do";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import {
	reconcileWorkstationUntilSettled,
	WORKSTATION_CACHE_BACKUP_TIMEOUT_MS,
	WORKSTATION_PROVISION_RECONCILE_INTERVAL_MS,
	type WorkstationProvisioningCheckpoint,
} from "./workstation-provisioning";

// --- the reconcile-until-settled engine, against a scripted edge ---
const realSetTimeout = globalThis.setTimeout;
const timerDelays: number[] = [];
// Poll intervals elapse at once; every other timer keeps its real delay.
globalThis.setTimeout = ((callback: () => void, ms?: number) => {
	timerDelays.push(ms ?? 0);
	return realSetTimeout(
		callback,
		ms === WORKSTATION_PROVISION_RECONCILE_INTERVAL_MS ? 0 : ms,
	);
}) as typeof setTimeout;
const quietWarn = console.warn;
console.warn = () => {};

async function reconcile(
	polls: Array<Record<string, unknown>>,
	exec: () => Response = () =>
		Response.json({ ok: true, stdout: "tedix-repo-sync-probe" }),
) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const checkpoints: WorkstationProvisioningCheckpoint[] = [];
	let poll = 0;
	const env = {
		TEDI_SERVICE: {
			fetch: async (request: Request) => {
				const path = new URL(request.url).pathname.replace(
					"/api/admin/workstation/",
					"",
				);
				calls.push({ path, body: await request.json() });
				if (path === "exec") return exec();
				const answer = polls[Math.min(poll, polls.length - 1)]!;
				poll += 1;
				return Response.json({
					workstationPersistence: { status: "persisted" },
					...answer,
				});
			},
		},
	};
	const run = reconcileWorkstationUntilSettled(
		{
			env: env as never,
			identity: { tediId: "tedi-1", orgId: "org-1", slug: "cto" },
		},
		{ leaseId: "lease-1" },
		{ checkpoint: (value) => checkpoints.push(structuredClone(value)) },
	);
	return {
		run,
		calls,
		checkpoints,
		reconciles: () => calls.filter((c) => c.path !== "exec"),
	};
}
const status = (
	value: string,
	bootstrap: Record<string, unknown> = {},
	extra = {},
) => ({
	ok: true,
	workstation: { status: value },
	bootstrap,
	...extra,
});
const repoSync = (executionState?: string) =>
	status(
		"blocked",
		{ nextAction: "wait_for_repo_sync" },
		{ repoSync: { executionState } },
	);

// A blocked lease settles, except while its repo sync is still underway.
{
	const blocked = await reconcile([
		status("blocked", { nextAction: "operator_action" }),
	]);
	assert.equal((await blocked.run).attempt, 1);
	const syncing = await reconcile([
		repoSync("running"),
		repoSync("running"),
		status("ready"),
	]);
	await syncing.run;
	assert.equal(
		syncing.reconciles().length,
		3,
		"repo sync is fiber-owned until it settles",
	);
}
// The fiber never completes before its reconciled snapshot is durable.
{
	const unpersisted = await reconcile([
		{ ...status("ready"), workstationPersistence: { status: "failed" } },
	]);
	await assert.rejects(
		unpersisted.run,
		/Workstation provisioning did not persist/,
	);
}
// Ready dependencies advance into a distinct, bounded, synchronous cache-backup
// phase whose failure never fails a ready workstation.
for (const backup of [
	status("ready"),
	{ ok: false, error: "backup failed" },
	{ ...status("ready"), workstationPersistence: { status: "failed" } },
]) {
	timerDelays.length = 0;
	const ready = await reconcile([
		status("ready", { cacheBackupStatus: "pending" }),
		backup,
	]);
	const settled = await ready.run;
	assert.equal(settled.phase, "cache-backup");
	const [first, second] = ready.reconciles();
	assert.equal(first!.body.cacheBackupMode, undefined);
	assert.equal(second!.body.cacheBackupMode, "synchronous");
	assert.ok(timerDelays.includes(WORKSTATION_CACHE_BACKUP_TIMEOUT_MS));
	assert.ok(
		ready.checkpoints.some((checkpoint) => checkpoint.phase === "cache-backup"),
	);
}
// A clone that never reaches Computer's retained registry settles early with
// a typed reason; any admitted state resets the count.
{
	const missing = await reconcile([
		repoSync(),
		repoSync(),
		repoSync("admitting"),
		repoSync(),
		repoSync(),
		repoSync(),
	]);
	const settled = await missing.run;
	assert.equal(missing.reconciles().length, 6);
	assert.deepEqual(settled.settleReason, {
		kind: "repo_sync_not_admitted",
		consecutiveMissingPolls: 3,
		probe: "alive",
		probeDetail: "tedix-repo-sync-probe",
	});
	// The liveness probe is a raw exec with no turn identity.
	const probe = missing.calls.find((call) => call.path === "exec")!;
	assert.equal(probe.body.leaseId, "lease-1");
	assert.match(String(probe.body.command), /tedix-repo-sync-probe/);

	// Other states reset it too; an unreachable container never throws.
	const unreachable = await reconcile(
		[
			repoSync(),
			repoSync(),
			status("provisioning"),
			repoSync(),
			repoSync(),
			repoSync(),
		],
		() => new Response("gone", { status: 502, statusText: "Bad Gateway" }),
	);
	const reason = (await unreachable.run).settleReason as Record<
		string,
		unknown
	>;
	assert.equal(unreachable.reconciles().length, 6);
	assert.equal(reason.probe, "unreachable");
	assert.equal(reason.kind, "repo_sync_not_admitted");
}
// A terminal install is never auto-retried, so it settles instead of polling
// out the 30-minute ceiling; a non-terminal poll resets the count.
{
	const terminal = await reconcile([
		status("provisioning", { installStatus: "failed" }),
		status("provisioning", { installStatus: "running" }),
		status("provisioning", { installStatus: "timed_out" }),
		status("provisioning", {
			installStatus: "canceled",
			lastBootstrapError: "bun: exit 1",
		}),
	]);
	const settled = await terminal.run;
	assert.equal(terminal.reconciles().length, 4);
	assert.deepEqual(settled.settleReason, {
		kind: "install_terminal",
		installStatus: "canceled",
		lastBootstrapError: "bun: exit 1",
	});
}
globalThis.setTimeout = realSetTimeout;
console.warn = quietWarn;

// --- provisioning status is internal: never an MCP tool ---
{
	const agent = tediProbe({
		env: {},
		name: "isolate-acme",
		state: { tediId: "tedi-1", slug: "acme" },
		async ensureIdentity() {},
		computerWorkspace: () => ({ workspace: {} }),
		...nativeToolMarkers(),
	});
	const listed = await agent.onRequest(
		new Request("https://acme.tedi.tedix.dev/mcp", {
			method: "POST",
			headers: {
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				"Mcp-Method": "tools/list",
				"Mcp-Protocol-Version": "2026-07-28",
				[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
					method: "service",
					principalId: "service-1",
					principalType: "service",
					scopes: ["tedi:admin"],
				}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/list",
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		}),
	);
	const names = (
		(await listed.json()) as { result: { tools: Array<{ name: string }> } }
	).result.tools.map((tool) => tool.name);
	assert.ok(names.length > 0);
	assert.equal(names.includes("workstation_status"), false);
}

// --- the Agent's fiber wiring ---
const { mock } = createRequire(import.meta.url)("bun:test") as {
	mock: { module(name: string, factory: () => Record<string, unknown>): void };
};
const workstationClient = await import("./workstation");
let leaseStatus: Record<string, unknown> = {
	status: "provisioning",
	ready: false,
};
mock.module("./workstation", () => ({
	...workstationClient,
	async requestWorkstation() {
		return { ok: true, accepted: true, leaseId: "lease-1" };
	},
	async readWorkstationStatus() {
		return leaseStatus;
	},
}));
const { tediDo } = await import("../test/tedi-do");
const { AgentTediDO } = await import("./do");
const {
	WORKSTATION_PROVISION_FIBER_NAME,
	workstationProvisioningAttemptKey,
	workstationProvisioningBaseKey,
	workstationProvisioningFiberName,
} = await import("./workstation-provisioning-attempt");

type Fiber = {
	fiberId: string;
	status: string;
	createdAt: number;
	settledAt?: number;
	metadata?: Record<string, unknown>;
};
function fiberProbe(options: { base?: Fiber | null; scoped?: Fiber[] } = {}) {
	const started: Array<{
		name: string;
		run: (ctx: unknown) => Promise<void>;
		options: { idempotencyKey: string };
	}> = [];
	const reconciled: unknown[] = [];
	const order: string[] = [];
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme" },
		async ensureIdentity() {
			order.push("identity");
		},
		async resolveWorkstationTurnBinding() {
			return null;
		},
		async inspectFiberByKey(key: string) {
			order.push(`inspect:${key}`);
			return options.base ?? null;
		},
		async listFibers(query: { name: string }) {
			order.push(`list:${query.name}`);
			return options.scoped ?? [];
		},
		async startFiber(
			name: string,
			run: (ctx: unknown) => Promise<void>,
			fiberOptions: { idempotencyKey: string },
		) {
			started.push({ name, run, options: fiberOptions });
			return { fiberId: "fiber-new", accepted: true, status: "running" };
		},
	});
	return { agent, started, reconciled, order };
}

{
	// request_workstation durably starts the named provisioning fiber, keyed
	// deterministically, whose body checkpoints each reconciled snapshot.
	const probe = fiberProbe();
	const receipt = (await probe.agent.requestWorkstationTool({})) as {
		provisioningFiber: { accepted: boolean; fiberId: string };
	};
	assert.deepEqual(receipt.provisioningFiber, {
		accepted: true,
		fiberId: "fiber-new",
		status: "running",
	});
	const [fiber] = probe.started;
	assert.equal(fiber?.name, workstationProvisioningFiberName("lease-1"));
	assert.equal(
		fiber?.options.idempotencyKey,
		workstationProvisioningAttemptKey("lease-1", null),
	);
	const stashed: unknown[] = [];
	probe.agent.reconcileWorkstationUntilSettled = async (
		input: unknown,
		reconcileOptions: { checkpoint: (value: unknown) => void },
	) => {
		reconcileOptions.checkpoint({ leaseId: "lease-1", attempt: 1 });
		return input;
	};
	await fiber!.run({
		stash: (value: unknown) => stashed.push(value),
		signal: undefined,
	});
	assert.deepEqual(stashed, [{ leaseId: "lease-1", attempt: 1 }]);
}

{
	// A retry after a settled attempt gets a fresh successor key.
	const previous = {
		fiberId: "fiber-old",
		status: "error",
		createdAt: 1,
		settledAt: 2,
	};
	const probe = fiberProbe({ scoped: [previous] });
	await probe.agent.requestWorkstationTool({});
	assert.equal(
		probe.started[0]?.options.idempotencyKey,
		workstationProvisioningAttemptKey(
			"lease-1",
			previous as unknown as Parameters<
				typeof workstationProvisioningAttemptKey
			>[1],
		),
	);
}

{
	// workstation_status reports the latest retained attempt across legacy
	// base-key and lease-scoped fibers, and re-drives a recoverable one.
	const legacy = {
		fiberId: "fiber-legacy",
		status: "error",
		createdAt: 20,
		settledAt: 21,
		metadata: { provisioningAttempt: 1 },
	};
	const scoped = {
		fiberId: "fiber-scoped",
		status: "error",
		createdAt: 10,
		settledAt: 11,
	};
	const probe = fiberProbe({ base: legacy, scoped: [scoped] });
	leaseStatus = { status: "provisioning", ready: false };
	const status = (await probe.agent.readWorkstationStatusTool({
		leaseId: "lease-1",
	})) as { provisioningFiber: Record<string, unknown> };
	assert.ok(
		probe.order.includes(
			`inspect:${workstationProvisioningBaseKey("lease-1")}`,
		),
	);
	assert.ok(
		probe.order.includes(`list:${workstationProvisioningFiberName("lease-1")}`),
	);
	assert.equal(status.provisioningFiber.resumedFromFiberId, "fiber-legacy");
	assert.equal(status.provisioningFiber.fiberId, "fiber-new");

	// A ready lease is only observed, never re-driven.
	const ready = fiberProbe({ scoped: [scoped] });
	leaseStatus = { status: "ready", ready: true };
	const observed = (await ready.agent.readWorkstationStatusTool({
		leaseId: "lease-1",
	})) as { provisioningFiber: Record<string, unknown> };
	assert.equal(observed.provisioningFiber.fiberId, "fiber-scoped");
	assert.equal(ready.started.length, 0);
}

{
	// Recovery: only workstation fibers are intercepted; an interrupted one
	// resumes reconciliation from its persisted checkpoint.
	const parent = Object.getPrototypeOf(AgentTediDO.prototype) as {
		onFiberRecovered: (ctx: unknown) => Promise<unknown>;
	};
	const original = parent.onFiberRecovered;
	const delegated: string[] = [];
	parent.onFiberRecovered = async (ctx: unknown) => {
		delegated.push((ctx as { name: string }).name);
		return { status: "completed" };
	};
	try {
		const resumed: unknown[] = [];
		const agent = tediDo({
			async nativeTelegram() {
				return null;
			},
			async reconcileWorkstationUntilSettled(input: unknown) {
				resumed.push(input);
				return input;
			},
		});
		await agent.onFiberRecovered({
			name: "native-unrelated-fiber",
			snapshot: {},
		});
		assert.deepEqual(delegated, ["native-unrelated-fiber"]);
		const recovered = await agent.onFiberRecovered({
			name: `${WORKSTATION_PROVISION_FIBER_NAME}:lease-1`,
			snapshot: {
				leaseId: "lease-1",
				attempt: 1,
				phase: "provision",
				startedAt: 5,
			},
		});
		assert.equal((recovered as { status: string }).status, "completed");
		assert.equal((resumed[0] as { leaseId: string }).leaseId, "lease-1");
		const missing = await agent.onFiberRecovered({
			name: WORKSTATION_PROVISION_FIBER_NAME,
			snapshot: {},
		});
		assert.equal((missing as { status: string }).status, "error");
	} finally {
		parent.onFiberRecovered = original;
	}
}

{
	// The model gets the computer interface, never provisioning polling.
	const tools = Object.keys(
		tediDo({
			workspaceAiTools: () => ({}),
			computerEnvironment: () => ({}),
		}).workstationAiTool({ kind: "conversation", key: "main" }, null),
	);
	assert.ok(tools.includes("open_computer"));
	assert.equal(tools.includes("workstation_status"), false);
	assert.equal(tools.includes("request_workstation"), false);
}

{
	// The DO seam resolves identity before delegating to the engine.
	const order: string[] = [];
	const agent = tediDo({
		env: {
			TEDI_SERVICE: {
				fetch: async () => {
					order.push("engine");
					return Response.json({
						ok: true,
						ready: true,
						workstation: { status: "ready" },
						workstationPersistence: { status: "persisted" },
						readiness: { toolsReady: true, repoReady: true },
					});
				},
			},
		},
		state: {},
		async ensureIdentity() {
			order.push("identity");
			agent.state = { tediId: "tedi-1", slug: "acme" };
		},
	});
	await agent.reconcileWorkstationUntilSettled(
		{
			leaseId: "lease-1",
			attempt: 0,
			phase: "provision",
			startedAt: Date.now(),
		},
		{ checkpoint: () => undefined },
	);
	assert.equal(order[0], "identity");
	assert.ok(order.includes("engine"));
}

console.log("workstation-provisioning-fiber OK");

// Exercise the real reconcile adapter/checkpoint projection: preserve the exact
// retained clone identity, without commands, credentials or native logs.
{
	const { reconcileWorkstationUntilSettled } =
		await import("./workstation-provisioning");
	const checkpoints: Array<Record<string, unknown>> = [];
	const result = await reconcileWorkstationUntilSettled(
		{
			env: {
				TEDI_SERVICE: {
					fetch: async () =>
						Response.json({
							ok: true,
							ready: true,
							workstation: { status: "ready" },
							workstationPersistence: { status: "persisted" },
							readiness: { toolsReady: true, repoReady: true },
							repoSync: {
								status: "updated",
								executionId: "repo-clone-original",
								executionState: "terminal",
								stdout: "PRIVATE",
							},
						}),
				} as unknown as Fetcher,
			},
			identity: { tediId: "t", slug: "cto" },
		},
		{
			leaseId: "lease-original",
			refreshId: "refresh-original",
			attempt: 0,
			phase: "provision",
			startedAt: Date.now(),
		},
		{ checkpoint: (value) => checkpoints.push(value) },
	);
	assert.equal(
		(result.refreshReceipt?.repoSync as Record<string, unknown>)?.executionId,
		"repo-clone-original",
	);
	assert.equal(typeof result.refreshReceipt?.observedAt, "string");
	assert.ok(!JSON.stringify(result.refreshReceipt).includes("PRIVATE"));
	assert.ok(checkpoints.some((c) => c.refreshReceipt));
}
