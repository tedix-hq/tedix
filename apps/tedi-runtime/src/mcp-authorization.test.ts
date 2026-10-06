import {
	isTediMcpToolReadOnly,
	requiredTediMcpToolScope,
} from "@tedix/mcp-shared/auth/scopes";
import assert from "node:assert/strict";
import {
	canCallTediMcpTool,
	decodeTediMcpCaller,
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";
import {
	type AgentMcpTools,
	handleMcp,
	rejectUnauthorizedToolCall,
	type TediMcpAuditEvent,
} from "./mcp-mount";

const reader = {
	method: "jwt" as const,
	principalId: "user-1",
	principalType: "user" as const,
	scopes: ["tedi:channel.read", "tedi:brain.read"],
};
const auditEvents: Parameters<
	NonNullable<AgentMcpTools["recordMcpAuditEvent"]>
>[0][] = [];
assert.equal(
	requiredTediMcpToolScope("messages_read", true),
	"tedi:channel.read",
);
assert.equal(
	requiredTediMcpToolScope("run_tedi_turn", false),
	"tedi:channel.write",
);

const denied = await rejectUnauthorizedToolCall(
	new Request("https://cto.tedi.tedix.dev/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Mcp-Method": "tools/call" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "run_tedi_turn", arguments: {} },
		}),
	}),
	reader,
	async (event) => {
		auditEvents.push(event);
	},
);
assert.equal(denied?.status, 403);
assert.match(
	denied?.headers.get("WWW-Authenticate") ?? "",
	/insufficient_scope/,
);
assert.deepEqual(await denied?.json(), {
	jsonrpc: "2.0",
	id: 7,
	error: {
		code: -32003,
		message: "Insufficient scope",
		data: { error: "insufficient_scope", required_scope: "tedi:channel.write" },
	},
});
assert.equal(auditEvents[0]?.action, "mcp.tool.denied");
assert.equal(auditEvents[0]?.resourceId, "run_tedi_turn");
assert.equal(
	await rejectUnauthorizedToolCall(
		new Request("https://cto.tedi.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Mcp-Method": "tools/call",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 9,
				method: "tools/call",
				params: { name: "code", arguments: {} },
			}),
		}),
		{ ...reader, delegatedToolName: "conversations_list" },
	),
	null,
);

const listRequest = new Request("https://cto.tedi.tedix.dev/mcp", {
	method: "POST",
	headers: {
		Accept: "application/json, text/event-stream",
		"Content-Type": "application/json",
		"Mcp-Method": "tools/list",
		"Mcp-Protocol-Version": "2026-07-28",
		[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller(reader),
	},
	body: JSON.stringify({
		jsonrpc: "2.0",
		id: 8,
		method: "tools/list",
		params: {
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": {
					name: "authorization-test",
					version: "1",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		},
	}),
});
const tools = {
	recordMcpAuditEvent: async (event: TediMcpAuditEvent) => {
		auditEvents.push(event);
	},
	conversationGet: async () => ({}),
	conversationsList: async () => ({}),
	messagesRead: async () => ({}),
	messagesSend: async () => ({}),
} as unknown as AgentMcpTools;
const listResponse = await handleMcp(listRequest, "cto", tools);
assert.equal(listResponse.status, 200);
const listed = (await listResponse.json()) as {
	result?: { tools?: Array<{ name: string }> };
};
const names = listed.result?.tools?.map((tool) => tool.name) ?? [];
assert.equal(names.includes("messages_read"), true);
assert.equal(names.includes("run_tedi_turn"), false);
const callResponse = await handleMcp(
	new Request("https://cto.tedi.tedix.dev/mcp", {
		method: "POST",
		headers: {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "messages_read",
			"Mcp-Protocol-Version": "2026-07-28",
			[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller(reader),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: {
				name: "messages_read",
				arguments: { session_key: "main" },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": {
						name: "authorization-test",
						version: "1",
					},
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	}),
	"cto",
	tools,
);
assert.equal(callResponse.status, 200);
assert.equal(auditEvents.at(-1)?.action, "mcp.tool.execute");
assert.equal(auditEvents.at(-1)?.resourceId, "messages_read");
assert.equal(auditEvents.at(-1)?.metadata.outcome, "success");
assert.equal(
	requiredTediMcpToolScope("audit_memory_graph", true),
	"tedi:brain.read",
);
assert.equal(
	requiredTediMcpToolScope("write_workspace_file", false),
	"tedi:config.write",
);
assert.equal(isTediMcpToolReadOnly("messages_read"), true);
assert.equal(isTediMcpToolReadOnly("run_tedi_turn"), false);
assert.equal(canCallTediMcpTool(reader, "messages_read", true), true);
assert.equal(canCallTediMcpTool(reader, "run_tedi_turn", false), false);
assert.equal(
	canCallTediMcpTool(
		{ ...reader, scopes: ["tedi:admin"] },
		"write_workspace_file",
		false,
	),
	true,
);

const request = new Request("https://cto.tedi.tedix.dev/mcp", {
	headers: { [TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller(reader) },
});
assert.deepEqual(decodeTediMcpCaller(request), reader);
assert.equal(
	decodeTediMcpCaller(
		new Request("https://cto.tedi.tedix.dev/mcp", {
			headers: { [TEDI_MCP_AUTH_CONTEXT_HEADER]: "%7Bbad" },
		}),
	),
	null,
);
console.log("All mcp-authorization tests passed.");
