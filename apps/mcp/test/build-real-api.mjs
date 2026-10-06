import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mcpDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(mcpDir, "../..");
const dbDir = join(repoDir, "packages/db");
const apiDir = join(repoDir, "apps/api");
const localRunner = join(repoDir, "scripts/dev-local.ts");
const temp = mkdtempSync(join(tmpdir(), "tedix-workerd-boundary-"));
const seed = join(temp, "seed.sql");
const callerWorker = join(temp, "internal-caller.mjs");
const callerConfig = join(temp, "internal-caller.wrangler.json");
writeFileSync(
	callerWorker,
	`export default {
	async fetch(request, env) {
		if (new URL(request.url).pathname === "/health") return new Response("ok");
		const response = await env.MCP_SERVICE.fetch("https://pilot.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Host": "pilot.localhost",
				"X-Tedix-Org-Id": "00000000-0000-4000-8000-000000000001",
				// Synthetic internal actor: the binding, not this test UUID, is trusted.
				"X-Tedix-Tedi-Id": "00000000-0000-4000-8000-000000000004",
				"X-Tedix-Tedi-Scopes": "apps:read",
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": "tools/call",
				"Mcp-Name": "get_fixture_status",
			},
			body: await request.text(),
		});
		return response;
	},
};\n`,
);
writeFileSync(
	callerConfig,
	JSON.stringify({
		name: "local-mcp-caller",
		main: callerWorker,
		compatibility_date: "2026-08-06",
		services: [
			{
				binding: "MCP_SERVICE",
				service: "tedix-mcp",
				entrypoint: "InternalEntrypoint",
			},
		],
	}),
);
writeFileSync(
	seed,
	`INSERT INTO organizations (id, name, slug)
VALUES ('00000000-0000-4000-8000-000000000001', 'Workerd fixture', 'workerd-fixture');

INSERT INTO apps (id, organization_id, name, slug, openai_challenge_token, metadata)
VALUES (
	'00000000-0000-4000-8000-000000000002',
	'00000000-0000-4000-8000-000000000001',
	'Pilot app',
	'pilot',
	'workerd-real-api-challenge',
	'{"mcpConfig":{"authMode":"public"}}'
);

INSERT INTO app_tools (id, app_id, tool_type_id, tool_id, title, description, input_schema, config, write_capability)
VALUES (
	'00000000-0000-4000-8000-000000000003',
	'00000000-0000-4000-8000-000000000002',
	'rpc',
	'get_fixture_status',
	'Get fixture status',
	'A local inventory fixture served by the real API and MCP Workers',
	'{"type":"object","properties":{"fixtureId":{"type":"string"}},"required":["fixtureId"],"additionalProperties":false}',
	'{"transport":"rpc","endpoint":"apps/getBySlugWithTools","paramMap":{"fixtureId":"slug"}}',
	'read'
);\n`,
);
const baseEnv = {
	...process.env,
	TEDIX_LOCAL_INFERENCE_ENABLED: "false",
	TEDIX_LOCAL_PERSIST_TO: join(temp, "state"),
	TEDIX_LOCAL_REGISTRY_PATH: join(temp, "registry"),
};
const sandboxProfile =
	'(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))';
const children = [];

function tail(value, length = 4000) {
	return value.length > length ? value.slice(-length) : value;
}

function launch(cwd, args, env = baseEnv, runner = ["bun", localRunner, "--"]) {
	// This opt-in suite requires macOS sandbox-exec. All Worker subprocesses
	// inherit its outbound policy; only loopback service bindings can connect.
	const child = spawn(
		"sandbox-exec",
		["-p", sandboxProfile, ...runner, ...args],
		{
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		},
	);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			output = tail(output + chunk, 8000);
		});
	}
	children.push(child);
	return { child, output: () => output };
}

async function command(cwd, args, env) {
	const process = launch(cwd, args, env);
	const code = await new Promise((resolveCode, reject) => {
		process.child.once("error", reject);
		process.child.once("exit", (exitCode) => resolveCode(exitCode));
	});
	assert.equal(code, 0, `Local Wrangler command failed:\n${process.output()}`);
}

async function freePort() {
	const server = createServer();
	await new Promise((resolveListen) =>
		server.listen(0, "127.0.0.1", resolveListen),
	);
	const address = server.address();
	assert(address && typeof address !== "string");
	await new Promise((resolveClose) => server.close(resolveClose));
	return address.port;
}

