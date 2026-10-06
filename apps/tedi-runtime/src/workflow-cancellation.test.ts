import assert from "node:assert/strict";
import { terminateWorkflow } from "./workflow-cancellation";

for (const status of ["complete", "errored", "terminated"] as const) {
	let calls = 0;
	assert.deepEqual(
		await terminateWorkflow(
			{
				get: async () => ({
					status: async () => ({ status }),
					terminate: async () => {
						calls++;
					},
				}),
			},
			"done",
		),
		{ detail: "already_settled" },
	);
	assert.equal(calls, 0);
}
{
	let status: "running" | "errored" = "running";
	assert.deepEqual(
		await terminateWorkflow(
			{
				get: async () => ({
					status: async () => ({ status }),
					terminate: async () => {
						status = "errored";
						throw Error(
							"(instance.cannot_terminate) Cannot terminate instance since its on a finite state",
						);
					},
				}),
			},
			"race",
		),
		{ detail: "already_settled" },
	);
}
{
	let calls = 0;
	assert.deepEqual(
		await terminateWorkflow(
			{
				get: async () => ({
					status: async () => ({ status: "running" }),
					terminate: async () => {
						calls++;
					},
				}),
			},
			"active",
		),
		{ detail: "terminated" },
	);
	assert.equal(calls, 1);
}
assert.deepEqual(
	await terminateWorkflow(
		{
			get: async () => {
				throw Error("(instance.not_found) missing");
			},
		},
		"missing",
	),
	{ detail: "not_found" },
);
await assert.rejects(
	terminateWorkflow(
		{
			get: async () => ({
				status: async () => ({ status: "running" }),
				terminate: async () => {
					throw Error("provider unavailable");
				},
			}),
		},
		"unavailable",
	),
	/provider unavailable/,
);
await assert.rejects(
	terminateWorkflow(
		{
			get: async () => {
				throw Error("invalid authorization");
			},
		},
		"denied",
	),
	/invalid authorization/,
);
