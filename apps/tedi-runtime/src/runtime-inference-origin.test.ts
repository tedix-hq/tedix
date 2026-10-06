import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertProviderDispatchReady } from "@tedix/workers-ai/gateway-transport";
import { callWorkersAi } from "@tedix/workers-ai/transport";
import { workersAiClient } from "./workers-ai-client";
import {
	inferenceOriginHash,
	privateInferenceOriginGuard,
	readPrivateInferenceOrigin,
	requestInferenceOriginGuard,
	type RuntimeInferenceOrigin,
} from "./runtime-inference-origin";
const owner = { orgId: "org", tediId: "tedi", objectId: "a".repeat(64) };
const input = JSON.stringify({ text: "private full input" });
const accepted = {
	owner,
	runId: "root-run",
	sessionKey: "session",
	principalId: "principal",
	inputHash: createHash("sha256").update(input).digest("hex"),
	requestHash: "b".repeat(64),
	generation: 3,
};
function rootOrigin(): RuntimeInferenceOrigin {
	return {
		kind: "accepted_native",
		root: {
			owner,
			objectName: "original-root",
			className: "AgentTediDO",
			path: [],
			generation: 3,
			accepted,
		},
		selected: {
			owner,
			className: "AgentTediDO",
			identityName: "original-root",
			facetName: null,
			path: [],
			generation: 3,
			accepted,
		},
		operation: null,
		configurationHash: null,
	};
}
function unselected(): RuntimeInferenceOrigin {
	return {
		kind: "unselected_native",
		root: {
			owner,
			objectName: "original-root",
			className: "AgentTediDO",
			path: [],
			generation: 0,
		},
		selected: {
			owner,
			className: "AgentTediDO",
			identityName: "original-root",
			facetName: null,
			path: [],
			generation: 0,
		},
		configurationHash: inferenceOriginHash({ model: "actual-config" }),
	};
}
let checks = 0;
const origin = rootOrigin();
const guard = privateInferenceOriginGuard(
	origin,
	() => {
		checks++;
	},
	input,
);
origin.root.owner.orgId = "caller-mutated";
assert.equal(readPrivateInferenceOrigin(guard)?.root.owner.orgId, "org");
owner.orgId = "org";
const first = requestInferenceOriginGuard(guard)!;
const second = requestInferenceOriginGuard(guard)!;
assert.notEqual(first, second);
const exposed = readPrivateInferenceOrigin(first)!;
exposed.root.objectName = "mutated-copy";
assert.equal(
	readPrivateInferenceOrigin(first)?.root.objectName,
	"original-root",
);
assertProviderDispatchReady(first);
assertProviderDispatchReady(second);
assert.equal(checks, 4);
assert.equal(
	JSON.stringify(readPrivateInferenceOrigin(first)).includes(
		"private full input",
	),
	false,
);
assert.throws(
	() =>
		privateInferenceOriginGuard(rootOrigin(), () => {}, "changed full input"),
	/full input changed/,
);
for (const mutate of [
	(o: RuntimeInferenceOrigin) => {
		o.root.generation = 7;
	},
	(o: RuntimeInferenceOrigin) => {
		o.selected.generation = 7;
	},
	(o: RuntimeInferenceOrigin) => {
		o.selected.owner = { ...owner, orgId: "other" };
	},
	(o: RuntimeInferenceOrigin) => {
		o.selected.identityName = "another-root";
	},
]) {
	const bad = rootOrigin();
	mutate(bad);
	assert.throws(() => privateInferenceOriginGuard(bad, () => {}, input));
}
assert.equal(
	readPrivateInferenceOrigin(
		privateInferenceOriginGuard(unselected(), () => {}),
	)?.kind,
	"unselected_native",
);
for (const mutate of [
	(o: RuntimeInferenceOrigin) => {
		o.root.generation = 1;
	},
	(o: RuntimeInferenceOrigin) => {
		Object.assign(o.root, { accepted });
	},
	(o: RuntimeInferenceOrigin) => {
		o.selected.className = "UnknownFacet";
	},
	(o: RuntimeInferenceOrigin) => {
		o.selected.path = [{ className: "ConversationFacet", name: "fake" }];
	},
]) {
	const bad = unselected();
	mutate(bad);
	assert.throws(() => privateInferenceOriginGuard(bad, () => {}));
}
const leaf = rootOrigin();
if (leaf.kind !== "accepted_native") throw new Error("fixture");
leaf.selected = {
	owner: { ...owner, objectId: "c".repeat(64) },
	className: "ConversationFacet",
	identityName: "registered-path",
	facetName: "conversation",
	path: [
		{ className: "AgentTediDO", name: "original-root" },
		{ className: "ConversationFacet", name: "conversation" },
	],
	generation: 9,
	accepted: {
		...accepted,
		owner: { ...owner, objectId: "c".repeat(64) },
		runId: "leaf-operation",
		generation: 9,
	},
};
leaf.operation = {
	parentRunId: accepted.runId,
	operationId: "leaf-operation",
	sessionKey: accepted.sessionKey,
	parentGeneration: 3,
};
assert.equal(
	readPrivateInferenceOrigin(privateInferenceOriginGuard(leaf, () => {}, input))
		?.selected.generation,
	9,
);
const wrong = structuredClone(leaf);
wrong.selected.accepted.principalId = "another";
assert.throws(
	() => privateInferenceOriginGuard(wrong, () => {}, input),
	/principal/,
);
for (const mutate of [
	(o: RuntimeInferenceOrigin) => {
		o.root.owner = { ...owner, objectId: "invalid" };
	},
	(o: RuntimeInferenceOrigin) => {
		if (o.kind === "accepted_native") o.configurationHash = "invalid";
	},
]) {
	const bad = rootOrigin();
	mutate(bad);
	assert.throws(() => privateInferenceOriginGuard(bad, () => {}, input));
}
const samePhysical = structuredClone(leaf);
samePhysical.selected.owner = owner;
samePhysical.selected.accepted.owner = owner;
assert.throws(() => privateInferenceOriginGuard(samePhysical, () => {}, input));
console.log(
	"PASS private snapshots, full-input hash, original root/leaf tuple and explicit zero epoch",
);
const admission = () =>
	Response.json({
		json: {
			allowed: true,
			settlementMode: "disabled",
			attributionVersion: 3,
			executionId: "12345678-1234-4123-8123-123456789abc",
			sendBefore: "2099-01-01T00:00:00.000Z",
			reservationId: null,
			expiresAt: null,
			estimatedChargeMicros: null,
		},
	});
