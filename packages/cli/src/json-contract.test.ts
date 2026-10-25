import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOP_LEVEL_COMMANDS } from "./command-registry";

// Preload only in subprocesses: command implementations and their renderers stay real.
async function installTransportFixtures(src: string) {
	const { spyOn, mock } = await import("bun:test");
	const { TedixHomeClient } = await import(`${src}/home-client.ts`);
	const org = "99999999-9999-4999-8999-999999999999";
	const endpoints: Record<string, string> = {
		"attention.list_deck_cards": "attention/listDeckCards",
		"attention.list_feed_for_you": "attention/listFeedForYou",
		"work.list_work_item_cli_rows": "workItems/listCliProjection",
		"work.report_work_agent_session_status": "workAgentSessions/report",
		"catalog.search": "catalog/search",
		"catalog.describe": "catalog/describe",
	};
	const descriptor = (callable: string) => ({
		name: callable.replaceAll(".", "__"),
		endpoint: endpoints[callable],
		toolRowId: "fixture-row",
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: "orpc",
			sourceRef: endpoints[callable],
			sourceHash: "fixture",
			syncedAt: "2026-01-01T00:00:00Z",
		},
	});
	const values: Record<string, unknown> = {
		"attention.list_deck_cards": {
			cards: [],
			count: 0,
			complete: true,
			observedAt: "2026-01-01T00:00:00Z",
		},
		"attention.list_feed_for_you": {
			items: [],
			heldCount: 0,
			used: 0,
			day: "2026-01-01",
			complete: true,
			observedAt: "2026-01-01T00:00:00Z",
		},
		"decision.list_agent_decisions": {
			decisions: [],
			classes: [],
			summary: "No agent decisions to review.",
		},
		"work.list_work_item_cli_rows": {
			view: "board",
			data: [],
			pagination: { limit: 20, offset: 0, total: 0, hasMore: false },
		},
		"work.report_work_agent_session_status": { saved: true },
	};
	spyOn(TedixHomeClient.prototype, "callTool").mockImplementation(
		async (name: string, input: Record<string, unknown>) => {
			if (name === "get_info")
				return {
					nativeContext: {
						version: 1,
						surface: "mcp-gateway",
						appId: "fixture",
						appSlug: "fixture",
						organizationId: org,
						actor: { authType: "user" },
						nativeTransportAvailable: true,
					},
					nativeCatalog: {
						status: "usable",
						search: descriptor("catalog.search"),
						describe: descriptor("catalog.describe"),
					},
				};
			if (name === "catalog__search")
				return {
					results: Object.keys(endpoints).map((callable) => ({
						callable,
						authorized: true,
						native: descriptor(callable),
						outputSchema: {},
					})),
				};
			if (name === "catalog__describe") {
				const callable = String(input.callable);
				return {
					callable,
					authorized: true,
					native: descriptor(callable),
					parameters: { type: "object" },
					schemaFreshness: descriptor(callable).schemaFreshness,
				};
			}
			const callable = Object.keys(endpoints).find(
				(key) => descriptor(key).name === name,
			);
			if (callable) return values[callable];
			if (name === "code") {
				if (String(input.code).includes("decision.list_agent_decisions("))
					return { result: values["decision.list_agent_decisions"] };
				return { fixture: true };
			}
			throw new Error(`Unscripted tool: ${name}`);
		},
	);
	spyOn(TedixHomeClient.prototype, "runCode").mockImplementation(
		async (source: string) => {
			if (source.includes("codemode.__runtime")) return { organizationId: org };
			if (source.includes("discover.search"))
				return [
					{
						tool: "list_all_mine",
						callable: "organizations.list_all_mine",
						authorized: true,
						schemaFreshness: { sourceRef: "organizations/listAllMine" },
					},
				];
			if (source.includes("organizations.list_all_mine")) return [];
			if (source.includes("flow.status"))
				return { status: "completed", result: { fixture: true } };
			if (source.includes("skills.list_skills_by_org")) return { entries: [] };
			if (source.includes("workflows.list_workflow_definitions"))
				return { definitions: [] };
			if (source.includes("factories.") || source.includes("factory."))
				return { data: [] };
			if (source.includes("tedis.get_tedi"))
				return "11111111-1111-4111-8111-111111111111";
			if (source.includes("tedis.")) return { data: [] };
			return { fixture: true };
		},
	);
	spyOn(TedixHomeClient.prototype, "readHomeRunSet").mockResolvedValue({
		runs: [],
	});
	spyOn(TedixHomeClient.prototype, "readChildRunTree").mockResolvedValue({
		nodes: [],
	});
	spyOn(TedixHomeClient.prototype, "askHome").mockResolvedValue({
		run: { id: "fixture-run", status: "completed" },
		assistantMessage: { content: "Fixture answer" },
	});
	spyOn(TedixHomeClient.prototype, "rawRequest").mockImplementation(
		async (method: string) => {
			if (method === "events/list") return { events: [] };
			return { fixture: true };
		},
	);
	const { writeWorkspaceCredentials } = await import(
		`${src}/credential-store.ts`
	);
	writeWorkspaceCredentials("fixture", {
		loginId: "fixture-owner",
		mcpUrl: "http://127.0.0.1:1/mcp",
		oauthTokens: { access_token: "fictional-token", token_type: "Bearer" },
	});
	const update = await import(`${src}/update.ts`);
	const { runUpdateCommand, runRollbackCommand } = update;
	const { CLI_VERSION } = await import(`${src}/shared.ts`);
	const installPath = join(process.env.TEDIX_CONFIG_DIR!, "tedix");
	const binary = `#!/bin/sh\nprintf '%s\\n' '${CLI_VERSION}'\n`;
	writeFileSync(installPath, binary, { mode: 0o755 });
	writeFileSync(`${installPath}.previous`, binary, { mode: 0o755 });
	const runtime = {
		standalone: true,
		installPath,
		signing: () => ({ status: 1, output: "" }),
		fetch: async (url: string | URL | Request) =>
			Response.json(
				new URL(String(url)).pathname.endsWith("latest.json")
					? {
							schemaVersion: 1,
							version: CLI_VERSION,
							sourceSha: "a".repeat(40),
							manifestUrl: `https://downloads.tedix.dev/releases/${CLI_VERSION}/manifest.json`,
						}
					: {
							schemaVersion: 1,
							version: CLI_VERSION,
							sourceSha: "a".repeat(40),
							assets: [
								{
									name: `tedix-${CLI_VERSION}-${process.platform}-${process.arch}`,
									url: `https://downloads.tedix.dev/releases/${CLI_VERSION}/tedix-${CLI_VERSION}-${process.platform}-${process.arch}`,
									size: 1,
									sha256: "a".repeat(64),
								},
							],
						},
			),
	};
	mock.module(`${src}/update.ts`, () => ({
		...update,
		runUpdateCommand: (
			options: Parameters<typeof update.runUpdateCommand>[0],
		) => runUpdateCommand(options, runtime),
		runRollbackCommand: (
			options: Parameters<typeof update.runRollbackCommand>[0],
		) => runRollbackCommand(options, runtime),
	}));
	spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected live fetch in JSON contract test"),
	);
}

