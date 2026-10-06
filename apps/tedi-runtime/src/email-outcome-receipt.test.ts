import assert from "node:assert/strict";
import { recordEmailRuntimeOutcome } from "./email-outcome-receipt";

const input = {
	tediId: "123e4567-e89b-12d3-a456-426614174000",
	messageIdHeader: "<opaque@example.invalid>",
	runId: "chat:opaque-run",
	result: "completed" as const,
	elapsedMs: 123.6,
	replied: false,
};

{
	const requests: Request[] = [];
	await recordEmailRuntimeOutcome(
		{
			API_SERVICE: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						json: {
							id: "receipt",
							messageId: "123e4567-e89b-12d3-a456-426614174001",
							duplicate: false,
						},
					});
				},
			} as unknown as Fetcher,
		},
		input,
	);
	assert.equal(requests.length, 1);
	assert.equal(
		new URL(requests[0]!.url).pathname,
		"/rpc/tediEmail/recordOutcome",
	);
	assert.equal(requests[0]!.headers.get("X-Service-Binding"), "true");
	assert.deepEqual((await requests[0]!.json()) as unknown, {
		json: {
			kind: "runtime_turn",
			...input,
			elapsedMs: 123,
		},
	});
}

{
	let calls = 0;
	await recordEmailRuntimeOutcome(
		{
			API_SERVICE: {
				fetch: async () => {
					calls++;
					throw new Error("internal secret or email payload must not escape");
				},
			} as unknown as Fetcher,
		},
		{ ...input, messageIdHeader: null },
	);
	assert.equal(calls, 0, "missing original Message-ID must fail closed");
	const oldWarn = console.warn;
	const warnings: unknown[][] = [];
	console.warn = (...args: unknown[]) => warnings.push(args);
	try {
		await recordEmailRuntimeOutcome(
			{
				API_SERVICE: {
					fetch: async () => {
						calls++;
						throw new Error("internal secret or email payload must not escape");
					},
				} as unknown as Fetcher,
			},
			{ ...input, result: "failed", replied: null },
		);
	} finally {
		console.warn = oldWarn;
	}
	assert.equal(calls, 1);
	assert.equal(JSON.stringify(warnings).includes("internal secret"), false);
}

console.log("email-outcome-receipt OK");
