import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKERS_AI_MODEL } from "../packages/workers-ai/src/model-select";
import { findCatalogEntry } from "../packages/api-contract/src/schemas/model-catalog";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { parse } from "jsonc-parser";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	createLocalWranglerConfig,
	resolveLocalPersistPath,
	resolveShellVarOverrides,
} from "./dev-local";
import {
	assertNoPortConflicts,
	collectDevPorts,
	portsForApp,
	toPortList,
} from "./dev/ports";

const repoRoot = resolve(import.meta.dir, "..");

/** Every `apps/<dir>` that ships a package.json, with its scripts block. */
function appScripts(): Array<[string, Record<string, string>]> {
	const entries: Array<[string, Record<string, string>]> = [];
	for (const app of readdirSync(join(repoRoot, "apps"))) {
		const path = join(repoRoot, "apps", app, "package.json");
		if (!existsSync(path)) continue;
		entries.push([app, JSON.parse(readFileSync(path, "utf8")).scripts ?? {}]);
	}
	return entries;
}

describe("local Wrangler config", () => {
	test("disables fleet authority in both private and exported local configs", () => {
		for (const mode of ["co-located", "configured-via-private-overlay"]) {
			const directory = mkdtempSync(join(tmpdir(), "tedix-local-fleet-"));
			const path = join(directory, "wrangler.jsonc");
			writeFileSync(
				path,
				JSON.stringify({
					name: "public-installation-api",
					vars: { TEDIX_FLEET_AUTHORITY_MODE: mode },
				}),
			);
			expect(createLocalWranglerConfig(path).vars).toMatchObject({
				TEDIX_FLEET_AUTHORITY_MODE: "disabled",
			});
		}
	});
	// The old shape of this test cross-checked two hand-kept copies of the port
	// table (each package.json's `clear-port` args against cleanup-dev.sh's
	// `PORTS=(...)` arrays). Both copies are gone: scripts/dev/ports.ts derives
	// the inventory from the file that actually binds each port. The invariants
	// they protected are unchanged, so they are asserted here against that one
	// derived source instead.
	test("every startup app reserves a unique port that the root sweep covers", () => {
		const inventory = collectDevPorts(repoRoot);
		expect(inventory.length).toBeGreaterThan(0);
		expect(() => assertNoPortConflicts(inventory)).not.toThrow();

		const swept = new Set(toPortList(inventory));
		for (const [app, scripts] of appScripts()) {
			if (!scripts.dev) continue;
			for (const port of portsForApp(inventory, app)) {
				expect(
					swept.has(port),
					`${app} port ${port} missing from the root sweep`,
				).toBe(true);
			}
		}

		// The root sweep must keep DERIVING its list. A reintroduced literal
		// `PORTS=(3000 3001 ...)` array is the hand-kept copy that used to drift.
		const cleanup = readFileSync(
			join(repoRoot, "scripts/cleanup-dev.sh"),
			"utf8",
		);
		expect(cleanup).toContain('bun "$ROOT_DIR/scripts/dev/ports.ts"');
		expect(cleanup).not.toMatch(/^\s*\w*PORTS=\([\d\s]+\)/m);
	});

	// A typo'd `--app` argument is invisible at root boot: clear-port.sh's
	// TEDIX_DEV_WRAPPER_ACTIVE guard short-circuits before resolution, so the
	// bad name only surfaces when someone runs that app standalone.
	test("every app clear-port script names its own directory and resolves", () => {
		const inventory = collectDevPorts(repoRoot);
		for (const [app, scripts] of appScripts()) {
			if (!scripts.dev) continue;
			expect(scripts["clear-port"], `${app} clear-port`).toBe(
				`../../scripts/clear-port.sh --app ${app}`,
			);
			const named = scripts["clear-port"]!.split(/\s+/).at(-1)!;
			expect(() => portsForApp(inventory, named)).not.toThrow();
		}
	});

	// Type generation left the dev startup critical path; `bun run types` on
	// `dev` put a full wrangler types run in front of every app's first boot.
	test("no app dev script regenerates worker types on the startup path", () => {
		for (const [app, scripts] of appScripts()) {
			for (const name of ["dev", "dev:remote"]) {
				const script = scripts[name];
				if (!script) continue;
				expect(script, `${app} ${name}`).not.toContain("bun run types");
			}
			for (const name of ["types", "types:check"]) {
				const script = scripts[name];
				if (!script) continue;
				if (script.startsWith("cf workers types")) {
					expect(script, `${app} ${name}`).toContain("--mode production");
					continue;
				}
				expect(script, `${app} ${name}`).toContain(
					`../../scripts/generate-worker-types.ts`,
				);
				expect(script.split(/\s+/).at(-1), `${app} ${name}`).toBe(app);
			}
		}
	});

	test("concurrent Wrangler dev commands declare unique service and inspector ports", () => {
		const root = resolve(import.meta.dir, "..");
		const used = new Map<number, string>();
		for (const app of readdirSync(join(root, "apps"))) {
			const packagePath = join(root, "apps", app, "package.json");
			if (!existsSync(packagePath)) continue;
			const scripts =
				JSON.parse(readFileSync(packagePath, "utf8")).scripts ?? {};
			if (!scripts.dev?.includes("wrangler dev")) continue;
			const config = parse(
				readFileSync(join(root, "apps", app, "wrangler.jsonc"), "utf8"),
			);
			for (const field of ["port", "inspector_port"]) {
				const port = config.dev?.[field];
				expect(Number.isInteger(port), app + "." + field).toBe(true);
				expect(port).toBeGreaterThan(0);
				expect(port).toBeLessThanOrEqual(65535);
				expect(
					used.get(port),
					app + "." + field + " conflicts with " + used.get(port),
				).toBeUndefined();
				used.set(port, app + "." + field);
			}
			expect(
				scripts.dev,
				app + " must sanitize its default Wrangler config",
			).toContain("scripts/dev-local.ts");
		}
	});

	test("removes account-bound surfaces and rewrites remote bindings", () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-dev-local-"));
		const path = join(directory, "wrangler.jsonc");
		writeFileSync(
			path,
			`{
				"account_id": "production-account",
				"vars": { "ENVIRONMENT": "production", "API_URL": "https://api.tedix.dev", "DESCOPE_PROJECT_ID": "production-project", "TEDIX_BILLING_SETTLEMENT_MODE": "managed", "TEDIX_RUNTIME_ENTITLEMENT_GRANTS": "production-grants" },
				"ai": { "binding": "AI", "remote": true },
				"agent_memory": [{ "binding": "AGENT_MEMORY", "namespace": "production-memory" }],
				"artifacts": [{ "binding": "ARTIFACTS", "namespace": "tedix-prod", "remote": true }],
				"secrets": { "required": ["DESCOPE_PROJECT_ID", "DESCOPE_MANAGEMENT_KEY"] },
				"d1_databases": [{ "binding": "DB", "database_name": "prod", "database_id": "id", "remote": true }],
				"ai_search_namespaces": [{ "binding": "SEARCH", "index_name": "prod" }],
				"env": { "production": { "routes": ["example.com/*"] } },
			}
			`,
		);

		const config = createLocalWranglerConfig(path);
		expect(config.account_id).toBeUndefined();
		expect(config.env).toBeUndefined();
		expect(config.ai_search_namespaces).toBeUndefined();
		expect(config.ai).toBeUndefined();
		expect(config.agent_memory).toBeUndefined();
		expect(config.artifacts).toBeUndefined();
		expect(config.secrets).toBeUndefined();
		expect(config.vars).toEqual({
			ENVIRONMENT: "development",
			API_URL: "http://localhost:8787",
			DESCOPE_PROJECT_ID: "local-development-disabled",
			DESCOPE_BASE_URL: "http://127.0.0.1:9",
			TEDIX_LOCAL_DEMO_ENABLED: "true",
			TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
			TEDIX_RUNTIME_ENTITLEMENT_GRANTS: "[]",
		});
		expect(config.d1_databases).toEqual([
			{
				binding: "DB",
				database_name: "prod",
				database_id: "00000000-0000-0000-0000-000000000000",
				remote: false,
			},
		]);
	});

	test("aligns private and public API identities with the OS service binding", () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-dev-local-services-"));
		const apiPath = join(directory, "api.jsonc");
		const osPath = join(directory, "os.jsonc");
		writeFileSync(apiPath, '{"name":"tedix-api","vars":{}}');
		writeFileSync(
			osPath,
			'{"name":"public-installation-os","vars":{},"services":[{"binding":"API_SERVICE","service":"public-installation-api"}]}',
		);

		expect(createLocalWranglerConfig(apiPath).name).toBe(
			"public-installation-api",
		);
		expect(createLocalWranglerConfig(osPath).services).toEqual([
			{ binding: "API_SERVICE", service: "public-installation-api" },
		]);
	});

	test("keeps every default app script free of secret injection", () => {
		const root = resolve(import.meta.dir, "..");
		for (const app of readdirSync(join(root, "apps"))) {
			const packagePath = join(root, "apps", app, "package.json");
			let packageJson: { scripts?: Record<string, string> };
			try {
				packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
			} catch {
				continue;
			}
			const dev = packageJson.scripts?.dev;
			if (!dev) continue;
			expect(dev).not.toMatch(/secrets\/resolve|secrets:run/);
			expect(dev).not.toMatch(/CLOUDFLARE_ENV=(staging|production)/);
			const remote = packageJson.scripts?.["dev:remote"];
			if (remote) expect(remote).toContain("scripts/dev-remote.sh");
		}
	});

	test("dev-with-logs offers the remote mode only when the root defines dev:remote", () => {
		const rootScripts = (
			JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
				scripts?: Record<string, string>;
			}
		).scripts;
		const hasRemote = Boolean(rootScripts?.["dev:remote"]);
		const env = { ...process.env };
		delete env.TEDIX_DEV_REMOTE_TARGET;
		delete env.TEDIX_DEV_WRAPPER_ACTIVE;
		const run = (...args: string[]) =>
			Bun.spawnSync(["./scripts/dev-with-logs.sh", ...args], {
				cwd: repoRoot,
				env,
			});

		// An invalid profile exits at the usage check, before any cleanup.
		const usage = run("dev", "invalid-profile");
		expect(usage.exitCode).toBe(2);
		const usageText = usage.stderr.toString();
		expect(usageText).toContain("[dev");
		expect(usageText.includes("dev:remote")).toBe(hasRemote);

		// Without the explicit remote target, the remote mode also stops early:
		// on the target check where it exists, on the usage line where it does not.
		const remote = run("dev:remote");
		expect(remote.exitCode).toBe(2);
		expect(remote.stderr.toString()).toContain(
			hasRemote ? "TEDIX_DEV_REMOTE_TARGET" : "Usage:",
		);
	});

	test("isolates an explicitly selected launcher persistence root", () => {
		const directory = mkdtempSync(join(tmpdir(), "tedix-local-state-"));
		expect(resolveLocalPersistPath("/ignored/cwd", directory)).toBe(directory);
		expect(resolveLocalPersistPath("/repo/packages/db", undefined)).toBe(
			"/repo/.wrangler/state",
		);
	});

	test("can cap only the generated local compatibility date", async () => {
		const original = process.env.TEDIX_LOCAL_COMPATIBILITY_DATE;
		process.env.TEDIX_LOCAL_COMPATIBILITY_DATE = "2026-08-11";
		try {
			const directory = mkdtempSync(join(tmpdir(), "tedix-dev-local-date-"));
			const path = join(directory, "wrangler.jsonc");
			writeFileSync(path, '{"compatibility_date":"2026-08-12","vars":{}}');
			const module = await import(`./dev-local?date=${Date.now()}`);
			expect(module.createLocalWranglerConfig(path).compatibility_date).toBe(
				"2026-08-11",
			);
		} finally {
			if (original === undefined) {
				delete process.env.TEDIX_LOCAL_COMPATIBILITY_DATE;
			} else {
				process.env.TEDIX_LOCAL_COMPATIBILITY_DATE = original;
			}
		}
	});

	test("adds only non-secret loopback inference coordinates when opted in", async () => {
		const original = process.env.TEDIX_LOCAL_INFERENCE_ENABLED;
		const originalBackend = process.env.TEDIX_LOCAL_INFERENCE_BACKEND;
		const originalAccountId = process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID;
		const originalGatewayId = process.env.TEDIX_LOCAL_AI_GATEWAY_ID;
		process.env.TEDIX_LOCAL_INFERENCE_ENABLED = "true";
		process.env.TEDIX_LOCAL_INFERENCE_BACKEND = "gateway";
		process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID = "0".repeat(32);
		process.env.TEDIX_LOCAL_AI_GATEWAY_ID = "local-test-gateway";
		try {
			const directory = mkdtempSync(
				join(tmpdir(), "tedix-dev-local-inference-"),
			);
			const path = join(directory, "wrangler.jsonc");
			writeFileSync(
				path,
				JSON.stringify({
					name: "tedix-api",
					compatibility_flags: [
						"nodejs_compat",
						"global_fetch_strictly_public",
					],
					vars: { TEDIX_RUNTIME_ENTITLEMENT_GRANTS: "production" },
				}),
			);
			const module = await import(`./dev-local?inference=${Date.now()}`);
			const config = module.createLocalWranglerConfig(path);
			expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
			expect(config.vars).toMatchObject({
				AI_GATEWAY_ACCOUNT_ID: "0".repeat(32),
				AI_GATEWAY_LLM_ID: "local-test-gateway",
				TEDIX_LOCAL_INFERENCE_PROXY_URL: "http://127.0.0.1:8791",
			});
			expect(
				JSON.parse(
					(config.vars as Record<string, string>)
						.TEDIX_RUNTIME_ENTITLEMENT_GRANTS,
				),
			).toEqual([
				{
					key: "local-inference",
					status: "active",
					source: "operator",
				},
			]);
			expect(JSON.stringify(config)).not.toContain("CF_AI_GATEWAY_TOKEN");
		} finally {
			if (original === undefined) {
				delete process.env.TEDIX_LOCAL_INFERENCE_ENABLED;
			} else {
				process.env.TEDIX_LOCAL_INFERENCE_ENABLED = original;
			}
			if (originalAccountId === undefined) {
				delete process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID;
			} else {
				process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID = originalAccountId;
			}
			if (originalGatewayId === undefined) {
				delete process.env.TEDIX_LOCAL_AI_GATEWAY_ID;
			} else {
				process.env.TEDIX_LOCAL_AI_GATEWAY_ID = originalGatewayId;
			}
			if (originalBackend === undefined) {
				delete process.env.TEDIX_LOCAL_INFERENCE_BACKEND;
			} else {
				process.env.TEDIX_LOCAL_INFERENCE_BACKEND = originalBackend;
			}
		}
	});

	test("removes remote-only memory from the actual offline API config", () => {
		const config = createLocalWranglerConfig(
			join(repoRoot, "apps/api/wrangler.jsonc"),
		);
		expect(config.agent_memory).toBeUndefined();
	});

	test("rejects enabled inference without an explicit backend", () => {
		const result = Bun.spawnSync(
			[process.execPath, join(import.meta.dir, "dev-local.ts")],
			{
				env: {
					...process.env,
					TEDIX_LOCAL_INFERENCE_ENABLED: "true",
					TEDIX_LOCAL_INFERENCE_BACKEND: "",
				},
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain(
			"TEDIX_LOCAL_INFERENCE_BACKEND: (missing)",
		);
	});

	test.each([undefined, "", "beta-gateway"])(
		"adds only account-targeted AI with optional gateway %s",
		async (gateway) => {
			const previous = {
				enabled: process.env.TEDIX_LOCAL_INFERENCE_ENABLED,
				backend: process.env.TEDIX_LOCAL_INFERENCE_BACKEND,
				account: process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID,
				gateway: process.env.TEDIX_LOCAL_AI_GATEWAY_ID,
				model: process.env.TEDIX_DEV_VAR_KERNEL_WORKERS_AI_MODEL,
			};
			if (gateway !== undefined)
				process.env.TEDIX_LOCAL_AI_GATEWAY_ID = gateway;
			else delete process.env.TEDIX_LOCAL_AI_GATEWAY_ID;
			process.env.TEDIX_LOCAL_INFERENCE_ENABLED = "true";
			process.env.TEDIX_LOCAL_INFERENCE_BACKEND = "workers-ai";
			process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID =
				"00000000000000000000000000000000";
			try {
				const directory = mkdtempSync(
					join(tmpdir(), "tedix-dev-local-workers-ai-"),
				);
				const path = join(directory, "wrangler.jsonc");
				writeFileSync(
					path,
					JSON.stringify({
						name: "tedix-api",
						account_id: "production-account",
						vars: {
							KERNEL_FORCE_WORKERS_AI: "false",
							KERNEL_WORKERS_AI_MODEL: "production-fallback-model",
							KERNEL_MODEL_REF: "workers-ai/production-role-model",
							AI_GATEWAY_ACCOUNT_ID: "production-account",
						},
						ai: { binding: "AI", remote: true },
						agent_memory: [
							{ binding: "AGENT_MEMORY", namespace: "production-memory" },
						],
						d1_databases: [
							{
								binding: "DB",
								database_name: "prod",
								database_id: "production-d1",
								remote: true,
							},
						],
					}),
				);
				const module = await import(
					`./dev-local?workers-ai=${crypto.randomUUID()}`
				);
				const config = module.createLocalWranglerConfig(path);
				expect(config.account_id).toBe("00000000000000000000000000000000");
				expect(config.ai).toEqual({ binding: "AI", remote: true });
				expect(config.agent_memory).toBeUndefined();
				const actualConfig = module.createLocalWranglerConfig(
					join(repoRoot, "apps/api/wrangler.jsonc"),
				);
				expect(actualConfig.agent_memory).toBeUndefined();
				expect(actualConfig.ai).toEqual({ binding: "AI", remote: true });
				for (const candidate of [config, actualConfig]) {
					expect(candidate.vars).toHaveProperty(
						"KERNEL_WORKERS_AI_MODEL",
						DEFAULT_WORKERS_AI_MODEL,
					);
					expect(candidate.vars).not.toHaveProperty("KERNEL_FORCE_WORKERS_AI");
					const vars = candidate.vars as Record<string, string>;
					expect(vars.KERNEL_MODEL_REF).toBe(
						`workers-ai/${DEFAULT_WORKERS_AI_MODEL}`,
					);
					expect(findCatalogEntry(vars.KERNEL_MODEL_REF!)).toBeDefined();
				}
				expect(config.vars).toMatchObject({
					KERNEL_EXECUTE: "true",
					KERNEL_MODEL_REF: `workers-ai/${DEFAULT_WORKERS_AI_MODEL}`,
					AI_GATEWAY_ACCOUNT_ID: "00000000000000000000000000000000",
					AI_GATEWAY_LLM_ID: gateway || "default",
					AI_GATEWAY_BINDING_PROVIDERS: "",
				});
				expect(config.d1_databases).toEqual([
					{
						binding: "DB",
						database_name: "prod",
						database_id: "00000000-0000-0000-0000-000000000000",
						remote: false,
					},
				]);
				process.env.TEDIX_DEV_VAR_KERNEL_WORKERS_AI_MODEL =
					"@cf/meta/llama-3.1-8b-instruct-fast";
				expect(module.createLocalWranglerConfig(path).vars).toMatchObject({
					KERNEL_MODEL_REF: "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast",
				});
			} finally {
				for (const [key, value] of Object.entries({
					TEDIX_LOCAL_INFERENCE_ENABLED: previous.enabled,
					TEDIX_LOCAL_INFERENCE_BACKEND: previous.backend,
					TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID: previous.account,
					TEDIX_LOCAL_AI_GATEWAY_ID: previous.gateway,
					TEDIX_DEV_VAR_KERNEL_WORKERS_AI_MODEL: previous.model,
				})) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
		},
	);
});

/**
 * `TEDIX_DEV_VAR_<NAME>` is the only supported way to flip a local var for one
 * run (`.dev.vars` is banned repo-wide). Its deny-set is a security boundary —
 * it is what stops a "local" run being re-pointed at a production account,
 * credential, or endpoint — so it is covered here rather than trusted.
 */
describe("shell var overrides", () => {
	const source = readFileSync(join(repoRoot, "scripts/dev-local.ts"), "utf8");

	function snapshotEnv(...keys: string[]): Record<string, string | undefined> {
		return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	}

	function restoreEnv(snapshot: Record<string, string | undefined>): void {
		for (const [key, value] of Object.entries(snapshot)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	/**
	 * The allowlist is module-private, so read it back out of the error an
	 * unknown name raises — the same list a developer is shown.
	 */
	function allowedVars(): string[] {
		try {
			resolveShellVarOverrides({ TEDIX_DEV_VAR_NOT_A_REAL_VAR: "x" });
		} catch (error) {
			const listed = (error as Error).message.match(/Allowed: (.+?)\. Add /);
			expect(
				listed,
				"unknown-name error must list the allowlist",
			).not.toBeNull();
			return listed![1]!.split(", ");
		}
		throw new Error("an unknown override name must throw");
	}

	/** The deny-set is module-private too; read its literal from the source. */
	function deniedVars(): string[] {
		const block = source.match(
			/const NEVER_OVERRIDABLE_VARS = new Set\(\s*\[([\s\S]*?)\]\.map\(/,
		);
		expect(block, "NEVER_OVERRIDABLE_VARS literal").not.toBeNull();
		const names = [...block![1]!.matchAll(/"([^"]+)"/g)].map((one) => one[1]!);
		expect(names.length).toBeGreaterThan(0);
		return names;
	}

	test("an allowlisted var overrides the LOCAL_VARS default in the generated config", () => {
		const original = snapshotEnv("TEDIX_DEV_VAR_KERNEL_EXECUTE");
		try {
			const directory = mkdtempSync(
				join(tmpdir(), "tedix-dev-local-override-"),
			);
			const path = join(directory, "wrangler.jsonc");
			// The committed value is the weakest of the three: LOCAL_VARS pins
			// KERNEL_EXECUTE to "false" locally, and the shell beats both.
			writeFileSync(
				path,
				'{"name":"tedix-mcp","vars":{"KERNEL_EXECUTE":"committed"}}',
			);

			delete process.env.TEDIX_DEV_VAR_KERNEL_EXECUTE;
			expect(
				(createLocalWranglerConfig(path).vars as Record<string, string>)
					.KERNEL_EXECUTE,
			).toBe("false");

			process.env.TEDIX_DEV_VAR_KERNEL_EXECUTE = "true";
			expect(
				(createLocalWranglerConfig(path).vars as Record<string, string>)
					.KERNEL_EXECUTE,
			).toBe("true");
		} finally {
			restoreEnv(original);
		}
	});

	test("a local Workers AI model override changes generated config only", () => {
		const original = snapshotEnv("TEDIX_DEV_VAR_KERNEL_WORKERS_AI_MODEL");
		try {
			const directory = mkdtempSync(join(tmpdir(), "tedix-local-model-"));
			const path = join(directory, "wrangler.jsonc");
			const source = JSON.stringify({
				name: "tedix-api",
				vars: { KERNEL_WORKERS_AI_MODEL: "original-model" },
			});
			writeFileSync(path, source);
			process.env.TEDIX_DEV_VAR_KERNEL_WORKERS_AI_MODEL =
				"@cf/openai/gpt-oss-120b";
			expect(
				(createLocalWranglerConfig(path).vars as Record<string, string>)
					.KERNEL_WORKERS_AI_MODEL,
			).toBe("@cf/openai/gpt-oss-120b");
			expect(readFileSync(path, "utf8")).toBe(source);
		} finally {
			restoreEnv(original);
		}
	});

	test("an override cannot reintroduce anything sanitize strips", () => {
		const original = snapshotEnv("TEDIX_DEV_VAR_KERNEL_EXECUTE");
		try {
			process.env.TEDIX_DEV_VAR_KERNEL_EXECUTE = "true";
			const directory = mkdtempSync(
				join(tmpdir(), "tedix-dev-local-override-sanitize-"),
			);
			const path = join(directory, "wrangler.jsonc");
			writeFileSync(
				path,
				JSON.stringify({
					name: "tedix-mcp",
					account_id: "production-account",
					routes: ["example.com/*"],
					route: "example.com/*",
					env: { production: { routes: ["example.com/*"] } },
					vars: { KERNEL_EXECUTE: "false" },
					d1_databases: [
						{
							binding: "DB",
							database_name: "prod",
							database_id: "production-database",
							remote: true,
						},
					],
				}),
			);

			const config = createLocalWranglerConfig(path);
			expect(
				(config.vars as Record<string, string>).KERNEL_EXECUTE,
				"the override itself must still apply",
			).toBe("true");
			expect(config.account_id).toBeUndefined();
			expect(config.env).toBeUndefined();
			expect(config.routes).toBeUndefined();
			expect(config.route).toBeUndefined();
			expect(config.d1_databases).toEqual([
				{
					binding: "DB",
					database_name: "prod",
					database_id: "00000000-0000-0000-0000-000000000000",
					remote: false,
				},
			]);
			expect(JSON.stringify(config)).not.toContain('"remote":true');
		} finally {
			restoreEnv(original);
		}
	});

	test("an unlisted var name throws, naming the allowlist", () => {
		expect(() =>
			resolveShellVarOverrides({ TEDIX_DEV_VAR_SOME_INVENTED_NAME: "1" }),
		).toThrow(
			/TEDIX_DEV_VAR_SOME_INVENTED_NAME is not an overridable local var\. Allowed: .*KERNEL_EXECUTE/,
		);
	});

	test("a prefix with no var name throws instead of being ignored", () => {
		expect(() => resolveShellVarOverrides({ TEDIX_DEV_VAR_: "1" })).toThrow(
			/names no var to override/,
		);
	});

	// The refusal must come from the deny-set, not from mere absence in the
	// allowlist: those are different messages, and only the first survives a
	// careless allowlist edit.
	test("every denied var is refused by the deny check, in any casing", () => {
		for (const name of deniedVars()) {
			for (const spelling of [name.toUpperCase(), name.toLowerCase()]) {
				expect(
					() =>
						resolveShellVarOverrides({
							[`TEDIX_DEV_VAR_${spelling}`]: "https://production.example",
						}),
					spelling,
				).toThrow(
					/is refused: .* carries account, credential, or endpoint identity/,
				);
			}
		}
	});

	// The whole safety property: adding a denied name to SHELL_OVERRIDABLE_VARS
	// must not open the hole, because the deny check runs first and the two sets
	// share no member.
	test("the deny-set is independent of, and disjoint from, the allowlist", () => {
		const allowed = new Set(allowedVars().map((name) => name.toLowerCase()));
		for (const name of deniedVars()) {
			expect(allowed.has(name.toLowerCase()), `${name} is in both sets`).toBe(
				false,
			);
		}
		const body = source.slice(
			source.indexOf("export function resolveShellVarOverrides"),
		);
		const deny = body.indexOf("NEVER_OVERRIDABLE_VARS.has");
		const allow = body.indexOf("SHELL_OVERRIDABLE_VARS.has");
		expect(deny).toBeGreaterThan(-1);
		expect(allow).toBeGreaterThan(-1);
		expect(deny, "the deny check must be consulted first").toBeLessThan(allow);
	});

	// Restated from the other side: nothing on the allowlist may be denied, or
	// the documented override channel would be dead on arrival.
	test("every allowlisted var is actually accepted", () => {
		for (const name of allowedVars()) {
			expect(
				resolveShellVarOverrides({ [`TEDIX_DEV_VAR_${name}`]: "value" }),
				name,
			).toEqual({ [name]: "value" });
		}
	});
});
