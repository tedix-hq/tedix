import assert from "node:assert/strict";
import {
	RetainedWorkflowCallback,
	observationCanonical,
	invokeRetainedDescendantCallback,
} from "./retained-descendant-workflow-observation";
const callback = {
	workflowName: "CHAT_TURN_WORKFLOW",
	workflowId: "original",
	type: "complete",
	result: { b: 2, a: 1 },
	timestamp: 0,
};
assert(RetainedWorkflowCallback.safeParse(callback).success);
for (const change of [
	{ type: "progress" },
	{ workflowName: "OTHER" },
	{ timestamp: -1 },
	{ timestamp: NaN },
	{ error: "private" },
	{ private: "private" },
	{ result: () => null },
])
	assert(
		!RetainedWorkflowCallback.safeParse({ ...callback, ...change }).success,
	);
assert.equal(
	observationCanonical({ b: 2, a: 1 }),
	observationCanonical({ a: 1, b: 2 }),
);
let touches = 0;
const ctx = new Proxy({} as DurableObjectState, {
	get() {
		touches++;
		throw Error("unexpected storage access");
	},
});
for (const [method, args] of [
	["fetch", [callback]],
	["startFiber", [callback]],
	["_workflow_handleCallback", []],
	["_workflow_handleCallback", [callback, callback]],
])
	await assert.rejects(
		invokeRetainedDescendantCallback(
			ctx,
			{} as Cloudflare.Env,
			[],
			method,
			args,
		),
	);
assert.equal(touches, 0);
console.log(
	"Retained descendant callback whitelist rejects before custody or storage access",
);
