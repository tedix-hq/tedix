import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
	LOCAL_API_URL,
	assertLauncherPortsAvailable,
	LOCAL_LOOPBACK_MESSAGE,
	LOCAL_OS_URL,
	LOCAL_STACK_STAGES,
	defaultLocalRunState,
	localStackStageCommand,
	localInferenceEnvironment,
	parseRunLocalOptions,
	waitForLocalApi,
	waitForLocalDemo,
	assertSupportedNodeRuntime,
} from "./run-local";

function listenOnEphemeralPort() {
	return new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
		const server = createServer((socket) => socket.destroy());
		server.once("error", reject);
		server.listen(0, "localhost", () => resolve(server));
	});
}

function closeServer(server: ReturnType<typeof createServer>) {
	return new Promise<void>((resolve) => server.close(() => resolve()));
}

function serverPort(server: ReturnType<typeof createServer>) {
	return (server.address() as { port: number }).port;
}

describe("run-local options", () => {
	test("states that every server is loopback-only in the startup copy", () => {
		expect(LOCAL_LOOPBACK_MESSAGE).toBe(
			"✓ Every server answers on this machine only (loopback).",
		);
	});

	test("routes only explicit Workers AI through the selected gateway", () => {
		const args = [
			"--inference",
			`--workers-ai-account=${"a".repeat(32)}`,
			"--ai-gateway=beta-gateway",
		];
		expect(localInferenceEnvironment(parseRunLocalOptions(args))).toMatchObject(
			{
				TEDIX_LOCAL_AI_GATEWAY_ID: "beta-gateway",
				TEDIX_LOCAL_INFERENCE_BACKEND: "workers-ai",
			},
		);
		for (const invalid of [
			["--ai-gateway=beta"],
			[...args, "--ai-gateway=other"],
			[...args.slice(0, 2), "--ai-gateway=../other"],
		])
			expect(() => parseRunLocalOptions(invalid)).toThrow();
	});
	test("requires genuine Node 22+ rather than a missing, old, or Bun-shim runtime", () => {
		for (const runtime of [
			null,
			{ node: "20.19.0", bun: null },
			{ node: "24.0.0", bun: "1.4.2" },
			{ node: "invalid", bun: null },
		]) {
			expect(() => assertSupportedNodeRuntime(runtime)).toThrow(
				"genuine Node.js 22+",
			);
		}
		expect(() =>
			assertSupportedNodeRuntime({ node: "22.0.0", bun: null }),
		).not.toThrow();
		expect(() =>
			assertSupportedNodeRuntime({ node: "24.1.0", bun: null }),
		).not.toThrow();
	});

	test("fails before startup or state writes when Node is absent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tedix-local-node-"));
		const result = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "run-local.ts")],
			{ cwd, env: { PATH: "/nonexistent" } },
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("genuine Node.js 22+");
		expect(readdirSync(cwd)).toEqual([]);
	});
	test("rejects an occupied port before installing or writing local state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tedix-local-port-"));
		const server = await listenOnEphemeralPort();
		const port = serverPort(server);
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "run-local.ts")],
			{
				cwd,
				env: {
					...process.env,
					TEDIX_LOCAL_API_PORT: String(port),
					TEDIX_LOCAL_PERSIST_TO: cwd,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timeout = setTimeout(() => child.kill(), 5000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain(`port ${port} is already in use`);
			expect(stderr).toContain(`lsof -nP -iTCP:${port} -sTCP:LISTEN`);
			expect(stdout).not.toContain("Installing exact dependencies");
			expect(stdout).not.toContain(
				"Applying isolated local database migrations",
			);
			expect(stdout).not.toContain("Building the Tedix OS");
			expect(readdirSync(cwd)).toEqual([]);
		} finally {
			clearTimeout(timeout);
			child.kill();
			if (server.listening) await closeServer(server);
		}
	});
	test("rejects an occupied MCP port before installing or writing local state", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "tedix-local-mcp-port-"));
		const mcpServer = await listenOnEphemeralPort();
		const mcpPort = serverPort(mcpServer);
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "run-local.ts")],
			{
				cwd,
				env: {
					...process.env,
					TEDIX_LOCAL_PERSIST_TO: cwd,
					TEDIX_LOCAL_MCP_PORT: String(mcpPort),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timeout = setTimeout(() => child.kill(), 5000);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain(`port ${mcpPort} is already in use`);
			expect(stderr).toContain(`lsof -nP -iTCP:${mcpPort} -sTCP:LISTEN`);
			expect(stdout).not.toContain("Installing exact dependencies");
			expect(readdirSync(cwd)).toEqual([]);
		} finally {
			clearTimeout(timeout);
			child.kill();
			if (mcpServer.listening) await closeServer(mcpServer);
		}
	});
	test("accepts a deterministic port probe for preflight tests", async () => {
		const checked: number[] = [];
		await expect(
			assertLauncherPortsAvailable(async (port) => {
				checked.push(port);
				return false;
			}),
		).resolves.toBeUndefined();
		expect(checked).toEqual([8790, 3000, 3030]);
	});
	test("bounds startup readiness even when a server never sends a response body", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = ((_: unknown, init: RequestInit) => {
			const signal = init.signal!;
			return Promise.resolve(
				new Response(
					new ReadableStream({
						start(controller) {
							signal.addEventListener(
								"abort",
								() => controller.error(signal.reason),
								{ once: true },
							);
						},
					}),
					{ status: 200 },
				),
			);
		}) as typeof fetch;
		const started = Date.now();
		try {
			await expect(waitForLocalDemo(30)).rejects.toThrow("within 30ms");
			expect(Date.now() - started).toBeLessThan(1000);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("bounds API readiness for the first stack stage", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() =>
			Promise.resolve(
				new Response("starting", { status: 503 }),
			)) as unknown as typeof fetch;
		try {
			await expect(waitForLocalApi(30)).rejects.toThrow(
				"The local API did not become ready within 30ms",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	test("boots the API alone before the servers that share its local state", async () => {
		// Concurrent first opens of the shared Miniflare SQLite metadata failed
		// with SQLITE_BUSY_RECOVERY; the API stage must own them first.
		expect(LOCAL_STACK_STAGES).toEqual([
			["@tedix/api"],
			["@tedix/mcp", "@tedix/os"],
		]);
		expect(localStackStageCommand(LOCAL_STACK_STAGES[0])).toEqual([
			"vp",
			"run",
			"--filter",
			"@tedix/api",
			"dev:local-launcher",
		]);
		expect(localStackStageCommand(LOCAL_STACK_STAGES[1])).toEqual([
			"vp",
			"run",
			"--parallel",
			"--filter",
			"@tedix/mcp",
			"--filter",
			"@tedix/os",
			"dev:local-launcher",
		]);
		const root = join(import.meta.dir, "..");
		for (const [workspace, name] of [
			["apps/api", "@tedix/api"],
			["apps/mcp", "@tedix/mcp"],
			["apps/os", "@tedix/os"],
		] as const) {
			const manifest = (await Bun.file(
				join(root, workspace, "package.json"),
			).json()) as { name: string; scripts: Record<string, string> };
			expect(manifest.name).toBe(name);
			expect(manifest.scripts["dev:local-launcher"]).toContain(
				"scripts/dev-local.ts",
			);
		}
	});
	test("installs dependencies and stays running by default", () => {
		expect(parseRunLocalOptions([])).toEqual({
			install: true,
			smoke: false,
			inference: null,
			workersAiAccountId: null,
			aiGatewayId: null,
			restartSmoke: false,
			demo: false,
			verbose: false,
		});
	});

	test("uses isolated API and OS ports for concurrent launchers", () => {
		const result = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				'import { LOCAL_API_URL, LOCAL_OS_URL } from "./scripts/run-local"; console.log(JSON.stringify([LOCAL_API_URL, LOCAL_OS_URL]));',
			],
			{
				cwd: join(import.meta.dir, ".."),
				env: {
					...process.env,
					TEDIX_LOCAL_API_PORT: "8890",
					TEDIX_LOCAL_OS_PORT: "3042",
				},
			},
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual([
			"http://localhost:8890",
			"http://localhost:3042",
		]);
	});

	test("supports repeatable clean-export smoke validation", () => {
		const options = parseRunLocalOptions(["--no-install", "--smoke"]);
		expect(options).toEqual({
			install: false,
			smoke: true,
			inference: null,
			workersAiAccountId: null,
			aiGatewayId: null,
			restartSmoke: false,
			demo: false,
			verbose: false,
		});
		expect(localInferenceEnvironment(options)).toEqual({
			TEDIX_LOCAL_INFERENCE_ENABLED: "false",
			TEDIX_LOCAL_INFERENCE_BACKEND: "",
			TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: "",
			TEDIX_LOCAL_AI_GATEWAY_ID: "",
		});
	});

	test("makes CLI selection authoritative over stale ambient inference vars", () => {
		const staleAmbient = {
			TEDIX_LOCAL_INFERENCE_ENABLED: "true",
			TEDIX_LOCAL_INFERENCE_BACKEND: "workers-ai",
			TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: "00000000000000000000000000000000",
			TEDIX_LOCAL_AI_GATEWAY_ID: "",
		};
		const childEnvironment = {
			...staleAmbient,
			...localInferenceEnvironment(parseRunLocalOptions(["--no-install"])),
		};
		expect(childEnvironment).toEqual({
			TEDIX_LOCAL_INFERENCE_ENABLED: "false",
			TEDIX_LOCAL_INFERENCE_BACKEND: "",
			TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: "",
			TEDIX_LOCAL_AI_GATEWAY_ID: "",
		});
	});

	test("makes paid inference an explicit opt-in", () => {
		const accountId = "00000000000000000000000000000000";
		expect(
			parseRunLocalOptions([
				"--no-install",
				"--inference",
				`--workers-ai-account=${accountId}`,
			]),
		).toEqual({
			install: false,
			smoke: false,
			inference: "workers-ai",
			workersAiAccountId: accountId,
			aiGatewayId: null,
			restartSmoke: false,
			demo: false,
			verbose: false,
		});
	});

	test("requires explicit account targeting for Wrangler-authenticated Workers AI", () => {
		const accountId = "00000000000000000000000000000000";
		const options = parseRunLocalOptions([
			"--inference=workers-ai",
			`--workers-ai-account=${accountId}`,
		]);
		expect(options).toMatchObject({
			inference: "workers-ai",
			workersAiAccountId: accountId,
			aiGatewayId: null,
		});
		expect(localInferenceEnvironment(options)).toEqual({
			TEDIX_LOCAL_INFERENCE_ENABLED: "true",
			TEDIX_LOCAL_INFERENCE_BACKEND: "workers-ai",
			TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: accountId,
			TEDIX_LOCAL_AI_GATEWAY_ID: "",
		});
		expect(() => parseRunLocalOptions(["--inference=workers-ai"])).toThrow(
			"requires --workers-ai-account",
		);
		expect(() => parseRunLocalOptions(["--inference"])).toThrow(
			"requires --workers-ai-account",
		);
		expect(() => parseRunLocalOptions(["--workers-ai-account=e04d"])).toThrow(
			"valid only with --inference=workers-ai",
		);
		for (const backend of ["direct", "gateway"]) {
			expect(() => parseRunLocalOptions([`--inference=${backend}`])).toThrow(
				"Choose workers-ai",
			);
		}
	});

	test("runs the two-boot restart smoke on its own", () => {
		const options = parseRunLocalOptions(["--no-install", "--restart-smoke"]);
		expect(options).toEqual({
			install: false,
			smoke: false,
			inference: null,
			workersAiAccountId: null,
			aiGatewayId: null,
			restartSmoke: true,
			demo: false,
			verbose: false,
		});
		expect(localInferenceEnvironment(options)).toEqual({
			TEDIX_LOCAL_INFERENCE_ENABLED: "false",
			TEDIX_LOCAL_INFERENCE_BACKEND: "",
			TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: "",
			TEDIX_LOCAL_AI_GATEWAY_ID: "",
		});
		expect(() => parseRunLocalOptions(["--restart-smoke", "--smoke"])).toThrow(
			"runs its own two boots",
		);
		expect(() =>
			parseRunLocalOptions([
				"--restart-smoke",
				"--inference",
				`--workers-ai-account=${"a".repeat(32)}`,
			]),
		).toThrow("runs its own two boots");
		expect(() => parseRunLocalOptions(["--restart-smoke", "--demo"])).toThrow(
			"runs its own two boots",
		);
	});

	test("keeps the seeded demo explicit and state-isolated", () => {
		expect(parseRunLocalOptions(["--demo", "--smoke"])).toEqual({
			install: true,
			smoke: true,
			inference: null,
			workersAiAccountId: null,
			aiGatewayId: null,
			restartSmoke: false,
			demo: true,
			verbose: false,
		});
		expect(defaultLocalRunState(false, "/repo")).toBe(
			"/repo/.wrangler/run-local",
		);
		expect(defaultLocalRunState(true, "/repo")).toBe(
			"/repo/.wrangler/run-local-demo",
		);
	});

	test("rejects drifted or misspelled options", () => {
		expect(() => parseRunLocalOptions(["--skip-auth"])).toThrow(
			"Unknown option: --skip-auth",
		);
	});

	test("lands the first-run experience in Tedix OS", () => {
		expect(LOCAL_OS_URL).toBe("http://localhost:3030");
		expect(LOCAL_API_URL).toBe("http://localhost:8790");
	});

	test("prints help without credentials, dependencies, or local state writes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "tedix-local-help-"));
		const result = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "run-local.ts"), "--help"],
			{
				cwd,
				env: { PATH: "/nonexistent", TEDIX_LOCAL_INFERENCE_ENABLED: "true" },
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Usage: bun run-local");
		expect(result.stdout.toString()).not.toContain("gateway bridge");
		expect(result.stderr.toString()).toBe("");
		expect(readdirSync(cwd)).toEqual([]);
	});
});
