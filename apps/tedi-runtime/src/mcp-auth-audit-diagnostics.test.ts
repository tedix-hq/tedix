import assert from "node:assert/strict";
import { createIsolateApiKeyValidator } from "./mcp-apikey";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import {
	handleMcp,
	rejectUnauthorizedToolCall,
	type AgentMcpTools,
} from "./mcp-mount";

const originalError = console.error;
const failures: unknown[][] = [];
console.error = (...args: unknown[]) => failures.push(args);

const secret = "sk_private_credential";
const thrown = new Error(`request-body ${secret}`, {
	cause: new TypeError("provider token and caller IP 203.0.113.9"),
});
thrown.name = "provider-secret-name";

const reader = {
	method: "jwt" as const,
	principalId: "user-private-identity",
	principalType: "user" as const,
	scopes: ["tedi:channel.read"],
};

function callRequest(name: string): Request {
	return new Request("https://cto.tedi.tedix.dev/mcp", {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Method": "tools/call",
			"Mcp-Name": name,
			"Mcp-Protocol-Version": "2026-07-28",
			[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller(reader),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name,
				arguments: { session_key: "private-session" },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": {
						name: "audit-diagnostics-test",
						version: "1",
					},
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
}

try {
	const denied = await rejectUnauthorizedToolCall(
		callRequest("run_tedi_turn"),
		reader,
		async () => {
			throw thrown;
		},
	);
	assert.equal(denied?.status, 403);
	const deniedBody = (await denied?.json()) as {
		error?: { message?: string };
	};
	assert.equal(deniedBody.error?.message, "Insufficient scope");

	const tools: AgentMcpTools = {
		recordMcpAuditEvent: async () => {
			throw thrown;
		},
		conversationGet: async () => ({}),
		conversationsList: async () => ({}),
		messagesRead: async () => ({ available: true }),
		messagesSend: async () => ({}),
	};
	const allowed = await handleMcp(callRequest("messages_read"), "cto", tools);
	assert.equal(allowed.status, 200);
	const allowedBody = (await allowed.json()) as {
		result?: { isError?: boolean };
	};
	assert.ok(allowedBody.result);
	assert.equal(allowedBody.result?.isError, undefined);
	assert.match(JSON.stringify(allowedBody), /available/);

	const failingDb = {
		prepare: () => ({
			bind: () => ({
				first: async () => {
					throw thrown;
				},
			}),
		}),
	} as unknown as D1Database;
	const request = new Request("https://cto.tedi.tedix.dev/mcp", {
		headers: { "CF-Connecting-IP": "203.0.113.9" },
	});
	assert.equal(
		await createIsolateApiKeyValidator(
			failingDb,
			{ orgId: "organization-1" },
			request,
		)(secret),
		null,
	);

	const usageDb = {
		prepare: (query: string) => ({
			bind: () => ({
				first: async () => ({
					id: "api-key-private-id",
					organizationId: "organization-1",
					status: "active",
					expiresAt: null,
					ipAllowlist: null,
				}),
				run: async () => {
					assert.match(query, /UPDATE api_keys/);
					throw thrown;
				},
			}),
		}),
	} as unknown as D1Database;
	const auth = await createIsolateApiKeyValidator(
		usageDb,
		{ orgId: "organization-1" },
		request,
	)(secret);
	assert.equal(auth?.authenticated, true);
	await new Promise((resolve) => setTimeout(resolve, 0));

	assert.deepEqual(
		failures.map(([entry]) => entry),
		[
			{
				component: "tedi-runtime-mcp",
				event: "tedi.mcp.audit_denial_failed",
				exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
			},
			{
				component: "tedi-runtime-mcp",
				event: "tedi.mcp.audit_execute_failed",
				exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
			},
			{
				component: "tedi-runtime-mcp",
				event: "tedi.mcp.api_key_validation_failed",
				exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
			},
			{
				component: "tedi-runtime-mcp",
				event: "tedi.mcp.api_key_usage_failed",
				exception: { type: "UnknownThrown", cause: { type: "TypeError" } },
			},
		],
	);
	assert.doesNotMatch(
		JSON.stringify(failures),
		/request-body|sk_private_credential|provider token|203\.0\.113\.9|user-private-identity|private-session|provider-secret-name|stack/,
	);
} finally {
	console.error = originalError;
}

console.log("MCP auth and audit failures keep bounded, content-free topology");
