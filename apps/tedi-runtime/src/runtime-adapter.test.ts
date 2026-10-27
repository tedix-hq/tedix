import assert from "node:assert/strict";
import {
	executeRuntimeAdapterTurn,
	type RuntimeAdapter,
	type RuntimeTurnScope,
} from "@tedix/context-core/runtime-adapter";
import { cloudflareRuntimeAdapter } from "./cloudflare-runtime-adapter";
import type { ConfiguredConversationTurn } from "./conversation-facet";

const scope: RuntimeTurnScope = {
	orgId: "tenant-a",
	tediId: "tedi-a",
	runId: "run-a",
	sessionKey: "chat:a",
};
const payload: ConfiguredConversationTurn = {
	configuration: {
		...scope,
		aigMetadata: { orgId: scope.orgId, tediId: scope.tediId },
		system: "Tenant-owned memory: use the approved invoice template.",
		modelRef: null,
		maxSteps: null,
		toolDescriptors: [],
	},
	text: "Which template should I use?",
};
const active = { async assertActive() {} };
const facetResult = {
	priorTurnCount: 0,
	result: {
		assistantText: "Use the approved invoice template.",
		requestId: "request-a",
		turnCount: 1,
		turnMs: 1,
	},
};

// The second adapter consumes the same parent projection, with no state store
// or credential capability. This is a local conformance fixture, not celld.
{
	const original = structuredClone(payload);
	const inputs: ConfiguredConversationTurn[] = [];
	const cloudflare = cloudflareRuntimeAdapter(scope, {
		async runConfiguredConversationTurn(input) {
			inputs.push(input);
			return facetResult;
		},
	});
	const scripted: RuntimeAdapter<
		ConfiguredConversationTurn,
		typeof facetResult
	> = {
		id: "scripted-test",
		scope,
		async execute(input, control) {
			await control.assertActive();
			inputs.push(input);
			assert.match(input.configuration.system, /approved invoice template/);
			assert.deepEqual(input.configuration.toolDescriptors, []);
			return facetResult;
		},
	};
	for (const adapter of [cloudflare, scripted]) {
		const { output, receipt } = await executeRuntimeAdapterTurn({
			adapter,
			scope,
			payload,
			control: active,
		});
		assert.deepEqual(output, facetResult);
		assert.deepEqual(receipt, {
			...scope,
			adapterId: adapter.id,
			outcome: "returned",
		});
		console.log("local adapter receipt", receipt);
	}
	assert.deepEqual(inputs, [original, original]);
	assert.deepEqual(payload, original);
}

// A different tenant, identity, run or session cannot reach the resolved facet.
for (const key of ["orgId", "tediId", "runId", "sessionKey"] as const) {
	let calls = 0;
	const adapter = cloudflareRuntimeAdapter(scope, {
		async runConfiguredConversationTurn() {
			calls++;
			return facetResult;
		},
	});
	await assert.rejects(
		executeRuntimeAdapterTurn({
			adapter,
			scope: { ...scope, [key]: "other" },
			payload,
			control: active,
		}),
		/Runtime adapter .* mismatch/,
	);
	const changed = structuredClone(payload);
	if (key === "orgId" || key === "tediId")
		changed.configuration.aigMetadata[key] = "other";
	else changed.configuration[key] = "other";
	await assert.rejects(
		executeRuntimeAdapterTurn({
			adapter,
			scope,
			payload: changed,
			control: active,
		}),
		/Runtime adapter .* mismatch/,
	);
	assert.equal(calls, 0);
}

// Cancellation/admission failure blocks dispatch and rejects a late answer.
for (const failAt of [1, 2]) {
	let checks = 0;
	let executions = 0;
	const adapter: RuntimeAdapter<string, string> = {
		id: "scripted-test",
		scope,
		async execute() {
			executions++;
			return "answer";
		},
	};
	await assert.rejects(
		executeRuntimeAdapterTurn({
			adapter,
			scope,
			payload: "question",
			control: {
				async assertActive() {
					if (++checks === failAt)
						throw new Error("Turn cancelled or admission unavailable");
				},
			},
		}),
		/Turn cancelled or admission unavailable/,
	);
	assert.equal(executions, failAt === 1 ? 0 : 1);
}

// Adapter output cannot replace host attribution; failures issue no receipt.
{
	const adapter: RuntimeAdapter<null, unknown> = {
		id: "scripted-test",
		scope,
		async execute() {
			return { receipt: { orgId: "other" } };
		},
	};
	const { receipt } = await executeRuntimeAdapterTurn({
		adapter,
		scope,
		payload: null,
		control: active,
	});
	assert.equal(receipt.orgId, scope.orgId);
	adapter.execute = async () => {
		throw new Error("Adapter unavailable");
	};
	await assert.rejects(
		executeRuntimeAdapterTurn({
			adapter,
			scope,
			payload: null,
			control: active,
		}),
		/Adapter unavailable/,
	);
}
console.log("runtime adapter boundary passed");