async function waitForHealth(process, port) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		if (process.child.exitCode !== null) {
			throw new Error(
				`Worker exited before becoming healthy:\n${process.output()}`,
			);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`, {
				signal: AbortSignal.timeout(1000),
			});
			if (response.ok) return;
		} catch {
			// Wrangler is still starting.
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	throw new Error(`Worker health timeout:\n${process.output()}`);
}

async function stopChildren() {
	for (const child of children) {
		if (child.exitCode === null) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				// Already exited.
			}
		}
	}
	await Promise.all(
		children.map(
			(child) =>
				new Promise((resolveExit) => {
					if (child.exitCode !== null) return resolveExit();
					child.once("exit", resolveExit);
					setTimeout(resolveExit, 3000).unref();
				}),
		),
	);
}

try {
	assert.equal(
		process.platform,
		"darwin",
		"Real API workerd test requires macOS sandbox-exec",
	);
	await command(dbDir, ["wrangler", "d1", "migrations", "apply", "DB"]);
	await command(dbDir, ["wrangler", "d1", "execute", "DB", "--file", seed]);
	const apiPort = await freePort();
	const mcpPort = await freePort();
	const callerPort = await freePort();
	const api = launch(apiDir, ["wrangler", "dev", "--port", String(apiPort)]);
	await waitForHealth(api, apiPort);
	const mcp = launch(
		mcpDir,
		[
			"vp",
			"dev",
			"--port",
			String(mcpPort),
			"--strictPort",
			"--host",
			"127.0.0.1",
		],
		{
			...baseEnv,
			TEDIX_LOCAL_API_URL: `http://127.0.0.1:${apiPort}`,
		},
	);
	await waitForHealth(mcp, mcpPort);
	// The caller is a throwaway Worker with its own config, so it runs Wrangler
	// directly against the registry the other Workers registered in.
	const caller = launch(
		temp,
		["dev", "--config", callerConfig, "--port", String(callerPort), "--local"],
		{
			...baseEnv,
			WRANGLER_REGISTRY_PATH: baseEnv.TEDIX_LOCAL_REGISTRY_PATH,
			MINIFLARE_REGISTRY_PATH: baseEnv.TEDIX_LOCAL_REGISTRY_PATH,
		},
		[join(repoDir, "node_modules/.bin/wrangler")],
	);
	await waitForHealth(caller, callerPort);
	const response = await fetch(
		`http://127.0.0.1:${mcpPort}/.well-known/openai-apps-challenge`,
		{ headers: { "X-Tedix-Host": "pilot.localhost" } },
	);
	const body = await response.text();
	assert.equal(response.status, 200, `MCP response: ${body}\n${mcp.output()}`);
	assert.equal(body, "workerd-real-api-challenge");
	assert.equal(
		response.headers.get("cache-tag"),
		"app:00000000-0000-4000-8000-000000000002",
	);
	assert.match(api.output(), /\/rpc\/apps\/getBySlugWithTools/);
	const list = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
		method: "POST",
		headers: {
			"X-Tedix-Host": "pilot.localhost",
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/list",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": { extensions: {} },
				},
			},
		}),
	});
	const listBody = await list.text();
	assert.equal(
		list.status,
		200,
		`MCP tools/list: ${listBody}\n${mcp.output()}`,
	);
	const messages = listBody
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()));
	const result = list.headers.get("content-type")?.includes("text/event-stream")
		? messages.find((message) => message.id === 1)
		: JSON.parse(listBody);
	const tool = result?.result?.tools?.find(
		(entry) => entry.name === "get_fixture_status",
	);
	assert.deepEqual(tool?.inputSchema, {
		type: "object",
		properties: { fixtureId: { type: "string" } },
		required: ["fixtureId"],
		additionalProperties: false,
	});
	const callRequestBody = JSON.stringify({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "get_fixture_status",
			arguments: { fixtureId: "pilot" },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": { extensions: {} },
			},
		},
	});
	const anonymousCall = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
		method: "POST",
		headers: {
			"X-Tedix-Host": "pilot.localhost",
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "tools/call",
			"Mcp-Name": "get_fixture_status",
		},
		body: callRequestBody,
	});
	const anonymousBody = await anonymousCall.text();
	assert.equal(anonymousCall.status, 200);
	assert.match(
		anonymousBody,
		/Delegated service-binding scope 'apps:read' required/,
	);
	const call = await fetch(`http://127.0.0.1:${callerPort}/call`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: callRequestBody,
	});
	const callBody = await call.text();
	assert.equal(
		call.status,
		200,
		`MCP tools/call: ${callBody}\n${caller.output()}\n${mcp.output()}`,
	);
	const callResult = call.headers
		.get("content-type")
		?.includes("text/event-stream")
		? callBody
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => JSON.parse(line.slice(5).trim()))
				.find((message) => message.id === 2)
		: JSON.parse(callBody);
	assert.equal(
		callResult?.result?.isError,
		undefined,
		`MCP tool error: ${callBody}\nAPI: ${tail(api.output(), 1200)}\nCaller: ${tail(caller.output(), 1200)}\nMCP: ${tail(mcp.output(), 1200)}`,
	);
	assert.equal(callResult?.result?.structuredContent?.app?.slug, "pilot");
	assert.equal(
		callResult?.result?.structuredContent?.tools?.[0]?.toolId,
		"get_fixture_status",
	);
	assert.match(api.output(), /\/rpc\/apps\/getBySlugWithTools/);
	console.log(
		"Real MCP → API service binding → local D1 app, tool discovery, and tool execution passed (outbound denied).",
	);
} finally {
	await stopChildren();
	rmSync(temp, { recursive: true, force: true });
}
