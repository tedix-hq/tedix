import assert from "node:assert/strict";
import { readWithEvaluationBoundary } from "./evaluation-read-boundary";
import { handleMcp } from "./mcp-mount";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

// Exercise the actual native MCP schema, not only the callback helper.
let received: unknown;
const nativeArgs = {
	path: "AGENTS.md",
	maxChars: 80000,
	evaluationInstructions: true,
};
const native = await handleMcp(
	new Request("https://fixture.tedi.example/mcp", {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "artifact_read_file",
			"Mcp-Protocol-Version": "2026-07-28",
			[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
				method: "jwt",
				principalId: "owner-1",
				principalType: "user",
				scopes: ["tedi:config.read"],
			}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "artifact_read_file",
				arguments: nativeArgs,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": {
						name: "boundary-test",
						version: "1",
					},
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	}),
	"fixture",
	{
		conversationGet: async () => ({}),
		conversationsList: async () => ({}),
		messagesRead: async () => ({}),
		messagesSend: async () => ({}),
		readArtifactFile: async (args) => {
			received = args;
			return { ok: true, source: "effective_evaluation_instructions" };
		},
	},
);
assert.equal(native.status, 200);
assert.deepEqual(received, nativeArgs);

const identity = {
	runtimeSource: "runtime-fixture",
	environment: "test",
	tediId: "tedi-1",
	slug: "fixture",
};
const result = { ok: false, error: "not_found" };
for (const args of [
	{ path: "AGENTS.md" },
	{ path: "AGENTS.md", evaluationInstructions: true },
	{ path: "AGENTS.md", evaluationInstructions: false },
]) {
	let calls = 0;
	const observed = await readWithEvaluationBoundary({
		args,
		identity,
		read: async () => {
			calls++;
			return result;
		},
	});
	assert.equal(calls, 1);
	assert.deepEqual(observed, {
		...result,
		evaluationReadBoundary: {
			version: 1,
			...identity,
			evaluationInstructionsPresent: Object.hasOwn(
				args,
				"evaluationInstructions",
			),
			evaluationInstructions: args.evaluationInstructions === true,
		},
	});
}
assert.equal(
	await readWithEvaluationBoundary({
		args: { path: "SOUL.md" },
		identity,
		read: async () => result,
	}),
	result,
);
const unavailable = await readWithEvaluationBoundary({
	args: { path: "AGENTS.md", evaluationInstructions: true },
	identity,
	read: async () => {
		throw new Error("private storage failure");
	},
});
assert.equal((unavailable as { ok: boolean }).ok, false);
assert.equal(
	(unavailable as { evaluationReadBoundary: typeof identity })
		.evaluationReadBoundary.runtimeSource,
	identity.runtimeSource,
);
assert.ok(!JSON.stringify(unavailable).includes("private storage failure"));
await assert.rejects(
	readWithEvaluationBoundary({
		args: { path: "AGENTS.md" },
		identity,
		read: async () => {
			throw new Error("denied");
		},
	}),
	/denied/,
);