for (const callback of [
	async () => {},
	() => Promise.resolve(),
	// oxlint-disable-next-line unicorn/no-thenable -- malicious callback return must be refused at the wire.
	() => ({ then() {} }),
]) {
	let sends = 0;
	const bad = privateInferenceOriginGuard(unselected(), callback as () => void);
	const client = workersAiClient(
		{
			AI: {
				run: async () => {
					sends++;
					return { response: "wire" };
				},
			},
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			SECRETS_MASTER_KEY: "fixture-signing-secret",
			TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
			API_SERVICE: { fetch: async () => admission() },
		} as never,
		bad,
	);
	await assert.rejects(
		callWorkersAi(client, "@cf/test", {
			messages: [{ role: "user", content: "fixture" }],
			attribution: { orgId: "org" },
		}),
		{
			name: "ProviderDispatchGuardError",
			phase: "before_dispatch",
			providerRequestSent: false,
		},
	);
	assert.equal(sends, 0);
}
console.log(
	"PASS nested async/thenable guard denial at actual Workers AI binding",
);
let sendCount = 0;
const pending = new Map<string, () => void>();
const env = {
	AI: {
		run: async () => {
			sendCount++;
			return { response: "wire" };
		},
	},
	AI_GATEWAY_ACCOUNT_ID: "account",
	AI_GATEWAY_LLM_ID: "gateway",
	SECRETS_MASTER_KEY: "fixture-signing-secret",
	TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	API_SERVICE: {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const envelope = JSON.parse(await new Request(input, init).text());
			const data = envelope.json ?? envelope;
			await new Promise<void>((resolve) =>
				pending.set(data.metadata.source, resolve),
			);
			return admission();
		},
	},
};
let activeA = true;
const a = privateInferenceOriginGuard(unselected(), () => {
	if (!activeA) throw new Error("original A canceled");
});
const bOrigin = unselected();
bOrigin.root.objectName = "root-b";
bOrigin.selected.identityName = "root-b";
const b = privateInferenceOriginGuard(bOrigin, () => {});
const invoke = (g: () => void, source: string) =>
	callWorkersAi(workersAiClient(env as never, g), "@cf/test", {
		messages: [{ role: "user", content: source }],
		attribution: { orgId: "org", tediId: "tedi", source },
	});
const pa = invoke(a, "a");
const pb = invoke(b, "b");
while (pending.size < 2) await new Promise((r) => setTimeout(r, 1));
activeA = false;
pending.get("b")!();
await pb;
pending.get("a")!();
await assert.rejects(pa, { phase: "before_dispatch" });
assert.equal(sendCount, 1);
assert.equal(readPrivateInferenceOrigin(a)?.root.objectName, "original-root");
assert.equal(readPrivateInferenceOrigin(b)?.root.objectName, "root-b");
console.log(
	"PASS out-of-order actual billing retains each original private capture",
);

// The cap starts at original capture, rather than the first request or retry.
{
	const savedNow = Date.now,
		time = savedNow();
	Date.now = () => time;
	try {
		const original = privateInferenceOriginGuard(unselected(), () => {});
		Date.now = () => time + 590_000;
		const clone = requestInferenceOriginGuard(original);
		const retryClone = requestInferenceOriginGuard(clone);
		Date.now = () => time + 600_000;
		for (const guard of [original, clone, retryClone])
			assert.throws(() => requestInferenceOriginGuard(guard), {
				phase: "before_dispatch",
			});
	} finally {
		Date.now = savedNow;
	}
}
console.log(
	"PASS private cap begins at original capture and cannot be renewed by clones",
);
