import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOP_LEVEL_COMMANDS } from "./command-registry";

// Preload only in subprocesses: command implementations and their renderers stay real.
async function installTransportFixtures(src: string) {
	const { spyOn } = await import("bun:test");
	const { TedixHomeClient } = await import(`${src}/home-client.ts`);
	const org = "99999999-9999-4999-8999-999999999999";
	const endpoints: Record<string, string> = {
		"work.list_work_item_cli_rows": "workItems/listCliProjection",
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
		"work.list_work_item_cli_rows": {
			view: "board",
			data: [],
			pagination: { limit: 20, offset: 0, total: 0, hasMore: false },
		},
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
				return { fixture: true };
			}
			throw new Error(`Unscripted tool: ${name}`);
		},
	);
	spyOn(TedixHomeClient.prototype, "runCode").mockImplementation(
		async (source: string) => {
			if (source.includes("codemode.__runtime")) return { organizationId: org };
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
	spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected live fetch in JSON contract test"),
	);
}

// One command for each materially different machine output path.
const examples = {
	setup: ["agents", "context", "show"],
	chat: ["Fixture question", "--no-poll", "--no-repo-context"],
	code: ["async () => ({ fixture: true })"],
	channel: ["claude"],
	work: ["list"],
};
const root = mkdtempSync(join(tmpdir(), "tedix-json-contract-"));
const preload = join(root, "preload.ts");
const hookRunner = join(root, "hook-runner.ts");
const cliRunner = join(root, "cli-runner.js");
writeFileSync(
	preload,
	`await (${installTransportFixtures.toString()})(${JSON.stringify(import.meta.dir)});`,
);
writeFileSync(
	hookRunner,
	`import { runHooksCommand } from ${JSON.stringify(`${import.meta.dir}/hooks/command.ts`)};
const args = process.argv.slice(2);
if (args.shift() !== "hooks") throw new Error("Expected hooks command");
const json = args.indexOf("--json");
if (json >= 0) args.splice(json, 1);
process.exit(await runHooksCommand(args));`,
);
beforeAll(async () => {
	const build = await Bun.build({
		entrypoints: [`${import.meta.dir}/index.ts`],
		target: "bun",
		minify: true,
	});
	if (!build.success || !build.outputs[0])
		throw new Error("Could not build JSON contract CLI fixture");
	await Bun.write(cliRunner, build.outputs[0]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(
	args: string[],
	stdin = "",
	fixtures = true,
	entrypoint?: string,
) {
	const config = mkdtempSync(join(root, "config-"));
	const child = Bun.spawn(
		[
			process.execPath,
			...(fixtures ? ["--preload", preload] : []),
			entrypoint ?? `${import.meta.dir}/index.ts`,
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
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (!fixtures)
			expect(existsSync(join(config, "credentials.json"))).toBe(false);
		return { stdout, stderr, code };
	} finally {
		child.kill();
		await child.exited;
		rmSync(config, { recursive: true, force: true });
	}
}

describe("registry JSON contract", () => {
	for (const [name, args] of Object.entries(examples)) {
		test(`${name} --json follows its declared output`, async () => {
			const row = TOP_LEVEL_COMMANDS.find((command) => command.name === name);
			expect(row).toBeDefined();
			const stdin =
				name === "channel"
					? '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n'
					: "{}";
			const result = await run(
				["-w", "fixture", name, ...args, "--json"],
				stdin,
			);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout.trim().length, result.stderr).toBeGreaterThan(0);
			if (row?.output.includes("ndjson")) {
				for (const line of result.stdout.trim().split("\n"))
					expect(() => JSON.parse(line)).not.toThrow();
			} else {
				expect(row?.output).toContain("json");
				expect(() => JSON.parse(result.stdout)).not.toThrow();
			}
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

	test("JSON help and version outputs remain single documents", async () => {
		await Promise.all(
			[["code", "--help"], ["--version"]].map(async (args) => {
				const result = await run([...args, "--json"], "", false, cliRunner);
				expect(result.code, result.stderr).toBe(0);
				expect(() => JSON.parse(result.stdout)).not.toThrow();
			}),
		);
	});

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

	test("silent hooks accept JSON mode without fabricating output", async () => {
		const result = await run(
			["hooks", "capture-stop", "--json"],
			"{}",
			false,
			hookRunner,
		);
		expect(result).toEqual({ stdout: "", stderr: "", code: 0 });
	});

	test("JSON errors stay on stderr and honor the literal separator", async () => {
		const [failure, literal] = await Promise.all([
			run(["unknown-command", "--json"], "", false, cliRunner),
			run(["use", "--", "--json"], "", false, cliRunner),
		]);
		expect(failure.code).toBe(1);
		expect(failure.stdout).toBe("");
		expect(JSON.parse(failure.stderr).error).toContain("Unknown command");
		expect(literal.code).toBe(1);
		expect(literal.stdout).toBe("");
		expect(literal.stderr).not.toContain("--json is not supported");
	});
});
