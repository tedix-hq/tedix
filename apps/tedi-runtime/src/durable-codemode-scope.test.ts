import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import {
	encodeTediMcpCaller,
	TEDI_MCP_AUTH_CONTEXT_HEADER,
} from "./mcp-authorization";

const mutations: string[] = [];
let executionScope = { kind: "conversation", key: "mcp-run:other" };
const agent = tediDo({
	env: {},
	state: { slug: "example", tediId: "tedi-example" },
	async ensureIdentity() {},
	computerWorkspace: () => ({ workspace: {} }),
	workstationAiTool: () => ({}),
	computerCodeRouting: { resolve: async () => executionScope },
	approveDurableCodeExecution: async () => {
		mutations.push("approve");
		return {};
	},
	rejectDurableCodeExecution: async () => {
		mutations.push("reject");
		return {};
	},
	rollbackDurableCodeExecution: async () => {
		mutations.push("rollback");
		return {};
	},
});
for (const action of ["approve", "reject", "rollback"]) {
	for (const scope of [
		{ kind: "conversation", key: "mcp-run:other" },
		{ kind: "delegated-run", key: "mcp-run:caller" },
	]) {
		executionScope = scope;
		const response = await agent.onRequest(
			new Request("https://runtime.example/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"X-Tedix-Can-Manage-Durable-Code": "true",
					[TEDI_MCP_AUTH_CONTEXT_HEADER]: encodeTediMcpCaller({
						method: "jwt",
						principalId: "operator",
						principalType: "user",
						scopes: ["tedi:config.write"],
					}),
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: `${action}_code_execution`,
						arguments: {
							execution_id: "execution-example",
							...(action === "reject" ? { seq: 0 } : {}),
						},
						_meta: { "io.tedix/kernelRunId": "caller" },
					},
				}),
			}),
		);
		const body = await response.text();
		assert.match(
			body,
			/Execution belongs to another Computer workspace/,
			`${action}: ${body}`,
		);
		assert.deepEqual(mutations, []);
	}
}
console.log("durable-codemode-scope OK");
