import {
	applyDurableCodeRecoveryAuthority,
	canRecoverDurableCode,
} from "./durable-code-delegation";
import assert from "node:assert/strict";
import {
	createDurableCodeDelegation,
	createMachineDurableCodeDelegation,
	DURABLE_CODE_DELEGATION_HEADER,
	requiredDurableCodeCapability,
	type DurableCodeOperation,
} from "@tedix/mcp-shared/auth/durable-code-delegation";
import { resolveDurableCodeDelegation } from "./durable-code-delegation";
import { canManageDurableCode } from "./durable-codemode-auth";
import { handleMcp, type AgentMcpTools } from "./mcp-mount";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import {
	bindModernMcpRequest,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_CLIENT_CAPABILITIES_META_KEY,
} from "@tedix/mcp-shared/protocol";

const tediId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const now = 1_000_000;
async function request(
	operation: DurableCodeOperation,
	args: Record<string, string | number>,
) {
	const envelope = await createDurableCodeDelegation({
		tediId,
		organizationId,
		operation,
		arguments: args,
		now,
		caller: {
			classification: "human",
			principal: {
				authenticated: true,
				verified: true,
				source: "aih-oauth",
				subject: "human-owner",
				email: "owner@example.com",
				orgId: organizationId,
				scopes: [requiredDurableCodeCapability(operation)],
				audiences: [],
			},
		},
	});
	return new Request("https://cto.tedi.tedix.dev/mcp", {
		method: "POST",
		headers: { [DURABLE_CODE_DELEGATION_HEADER]: JSON.stringify(envelope) },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: operation, arguments: args },
		}),
	});
}
const inputs: Record<DurableCodeOperation, Record<string, string | number>> = {
	recover_code_execution: { execution_id: "exec-1" },
	run_durable_code: { code: "return 1" },
	list_code_executions: { limit: 20 },
	get_code_execution: { execution_id: "exec_1_uuid" },
	approve_code_execution: { execution_id: "exec_1_uuid" },
	reject_code_execution: { execution_id: "exec_1_uuid", seq: 0 },
	rollback_code_execution: { execution_id: "exec_1_uuid" },
};
const resolve = (request: Request, overrides: Record<string, unknown> = {}) =>
	resolveDurableCodeDelegation({
		request,
		trustedServiceBinding: true,
		tediId,
		organizationId,
		now,
		...overrides,
	});

for (const operation of Object.keys(inputs) as DurableCodeOperation[]) {
	const req = await request(operation, inputs[operation]);
	const result = await resolve(req);
	assert.equal(result.kind, "verified");
	if (result.kind !== "verified") throw new Error("Expected delegated caller");
	assert.equal(result.caller.principalType, "user");
	assert.equal(result.caller.principalId, "human-owner");
	assert.equal(result.caller.delegatedToolName, operation);
	assert.deepEqual(result.caller.scopes, [
		requiredDurableCodeCapability(operation) === "mcp:tedis.read"
			? "tedi:config.read"
			: "tedi:config.write",
	]);
	assert.equal(
		result.canManage,
		requiredDurableCodeCapability(operation) === "mcp:tedis.admin",
	);
	assert.deepEqual(await resolve(req, { trustedServiceBinding: false }), {
		kind: "denied",
		reason: "untrusted_transport",
	});
	assert.equal((await resolve(req, { organizationId: tediId })).kind, "denied");
	assert.equal((await resolve(req, { tediId: organizationId })).kind, "denied");
	assert.equal((await resolve(req, { now: now + 60_000 })).kind, "denied");
	assert.equal((await resolve(req, { now: now - 5_001 })).kind, "denied");
}

