import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { DISPATCH_SHIM, WORKFLOW_FETCH_GATE_MODULE } from "../src/runner";
import {
	connectionRecoveryPath,
	requirePendingConnectionRecovery,
} from "../src/workflow-connection-recovery";

// Execute the production-generated shim against a durable-step cache. This
// proves continuation behavior rather than matching strings in its source.
class PermanentError extends Error {}
const localContext = new AsyncLocalStorage<Record<string, unknown>>();
const imports = DISPATCH_SHIM.match(
	/import \{([\s\S]*?)\} from "\.\/workflow-fetch-gate\.js";/,
)![1]!
	.replace(/^[\s\S]*import \{/, "")
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean);
const strip = (source: string) =>
	source
		.replace(/import [\s\S]*? from [^;]+;/g, "")
		.replace(/export default TenantSkillWorkflow;/g, "")
		.replace(/export \{[^}]+\};/g, "")
		.replace(/export /g, "");
const helpers = new Function(
	"NonRetryableError",
	"workflowCallContext",
	`${strip(WORKFLOW_FETCH_GATE_MODULE)}; return {${imports.join(",")}};`,
)(PermanentError, localContext);
const runtime = new Function(
	"WorkflowEntrypoint",
	"NonRetryableError",
	"workflowCallContext",
	"userMod",
	...imports,
	`${strip(DISPATCH_SHIM)}; return {wrapStep, buildMcpProxy, makeTimeline};`,
)(
	class {},
	PermanentError,
	localContext,
	{},
	...imports.map((name) => helpers[name]),
);
const recovery = {
	providerId: "calendar",
	connectionInstanceId: "11111111-1111-4111-8111-111111111111",
	scope: "user",
	scopes: ["calendar"],
};
const runContext = {
	runId: "run",
	executionEpoch: 3,
	orgId: "org",
	tediId: "tedi",
	skillId: "skill",
};

async function scenario(
	options: {
		changed?: boolean;
		priorNetwork?: boolean;
		priorCall?: boolean;
		unverified?: boolean;
		approval?: boolean;
		timeout?: boolean;
		providerMarker?: boolean;
		storeFailure?: boolean;
		alwaysMissing?: boolean;
	} = {},
) {
	const cache = new Map<string, unknown>();
	const artifacts = new Map<string, unknown>();
	let counts = new Map<string, number>();
	let connected = false;
	let waits = 0;
	let prior = 0;
	let providerEffects = 0;
	const calls: Record<string, any>[] = [];
	const env = {
		__ARTIFACT_BRIDGE__: {
			record: async ({ path, value }: { path: string; value: unknown }) => {
				if (options.storeFailure && path.includes("/controls/"))
					throw new Error("durable store unavailable");
				artifacts.set(path, value);
			},
			recordOnce: async () => {},
		},
		__MCP_BRIDGE__: {
			call: async (request: Record<string, any>) => {
				calls.push(request);
				if (options.priorCall && request.method === "read")
					return { __tedixMcpResult: true, value: { busy: false } };
				if (options.approval)
					throw new Error("MCP_INPUT_REQUIRED: approval needed");
				if (options.providerMarker)
					return {
						__tedixMcpResult: true,
						value: { __tedixConnectionRequired: true, recovery },
					};
				if (!connected || options.alwaysMissing)
					return { __tedixConnectionRequired: true, recovery };
				providerEffects++;
				return { __tedixMcpResult: true, value: { id: "event" } };
			},
		},
	};
	const native = {
		do: async (name: string, configOrFn: any, fn?: any) => {
			const count = (counts.get(name) ?? 0) + 1;
			counts.set(name, count);
			const key = `${name}:${count}`;
			if (cache.has(key)) return cache.get(key);
			const value = await (typeof configOrFn === "function" ? configOrFn : fn)({
				step: { name, count },
				attempt: 1,
				config: {},
			});
			cache.set(key, structuredClone(value));
			return value;
		},
		waitForEvent: async (name: string, options: { type: string }) => {
			if (cache.has(name)) return cache.get(name);
			waits++;
			assert.equal(
				providerEffects,
				0,
				"no provider mutation may precede verification",
			);
			if (options && scenarioOptions.timeout)
				throw new PermanentError("event wait expired");
			connected = true;
			const answer = {
				payload: {
					connectionVerified: !scenarioOptions.unverified,
					eventType: options.type,
				},
				timestamp: new Date(),
			};
			cache.set(name, answer);
			return answer;
		},
	};
	const scenarioOptions = options;
	const invoke = async () => {
		const step = runtime.wrapStep(
			native,
			env,
			runtime.makeTimeline(),
			runContext,
		);
		const mcp = runtime.buildMcpProxy(env, runContext);
		await step.do("prior", async () => {
			prior++;
			return "preserved";
		});
		return step.do("book", async () => {
			if (options.priorNetwork)
				localContext.getStore()!.directNetworkStarted = true;
			if (options.priorCall) await mcp.calendar.read({});
			return mcp.calendar.create_event({
				title: options.changed && connected ? "changed" : "unchanged",
			});
		});
	};
	return {
		invoke,
		replay: async () => {
			counts = new Map();
			return invoke();
		},
		calls,
		artifacts,
		get waits() {
			return waits;
		},
		get prior() {
			return prior;
		},
		get effects() {
			return providerEffects;
		},
	};
}

