import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
	ensureWebMcpBridge,
	handleWebMcpRequest,
	WEBMCP_BRIDGE_PATH,
	WEBMCP_MCP_PATH,
	WEBMCP_PROTOCOL_VERSION,
	webMcpBridgeScriptResponse,
	type WebMcpOrgInfo,
} from "../src/webmcp";

const schemaPath = fileURLToPath(
	new URL("../webmcp-evals/schema.json", import.meta.url),
);
const evalsPath = fileURLToPath(
	new URL("../webmcp-evals/evals.json", import.meta.url),
);

// The `webmcp-evals smoke` CLI launches Chrome through Puppeteer's fixed 30 s
// launch timeout. Chrome usually starts in 6-12 s on CI, but a loaded runner
// right after the Worker test pool has taken over 30 s and failed the check
// before any WebMCP code ran. Run the same smoke evaluator here and launch
// Chrome with the CLI's flags and a budget that covers a slow runner.
const CHROME_LAUNCH_TIMEOUT_MS = 120_000;
const smokeEvaluatorUrl = import.meta
	.resolve("webmcp-evals/dist/evaluator/smokeEvaluator.js");
const { executeSmokeEvals } = (await import(smokeEvaluatorUrl)) as {
	executeSmokeEvals(
		tests: unknown[],
		config: {
			url: string;
			timeoutMs: number;
			verbose: boolean;
			chromeChannel: string;
		},
		dependencies: { launchBrowser: () => Promise<unknown> },
	): Promise<{
		results: {
			testName: string;
			stepIndex: number;
			functionName: string;
			outcome: "pass" | "error";
			error?: string;
		}[];
		passCount: number;
		errorCount: number;
		totalExpectedSteps: number;
	}>;
};
const { PUPPETEER_FLAGS } =
	(await import("webmcp-evals/dist/evaluator/browser.js")) as {
		PUPPETEER_FLAGS: string[];
	};
// puppeteer-core is a dependency of webmcp-evals, not of this workspace;
// resolve the copy the evaluator itself uses.
const puppeteer = (await import(
	createRequire(smokeEvaluatorUrl).resolve("puppeteer-core")
)) as {
	default: { launch(options: Record<string, unknown>): Promise<unknown> };
};

async function launchChrome(): Promise<unknown> {
	const started = performance.now();
	const browser = await puppeteer.default.launch({
		browser: "chrome",
		channel: "chrome",
		headless: true,
		args: [...PUPPETEER_FLAGS],
		timeout: CHROME_LAUNCH_TIMEOUT_MS,
	});
	console.log(
		`Chrome started in ${Math.round(performance.now() - started)} ms (budget ${CHROME_LAUNCH_TIMEOUT_MS} ms)`,
	);
	return browser;
}

let origin = "";
const org = (): WebMcpOrgInfo => ({
	slug: "tedix",
	siteTitle: "Tedix",
	publicSiteUrl: origin,
	publicPathPrefix: null,
	webMcpToolPacks: ["site-search", "page-reader"],
});
const limiter = {
	async limit() {
		return { success: true };
	},
};

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === WEBMCP_BRIDGE_PATH)
			return webMcpBridgeScriptResponse(request.method === "HEAD");
		if (url.pathname === WEBMCP_MCP_PATH)
			return (
				(await handleWebMcpRequest(request, org(), WEBMCP_MCP_PATH, limiter)) ??
				new Response("Not found", { status: 404 })
			);
		if (url.pathname === "/_tedix/search.json")
			return Response.json({
				data: {
					items: [
						{
							collection: "posts",
							id: "agents",
							title: "Agents, apps, and work",
							url: `${origin}/blog/agents`,
							snippet: "How agents and people share work in Tedix.",
						},
					],
				},
			});
		if (url.pathname === "/blog/agents")
			return new Response(
				"<!doctype html><title>Agents, apps, and work</title><body><main><h1>Agents, apps, and work</h1><p>Agents and people share project information, tasks, and results in Tedix.</p></main></body>",
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		if (url.pathname === "/")
			return new Response(
				ensureWebMcpBridge(
					"<!doctype html><html><head><title>Tedix CMS eval fixture</title></head><body></body></html>",
					org(),
				),
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		return new Response("Not found", { status: 404 });
	},
});
origin = server.url.origin;

function listRequest(): Request {
	return new Request(`${origin}${WEBMCP_MCP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"mcp-method": "tools/list",
			"mcp-protocol-version": WEBMCP_PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {},
			_meta: {
				"io.modelcontextprotocol/protocolVersion": WEBMCP_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientInfo": {
					name: "webmcp-evals-ci",
					version: "1",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		}),
	});
}

try {
	const response = await handleWebMcpRequest(
		listRequest(),
		org(),
		WEBMCP_MCP_PATH,
		limiter,
	);
	assert(response);
	const payload = (await response.json()) as {
		result: { tools: unknown[] };
	};
	const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
		tools: unknown[];
	};
	assert.deepEqual(
		schema.tools,
		payload.result.tools,
		"webmcp-evals/schema.json must match the CMS tools/list response",
	);

	const tests = JSON.parse(await readFile(evalsPath, "utf8")) as unknown[];
	const outcome = await executeSmokeEvals(
		tests,
		{ url: origin, timeoutMs: 30_000, verbose: true, chromeChannel: "chrome" },
		{ launchBrowser: launchChrome },
	);
	for (const result of outcome.results)
		console.log(
			`${result.outcome === "pass" ? "PASS" : "ERROR"} ${result.testName} step ${result.stepIndex} ${result.functionName}${result.error ? `: ${result.error}` : ""}`,
		);
	assert.equal(outcome.errorCount, 0, "webmcp-evals smoke failed");
	assert.equal(
		outcome.passCount,
		outcome.totalExpectedSteps,
		"webmcp-evals smoke did not run every step",
	);
	console.log(
		`webmcp-evals smoke passed ${outcome.passCount}/${outcome.totalExpectedSteps} steps`,
	);
} finally {
	await server.stop(true);
}