const examples: Record<string, string[]> = {
	setup: ["agents", "context", "show"],
	deck: ["list"],
	decide: ["list"],
	feed: [],
	hooks: ["session-start"],
	learn: ["import-sessions", "--dry-run"],
	chat: ["Fixture question", "--no-poll", "--no-repo-context"],
	auth: ["status"],
	agent: ["status"],
	tedi: ["11111111-1111-4111-8111-111111111111", "executions"],
	code: ["async () => ({ fixture: true })"],
	mcp: ["call", "events/list"],
	channel: ["claude"],
	work: ["list"],
	lane: [
		"report",
		"--input",
		'{"harness":"codex","sessionKey":"11111111-1111-4111-8111-111111111111","state":"working","summary":"Fixture progress","label":"Fixture lane"}',
	],
	flow: ["status", "fixture-run"],
	skill: ["list"],
	factory: ["status"],
	workflow: ["list"],
	status: [],
	orgs: [],
	threads: [],
	workspaces: [],
	who: ["--hours", "0.001"],
	update: ["--check"],
	rollback: [],
	help: [],
};
let root: string;
let preload: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "tedix-json-contract-"));
	preload = join(root, "preload.ts");
	writeFileSync(
		preload,
		`import { join } from "node:path"; import { writeFileSync } from "node:fs"; await (${installTransportFixtures.toString()})(${JSON.stringify(import.meta.dir)});`,
	);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(args: string[], stdin = "", fixtures = true) {
	const config = mkdtempSync(join(root, "config-"));
	const child = Bun.spawn(
		[
			process.execPath,
			...(fixtures ? ["--preload", preload] : []),
			`${import.meta.dir}/index.ts`,
			...args,
		],
		{
			env: {
				PATH: process.env.PATH,
				HOME: config,
				TEDIX_CONFIG_DIR: config,
				TEDIX_MCP_URL: "http://127.0.0.1:1/mcp",
				TEDIX_MCP_BEARER_TOKEN: "fictional-token",
				TEDIX_AGENT_SESSION: "codex:11111111-1111-4111-8111-111111111111",
			},
			stdin: new Blob([stdin]),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (!fixtures)
		expect(existsSync(join(config, "credentials.json"))).toBe(false);
	rmSync(config, { recursive: true, force: true });
	return { stdout, stderr, code };
}

describe("registry JSON contract", () => {
	for (const row of TOP_LEVEL_COMMANDS) {
		test(`${row.name} --json follows its declared output`, async () => {
			const machine = row.output.some(
				(format) => format === "json" || format === "ndjson",
			);
			if (machine) expect(Object.hasOwn(examples, row.name)).toBe(true);
			const stdin =
				row.name === "channel"
					? '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
					: row.name === "hooks"
						? "invalid event"
						: "{}";
			const result = await run(
				["-w", "fixture", row.name, ...(examples[row.name] ?? []), "--json"],
				stdin,
				machine,
			);
			if (!machine) {
				expect(result).toEqual({
					stdout: "",
					stderr: `${JSON.stringify({ error: `--json is not supported by tedix ${row.name}` })}\n`,
					code: 2,
				});
				return;
			}
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().length, result.stderr).toBeGreaterThan(0);
			if (!row.output.includes("json") && row.output.includes("ndjson")) {
				for (const line of result.stdout.trim().split("\n"))
					expect(() => JSON.parse(line)).not.toThrow();
			} else expect(() => JSON.parse(result.stdout)).not.toThrow();
		}, 15_000);
	}

	test("interactive setup rejects JSON before starting installation", async () => {
		const result = await run(["setup", "--json"], "", false);
		expect(result).toEqual({
			stdout: "",
			stderr: '{"error":"--json is not supported by tedix setup"}\n',
			code: 2,
		});
	});

	test("JSON help and version remain single documents", async () => {
		for (const args of [
			["--help"],
			["code", "--help"],
			["learn"],
			["learn", "--help"],
			["--version"],
		]) {
			const result = await run([...args, "--json"]);
			expect(result.code, result.stderr).toBe(0);
			expect(() => JSON.parse(result.stdout)).not.toThrow();
		}
	}, 15_000);

	test("lane brief encodes its launcher text in JSON mode", async () => {
		const brief = join(root, "brief.md");
		writeFileSync(brief, "Implement the fixture.\n");
		const result = await run([
			"-w",
			"fixture",
			"lane",
			"brief",
			brief,
			"--json",
		]);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toBe("Implement the fixture.\n");
	}, 15_000);

	test("silent hook protocols accept JSON mode without fabricating output", async () => {
		for (const hook of [
			"status",
			"capture-stop",
			"capture-reply",
			"await-reply",
			"await-draft",
		]) {
			const result = await run(["hooks", hook, "--json"], "{}");
			expect(result, hook).toEqual({ stdout: "", stderr: "", code: 0 });
		}
	}, 15_000);

	test("JSON failures keep stdout empty", async () => {
		const result = await run(["unknown-command", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr).error).toContain("Unknown command");
	});

	test("literal --json does not select machine mode", async () => {
		const result = await run(["use", "--", "--json"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("--json is not supported");
	});
});