const resumed = await scenario();
assert.deepEqual(await resumed.invoke(), { id: "event" });
assert.equal(resumed.waits, 1);
assert.equal(resumed.prior, 1);
assert.equal(resumed.effects, 1);
assert.equal(
	resumed.calls[0]!.workflow.stepCount,
	resumed.calls[1]!.workflow.stepCount,
);
assert.deepEqual(resumed.calls[1]!.connectionBinding, recovery);
assert.ok(
	[...resumed.artifacts.keys()].some((path) =>
		path.includes("/controls/connection_recovery_"),
	),
);
await resumed.replay();
assert.equal(
	resumed.prior,
	1,
	"hibernation replay retains earlier completed steps",
);
assert.equal(
	resumed.effects,
	1,
	"cached continuation does not repeat provider mutation",
);

for (const options of [
	{ changed: true },
	{ priorNetwork: true },
	{ priorCall: true },
	{ unverified: true },
	{ approval: true },
	{ timeout: true },
	{ storeFailure: true },
]) {
	const rejected = await scenario(options);
	await assert.rejects(rejected.invoke());
	assert.equal(rejected.effects, 0);
	if (
		options.priorNetwork ||
		options.priorCall ||
		options.approval ||
		options.storeFailure
	)
		assert.equal(rejected.waits, 0);
}
const exhausted = await scenario({ alwaysMissing: true });
await assert.rejects(exhausted.invoke(), /MCP_CONNECTION_RECOVERY_LIMIT/);
assert.equal(exhausted.waits, 3);
assert.equal(exhausted.effects, 0);
const providerMarker = await scenario({ providerMarker: true });
assert.equal((await providerMarker.invoke()).__tedixConnectionRequired, true);
assert.equal(
	providerMarker.waits,
	0,
	"provider content cannot forge host reconnect control",
);
assert.throws(() => connectionRecoveryPath(2, "connection_recovery_../escape"));
assert.throws(() =>
	connectionRecoveryPath(-1, "connection_recovery_" + "a".repeat(24)),
);
const eventType = "connection_recovery_" + "a".repeat(24);
const receipt = {
	schemaVersion: 1,
	status: "waiting",
	eventType,
	executionEpoch: 3,
	stepName: "book",
	logicalCount: 1,
	namespace: "calendar",
	method: "create_event",
	requestDigest: "b".repeat(64),
	recovery,
};
const fakeDb = (value: unknown) =>
	({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => [{ contentInline: JSON.stringify(value) }],
				}),
			}),
		}),
	}) as Parameters<typeof requirePendingConnectionRecovery>[0];
const event = {
	runId: "run",
	executionEpoch: 3,
	type: eventType,
	payload: { connectionVerified: true, eventType },
};
assert.deepEqual(
	await requirePendingConnectionRecovery(fakeDb(receipt), event),
	receipt,
);
await assert.rejects(
	requirePendingConnectionRecovery(fakeDb(receipt), {
		...event,
		payload: { connectionVerified: false, eventType },
	}),
);
await assert.rejects(
	requirePendingConnectionRecovery(
		fakeDb({ ...receipt, status: "resolved" }),
		event,
	),
);
await assert.rejects(
	requirePendingConnectionRecovery(fakeDb(receipt), {
		...event,
		executionEpoch: 4,
	}),
);
console.log("durable connection recovery tests passed");
