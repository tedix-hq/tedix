import { writeWorkspaceCredentials } from "./credential-store";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaneReporter } from "./lane-reporter";

const callable = "work.report_work_agent_session_status";
const descriptor = (name: string, endpoint: string) => ({
	name,
	endpoint,
	toolRowId: `row-${name}`,
	eligible: true,
	authorized: true,
	schemaFreshness: {
		source: "orpc",
		sourceRef: endpoint,
		sourceHash: "fixture-hash",
		syncedAt: "2026-10-07T12:00:00Z",
	},
});

test("lane reporting reuses an in-process owner client and counts only one request per warm report", async () => {
	const dir = mkdtempSync(join(tmpdir(), "lane-reporter-test-"));
	const keys = [
		"TEDIX_CONFIG_DIR",
		"TEDIX_MCP_BEARER_TOKEN",
		"TEDIX_MCP_API_KEY",
		"TEDIX_MCP_URL",
		"TEDIX_ORGANIZATION",
		"TEDIX_EXTERNAL_AGENT",
	];
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	);
	const requests: Array<{ method: string; params?: { name: string } }> = [];
	const native = descriptor("configured_report", "workAgentSessions/report");
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const rpc = (await request.json()) as {
				id: string;
				method: string;
				params?: { name: string };
			};
			requests.push(rpc);
			expect(request.headers.get("Authorization")).toBe(
				"Bearer fictional-owner",
			);
			const name = rpc.params?.name;
			const value =
				name === "get_info"
					? {
							nativeContext: {
								version: 1,
								surface: "mcp-gateway",
								appId: "fixture",
								appSlug: "fixture",
								organizationId: "99999999-9999-4999-8999-999999999999",
								actor: { authType: "user" },
								nativeTransportAvailable: true,
							},
							nativeCatalog: {
								status: "usable",
								search: descriptor("catalog_search", "catalog/search"),
								describe: descriptor("catalog_describe", "catalog/describe"),
							},
						}
					: name === "catalog_search"
						? {
								results: [
									{ callable, authorized: true, native, outputSchema: {} },
								],
							}
						: name === "catalog_describe"
							? {
									callable,
									authorized: true,
									native,
									schemaFreshness: native.schemaFreshness,
									parameters: { type: "object" },
								}
							: { saved: true };
			const result =
				rpc.method === "server/discover"
					? { supportedVersions: ["2026-07-28"], capabilities: {} }
					: { resultType: "complete", content: [], structuredContent: value };
			return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
		},
	});
	const reporter = createLaneReporter();
	try {
		process.env.TEDIX_CONFIG_DIR = dir;
		process.env.TEDIX_MCP_BEARER_TOKEN = "must-not-be-used";
		writeWorkspaceCredentials("fixture", {
			loginId: "fixture-owner",
			mcpUrl: `http://127.0.0.1:${server.port}/mcp`,
			oauthTokens: { access_token: "fictional-owner", token_type: "Bearer" },
		});
		process.env.TEDIX_MCP_URL = `http://127.0.0.1:${server.port}/mcp`;
		process.env.TEDIX_EXTERNAL_AGENT = "must-not-be-used";
		delete process.env.TEDIX_ORGANIZATION;
		await reporter.report({ state: "working" }, ["-w", "fixture"]);
		expect(requests).toHaveLength(5);
		requests.length = 0;
		await reporter.report({ state: "working" }, ["-w", "fixture"]);
		await reporter.report({ state: "done" }, ["-w", "fixture"]);
		expect(requests.map((r) => r.params?.name)).toEqual([
			"configured_report",
			"configured_report",
		]);
		await expect(reporter.report({}, ["-w", "other"])).rejects.toThrow(
			"organization changed",
		);
	} finally {
		await reporter.close();
		server.stop(true);
		for (const key of keys) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