const original = await request("get_code_execution", inputs.get_code_execution);
const headers = original.headers;
const tampered = (name: string, args: unknown) =>
	new Request(original.url, {
		method: "POST",
		headers,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
assert.equal(
	(await resolve(tampered("approve_code_execution", inputs.get_code_execution)))
		.kind,
	"denied",
);
assert.equal(
	(await resolve(tampered("get_code_execution", { execution_id: "different" })))
		.kind,
	"denied",
);
assert.equal(
	(
		await resolve(
			tampered("get_code_execution", {
				...inputs.get_code_execution,
				extra: true,
			}),
		)
	).kind,
	"denied",
);
assert.equal((await resolve(tampered("get_info", {}))).kind, "denied");
assert.equal(
	(
		await resolve(
			new Request(original.url, { method: "POST", headers, body: "[]" }),
		)
	).kind,
	"denied",
);
assert.deepEqual(await resolve(new Request(original.url)), { kind: "absent" });
assert.equal(
	canManageDurableCode({ scopes: ["tedi:admin"], authMethod: "api-key" }),
	true,
);
assert.equal(canManageDurableCode({ scopes: ["tedi:admin"], tediId }), false);
const machineEnvelope = await createMachineDurableCodeDelegation({
	tediId,
	organizationId,
	operation: "run_durable_code",
	arguments: inputs.run_durable_code,
	now,
	caller: {
		classification: "api-key",
		principal: {
			authenticated: true,
			verified: true,
			source: "api-key",
			subject: "key-id",
			orgId: organizationId,
			scopes: ["mcp:tedis.write"],
			audiences: [],
		},
	},
});
const machineRequest = await request(
	"run_durable_code",
	inputs.run_durable_code,
);
machineRequest.headers.set(
	DURABLE_CODE_DELEGATION_HEADER,
	JSON.stringify(machineEnvelope),
);
const machineResult = await resolve(machineRequest);
assert.equal(machineResult.kind, "verified");
if (machineResult.kind !== "verified")
	throw new Error("Expected machine provenance");
assert.equal(machineResult.canManage, false);
assert.equal(machineResult.caller.principalType, "api_key");
assert.equal(machineResult.caller.principalId, "key-id");
const bound = bindModernMcpRequest(
	"tools/call",
	{ name: "get_code_execution", arguments: inputs.get_code_execution },
	{ clientName: "tedix-api-durable-code" },
);
const modern = (params: Record<string, unknown>) =>
	new Request(original.url, {
		method: "POST",
		headers: {
			...bound.headers,
			[DURABLE_CODE_DELEGATION_HEADER]: headers.get(
				DURABLE_CODE_DELEGATION_HEADER,
			)!,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params,
		}),
	});
assert.equal((await resolve(modern(bound.params))).kind, "verified");
const meta = bound.params._meta as Record<string, unknown>;
for (const invalidMeta of [
	{ ...meta, unknownAuthority: "admin" },
	{ ...meta, [MCP_PROTOCOL_VERSION_META_KEY]: "2025-03-26" },
	{ ...meta, [MCP_CLIENT_CAPABILITIES_META_KEY]: "not-an-object" },
	{ ...meta, [MCP_CLIENT_CAPABILITIES_META_KEY]: { arbitraryAuthority: true } },
]) {
	assert.equal(
		(await resolve(modern({ ...bound.params, _meta: invalidMeta }))).kind,
		"denied",
	);
}
assert.equal(
	(
		await resolve(
			modern({ ...bound.params, arguments: { execution_id: "tampered" } }),
		)
	).kind,
	"denied",
);
// Exercise the same protocol binding, ingress delegation, private caller
// handoff, and native transport used by the API relay, without a Worker Loader.
async function invokeNative(
	operation: "list_code_executions" | "get_code_execution",
	tools: AgentMcpTools,
) {
	const delegated = await request(operation, inputs[operation]);
	const binding = bindModernMcpRequest(
		"tools/call",
		{ name: operation, arguments: inputs[operation] },
		{ clientName: "tedix-api-durable-code" },
	);
	const relayHeaders = new Headers(delegated.headers);
	for (const [name, value] of Object.entries(binding.headers))
		relayHeaders.set(name, value);
	relayHeaders.set("Content-Type", "application/json");
	relayHeaders.set("Accept", "application/json, text/event-stream");
	const relay = new Request(delegated.url, {
		method: "POST",
		headers: relayHeaders,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: binding.params,
		}),
	});
	const provenance = await resolve(relay);
	assert.equal(provenance.kind, "verified");
	if (provenance.kind !== "verified") throw new Error("Expected relay caller");
	relay.headers.set(
		TEDI_MCP_AUTH_CONTEXT_HEADER,
		encodeTediMcpCaller(provenance.caller),
	);
	relay.headers.set(
		"X-Tedix-Can-Manage-Durable-Code",
		String(provenance.canManage),
	);
	const response = await handleMcp(relay, "cto", tools);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
	const payload = (await response.json()) as {
		jsonrpc: string;
		id: number;
		error?: unknown;
		result: {
			isError?: boolean;
			structuredContent?: unknown;
			content: Array<{ type: string; text?: string }>;
		};
	};
	assert.equal(payload.jsonrpc, "2.0");
	assert.equal(payload.id, 1);
	assert.equal(payload.error, undefined);
	return payload.result;
}
const unused = async () => {
	throw new Error("Unexpected unrelated tool invocation");
};
const baseTools: AgentMcpTools = {
	conversationGet: unused,
	conversationsList: unused,
	messagesRead: unused,
	messagesSend: unused,
};
const listProjection = { executions: [{ executionId: "exec_1_uuid" }] };
const getProjection = { executionId: "exec_1_uuid", status: "completed" };
const received: unknown[] = [];
const nativeTools: AgentMcpTools = {
	...baseTools,
	listCodeExecutions: async (input) => {
		received.push(input);
		return listProjection;
	},
	getCodeExecution: async (input) => {
		received.push(input);
		return getProjection;
	},
};
for (const [operation, projection] of [
	["list_code_executions", listProjection],
	["get_code_execution", getProjection],
] as const) {
	const result = await invokeNative(operation, nativeTools);
	assert.notEqual(result.isError, true);
	assert.deepEqual(result.structuredContent, projection);
	assert.deepEqual(JSON.parse(result.content[0]!.text!), projection);
}
assert.deepEqual(received, [
	inputs.list_code_executions,
	inputs.get_code_execution,
]);
const toolFailure = await invokeNative("get_code_execution", {
	...baseTools,
	getCodeExecution: async () => {
		throw new Error("Synthetic native handler failure");
	},
});
assert.equal(toolFailure.isError, true);
console.log(
	"durable-code-delegation ingress and native transport tests passed",
);

