import { strict as assert } from "node:assert";
import { shouldHydrateCodeModeForMcpRequest } from "./mcp-code-mode-hydration";

function mcpPost(body: unknown) {
	return new Request("https://cto.tedi.tedix.dev/mcp", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "read_execution",
				arguments: { executionId: "smoke" },
			},
		}),
	),
	false,
	"direct execution reads do not hydrate Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: "ts-validate",
			method: "tools/call",
			params: {
				name: "read",
				arguments: { paths: ["repo/src/index.ts"] },
			},
		}),
	),
	false,
	"direct Computer reads does not hydrate Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: "worker-bundle-validate",
			method: "tools/call",
			params: {
				name: "exec",
				arguments: {
					entryPoint: "repo/src/index.ts",
					paths: ["repo/src/index.ts"],
				},
			},
		}),
	),
	false,
	"direct Computer commands does not hydrate Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: "repo-commit-status",
			method: "tools/call",
			params: {
				name: "repo_commit_status",
				arguments: { executionLedgerId: "repo-commit-1" },
			},
		}),
	),
	false,
	"direct repo_commit_status reads do not hydrate Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: "messages-send",
			method: "tools/call",
			params: {
				name: "run_tedi_turn",
				arguments: {
					session_key: "agent:main:main",
					text: "run assigned work",
					client_request_id: "autonomy-canary",
				},
			},
		}),
	),
	false,
	"direct durable run_tedi_turn turns do not hydrate request-scoped Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "code", arguments: { code: "async () => 1" } },
		}),
	),
	true,
	"Code Mode tool calls hydrate Code Mode",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: "execute",
			method: "tools/call",
			params: { name: "execute", arguments: { code: "async () => 1" } },
		}),
	),
	true,
	"direct execute calls hydrate Code Mode because execute is a Code Mode extra",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
	),
	true,
	"tools/list hydrates Code Mode so code appears in discovery",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({ jsonrpc: "2.0", id: 4, method: "initialize", params: {} }),
	),
	false,
	"initialize stays lightweight; tools/list hydrates Code Mode when needed",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost([
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "read_execution", arguments: {} },
			},
			{
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { name: "execute", arguments: {} },
			},
		]),
	),
	true,
	"batch requests hydrate Code Mode when any item needs it",
);

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({ jsonrpc: "2.0", id: "discover", method: "server/discover" }),
	),
	false,
	"server/discover stays lightweight for proxy negotiation",
);

for (const name of ["execute_muscle_code", "save_muscle_code"]) {
	const request = {
		jsonrpc: "2.0",
		id: name,
		method: "tools/call",
		params: { name, arguments: {} },
	};
	for (const payload of [request, [request]]) {
		assert.equal(
			await shouldHydrateCodeModeForMcpRequest(mcpPost(payload)),
			false,
			`${name} is an ordinary configured tool, not a Code Mode hydration trigger`,
		);
	}
}

console.log("All mcp-mount tests passed.");

assert.equal(
	await shouldHydrateCodeModeForMcpRequest(
		mcpPost({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "recover_code_execution",
				arguments: { execution_id: "exact" },
			},
		}),
	),
	false,
	"explicit native recovery does not hydrate Code Mode",
);