const recoveryRequest = await request("recover_code_execution", {
	execution_id: "exec_recovery",
});
assert.equal(
	canRecoverDurableCode(await resolve(recoveryRequest.clone())),
	true,
);
const changedRecoveryBody = (await recoveryRequest.clone().json()) as {
	params: { arguments: Record<string, string> };
};
changedRecoveryBody.params.arguments.execution_id = "another";
assert.equal(
	canRecoverDurableCode(
		await resolve(
			new Request(recoveryRequest, {
				method: "POST",
				body: JSON.stringify(changedRecoveryBody),
			}),
		),
	),
	false,
);
assert.equal(
	canRecoverDurableCode(
		await resolve(
			await request("approve_code_execution", {
				execution_id: "exec_recovery",
			}),
		),
	),
	false,
);
for (const headers of [
	{ Authorization: "Bearer fake-user-jwt" },
	{ "X-API-Key": "fake-operator" },
	{ "X-Service-Binding": "true" },
	{ "X-Tedix-Auth-Can-Recover-Durable-Code": "true" },
] as Array<Record<string, string>>) {
	const forged = new Request("https://worker.invalid/mcp", {
		method: "POST",
		headers,
	});
	assert.equal(canRecoverDurableCode(await resolve(forged)), false);
}
assert.equal(
	canRecoverDurableCode({ kind: "denied", reason: "invalid_request" }),
	false,
);

for (const resolved of [
	await resolve(
		await request("recover_code_execution", { execution_id: "exec_recovery" }),
	),
	await resolve(
		await request("approve_code_execution", { execution_id: "exec_recovery" }),
	),
	{ kind: "absent" as const },
	{ kind: "denied" as const, reason: "invalid_envelope" },
]) {
	const headers = new Headers({
		"X-Tedix-Auth-Can-Recover-Durable-Code": "true",
	});
	applyDurableCodeRecoveryAuthority(headers, resolved);
	assert.equal(
		headers.get("X-Tedix-Auth-Can-Recover-Durable-Code"),
		String(canRecoverDurableCode(resolved)),
	);
}

const machineResolved = await resolve(
	new Request("https://worker.invalid/mcp", {
		method: "POST",
		headers: {
			[DURABLE_CODE_DELEGATION_HEADER]: JSON.stringify(machineEnvelope),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "run_durable_code", arguments: inputs.run_durable_code },
		}),
	}),
);
const machineHeaders = new Headers({
	"X-Tedix-Auth-Can-Recover-Durable-Code": "true",
});
applyDurableCodeRecoveryAuthority(machineHeaders, machineResolved);
assert.equal(
	machineHeaders.get("X-Tedix-Auth-Can-Recover-Durable-Code"),
	"false",
);
