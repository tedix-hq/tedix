#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

type JsonObject = Record<string, unknown>;

const REMOTE_ONLY_BINDINGS = [
	"ai",
	"agent_memory",
	"ai_search_namespaces",
	"artifacts",
	"dispatch_namespaces",
	"flagship",
] as const;

const localApiUrl =
	process.env.TEDIX_LOCAL_API_URL?.trim() || "http://localhost:8787";
const localCompatibilityDate =
	process.env.TEDIX_LOCAL_COMPATIBILITY_DATE?.trim();
const localInferenceEnabled =
	process.env.TEDIX_LOCAL_INFERENCE_ENABLED === "true";
const localInferenceBackend = localInferenceEnabled
	? process.env.TEDIX_LOCAL_INFERENCE_BACKEND?.trim()
	: null;
const localWorkersAiAccountId =
	process.env.TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID?.trim();
if (
	localInferenceBackend !== null &&
	localInferenceBackend !== "gateway" &&
	localInferenceBackend !== "workers-ai"
) {
	throw new Error(
		`Unsupported TEDIX_LOCAL_INFERENCE_BACKEND: ${localInferenceBackend || "(missing)"}. Set workers-ai or gateway`,
	);
}
const localAiGatewayId = process.env.TEDIX_LOCAL_AI_GATEWAY_ID?.trim();
if (
	localInferenceBackend !== null &&
	(!localWorkersAiAccountId || !/^[a-f\d]{32}$/i.test(localWorkersAiAccountId))
) {
	throw new Error(
		`TEDIX_LOCAL_INFERENCE_BACKEND=${localInferenceBackend} requires a 32-character TEDIX_LOCAL_WORKERS_AI_ACCOUNT_ID`,
	);
}
if (localInferenceBackend === "gateway" && !localAiGatewayId) {
	throw new Error(
		"TEDIX_LOCAL_INFERENCE_BACKEND=gateway requires TEDIX_LOCAL_AI_GATEWAY_ID",
	);
}
const explicitLocalPersistTo = process.env.TEDIX_LOCAL_PERSIST_TO?.trim();

const LOCAL_VARS: Record<string, string> = {
	ENVIRONMENT: "development",
	API_URL: localApiUrl,
	MCP_URL: "http://localhost:3000",
	MCP_UI_URL: "http://localhost:3001",
	OS_URL: "http://localhost:3030",
	TEDI_DEV_BASE_URL: "http://localhost:3007",
	PUBLIC_URL: "http://localhost:3010",
	DESCOPE_PROJECT_ID: "local-development-disabled",
	DESCOPE_BASE_URL: "http://127.0.0.1:9",
	DESCOPE_AIH_BASE_URL: "http://127.0.0.1:9",
	CF_ACCOUNT_ID: "local-development-disabled",
	CF_ACCOUNT_HASH: "local-development-disabled",
	AI_GATEWAY_ACCOUNT_ID: "local-development-disabled",
	AI_GATEWAY_LLM_ID: "local-development-disabled",
	ASSETS_URL: `${localApiUrl}/assets`,
	DOCS_BASE_DOMAIN: "localhost",
	ANALYTICS_ENGINE_DATASET: "tedix_local_analytics",
	CODEMODE_ANALYTICS_DATASET: "tedix_local_codemode",
	R2_SQL_WAREHOUSE: "local-development-disabled",
	STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "local-development-disabled",
	STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "local-development-disabled",
	DATAFORSEO_MANAGED_ENABLED: "false",
	KERNEL_EXECUTE: "false",
	TEDIX_LOCAL_DEMO_ENABLED: "true",
	TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	TEDIX_FLEET_AUTHORITY_MODE: "disabled",
	TEDIX_RUNTIME_ENTITLEMENT_GRANTS: localInferenceEnabled
		? JSON.stringify([
				{
					key: "local-inference",
					status: "active",
					source: "operator",
				},
			])
		: "[]",
	GRAPH_DB_URI: "neo4j://127.0.0.1:9",
};

// Explicit shell overrides affect generated local config only, not tracked files.
// The prefix isolates overrides from ambient variables such as ENVIRONMENT:
// `TEDIX_DEV_VAR_KERNEL_EXECUTE=true bun dev`.
const SHELL_VAR_OVERRIDE_PREFIX = "TEDIX_DEV_VAR_";

// Allow behavior switches, never account, credential, or endpoint wiring.
const SHELL_OVERRIDABLE_VARS = new Set([
	// Enable local kernel turn execution.
	"KERNEL_EXECUTE",
	// Select a model on the already configured Workers AI account/gateway.
	"KERNEL_WORKERS_AI_MODEL",
	// Disable demo seeding to test an empty first run.
	"TEDIX_LOCAL_DEMO_ENABLED",
	// Billing settlement is disabled locally unless explicitly enabled.
	"TEDIX_BILLING_SETTLEMENT_MODE",
	// Select the managed DataForSEO path without supplying credentials.
	"DATAFORSEO_MANAGED_ENABLED",
	// Select environment-specific branches without changing destinations.
	"ENVIRONMENT",
	// Override the inferred grant set with an explicit JSON policy value.
	"TEDIX_RUNTIME_ENTITLEMENT_GRANTS",
]);

// Reject destination/identity overrides case-insensitively before the allowlist
// check, so an allowlist edit cannot redirect local runs to production.
// Include every non-behavior LOCAL_VARS key here; keep this list independent of
// SHELL_OVERRIDABLE_VARS so changing that set cannot remove a denied name.
const NEVER_OVERRIDABLE_VARS = new Set(
	[
		"DESCOPE_PROJECT_ID",
		"DESCOPE_BASE_URL",
		"DESCOPE_AIH_BASE_URL",
		"CF_ACCOUNT_ID",
		"CF_ACCOUNT_HASH",
		"AI_GATEWAY_ACCOUNT_ID",
		"AI_GATEWAY_LLM_ID",
		"GRAPH_DB_URI",
		"DATABASE_ID",
		"R2_SQL_WAREHOUSE",
		"API_URL",
		"MCP_URL",
		"OS_URL",
		"MCP_UI_URL",
		"TEDI_DEV_BASE_URL",
		"PUBLIC_URL",
		"ASSETS_URL",
		"DOCS_BASE_DOMAIN",
		// Added by the local-inference opt-in rather than LOCAL_VARS, but it is the
		// address every local prompt is sent to, so it is endpoint identity too.
		"TEDIX_LOCAL_INFERENCE_PROXY_URL",
		// Telemetry destinations: repointing one writes local dev traffic into a
		// production dataset, which is the same hazard wearing a different name.
		"ANALYTICS_ENGINE_DATASET",
		"CODEMODE_ANALYTICS_DATASET",
		// Stripe objects live in a real Stripe account; a local run must never name
		// one, in either mode.
		"STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
		"STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID",
	].map((name) => name.toLowerCase()),
);

/**
 * Reads the shell's `TEDIX_DEV_VAR_*` entries into a plain name -> value map.
 *
 * Throws on a denied name (identity/credential/endpoint) and on an unknown one:
 * a typo'd override that silently did nothing would be worse than a hard stop,
 * since the run would look configured and behave as if it were not.
 */
export function resolveShellVarOverrides(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!key.startsWith(SHELL_VAR_OVERRIDE_PREFIX)) continue;
		const name = key.slice(SHELL_VAR_OVERRIDE_PREFIX.length);
		if (name.length === 0) {
			throw new Error(`${key} names no var to override.`);
		}
		if (NEVER_OVERRIDABLE_VARS.has(name.toLowerCase())) {
			throw new Error(
				`${key} is refused: ${name} carries account, credential, or endpoint identity, and local dev must never be re-pointed at production.`,
			);
		}
		if (!SHELL_OVERRIDABLE_VARS.has(name)) {
			throw new Error(
				`${key} is not an overridable local var. Allowed: ${[...SHELL_OVERRIDABLE_VARS].sort().join(", ")}. Add ${name} to SHELL_OVERRIDABLE_VARS in scripts/dev-local.ts only if it is a behaviour switch.`,
			);
		}
		overrides[name] = value;
	}
	return overrides;
}

/**
 * Precedence is shell > LOCAL_VARS > committed wrangler.jsonc, so this runs
 * last and gets the final word.
 */
function applyShellVarOverrides(config: JsonObject): void {
	const overrides = resolveShellVarOverrides();
	if (Object.keys(overrides).length === 0) return;
	if (!isObject(config.vars)) return;

	const applied: string[] = [];
	for (const [name, value] of Object.entries(overrides)) {
		// Only a var the app actually declares — LOCAL_VARS' force-added keys are
		// already present in `vars` by this point, so they are covered too. An
		// override can therefore only ever write a string into an existing `vars`
		// key: it cannot reintroduce a remote binding, an `account_id`, an `env`
		// block, or a route, and every `sanitize` guarantee still holds.
		if (!(name in config.vars)) continue;
		config.vars[name] = value;
		applied.push(`${name}=${value}`);
	}
	// Once per generated config, on stderr, so a weird local run is diagnosable.
	// Only allowlisted names reach here, so this can never print a denied value.
	if (applied.length > 0) {
		console.error(
			`[dev-local] ${String(config.name)}: shell var overrides ${applied.join(" ")}`,
		);
	}
}

// `LOCAL_VARS` is a Record, so indexing it yields `string | undefined` under
// noUncheckedIndexedAccess. These two keys are declared literally above, so
// require them explicitly rather than widening the map or asserting.
function requireLocalVar(key: string): string {
	const value = LOCAL_VARS[key];
	if (value === undefined) {
		throw new Error(`[dev-local] missing required LOCAL_VARS entry: ${key}`);
	}
	return value;
}

const LOCAL_PROCESS_ENV: Record<string, string> = {
	DESCOPE_PROJECT_ID: requireLocalVar("DESCOPE_PROJECT_ID"),
	DESCOPE_BASE_URL: requireLocalVar("DESCOPE_BASE_URL"),
};

const LOCAL_D1_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const LOCAL_API_WORKER_NAME = "public-installation-api";

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitize);
	if (!isObject(value)) return value;

	const output: JsonObject = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "compatibility_date" && localCompatibilityDate) {
			output[key] = localCompatibilityDate;
			continue;
		}
		if (
			key === "account_id" ||
			key === "env" ||
			key === "secrets" ||
			key === "routes" ||
			key === "route" ||
			key === "tail_consumers" ||
			REMOTE_ONLY_BINDINGS.includes(
				key as (typeof REMOTE_ONLY_BINDINGS)[number],
			)
		) {
			continue;
		}
		if (key === "remote") {
			output[key] = false;
			continue;
		}
		if (key === "database_id") {
			output[key] = LOCAL_D1_DATABASE_ID;
			continue;
		}
		output[key] = sanitize(child);
	}

	if (isObject(output.vars)) {
		for (const [key, replacement] of Object.entries(LOCAL_VARS)) {
			if (key in output.vars) output.vars[key] = replacement;
		}
		// These two public identifiers are mandatory for the credential-free demo,
		// even when production declares them through `secrets.required` only.
		output.vars.DESCOPE_PROJECT_ID = LOCAL_VARS.DESCOPE_PROJECT_ID;
		output.vars.DESCOPE_BASE_URL = LOCAL_VARS.DESCOPE_BASE_URL;
		output.vars.TEDIX_LOCAL_DEMO_ENABLED = LOCAL_VARS.TEDIX_LOCAL_DEMO_ENABLED;
	}
	return output;
}

function alignLocalServiceIdentities(config: JsonObject): void {
	if (config.name === "tedix-api" || config.name === LOCAL_API_WORKER_NAME) {
		config.name = LOCAL_API_WORKER_NAME;
	}
	if (!Array.isArray(config.services)) return;
	for (const service of config.services) {
		if (
			isObject(service) &&
			service.binding === "API_SERVICE" &&
			typeof service.service === "string"
		) {
			service.service = LOCAL_API_WORKER_NAME;
		}
	}
}

export function createLocalWranglerConfig(configPath: string): JsonObject {
	const errors: ParseError[] = [];
	const parsed = parse(readFileSync(configPath, "utf8"), errors, {
		allowTrailingComma: true,
	}) as unknown;
	if (errors.length > 0 || !isObject(parsed)) {
		throw new Error(`Cannot parse Wrangler config: ${configPath}`);
	}
	const config = sanitize(parsed) as JsonObject;
	alignLocalServiceIdentities(config);
	// Service identities have been normalized to the local Worker names.
	const isApi = config.name === LOCAL_API_WORKER_NAME;
	if (localInferenceBackend && isApi) {
		const vars: JsonObject = isObject(config.vars) ? config.vars : {};
		config.vars = vars;
		// Paid local inference also needs Home's normal approval/execution lane.
		vars.KERNEL_EXECUTE = "true";
	}
	if (localInferenceBackend === "gateway" && isApi) {
		// Narrow through a local binding: `config` is a JsonObject, so writing
		// through `config.vars` keeps the `unknown` property type even after the
		// isObject guard above.
		const vars: JsonObject = isObject(config.vars) ? config.vars : {};
		config.vars = vars;
		vars.AI_GATEWAY_ACCOUNT_ID = localWorkersAiAccountId as string;
		vars.AI_GATEWAY_LLM_ID = localAiGatewayId as string;
		vars.TEDIX_LOCAL_INFERENCE_PROXY_URL = "http://127.0.0.1:8791";
		if (Array.isArray(config.compatibility_flags)) {
			config.compatibility_flags = config.compatibility_flags.filter(
				(flag) => flag !== "global_fetch_strictly_public",
			);
		}
	} else if (localInferenceBackend === "workers-ai" && isApi) {
		// The account id targets the one paid remote capability explicitly. Every
		// data binding was already sanitized above: D1 remains the zero-id local
		// database with `remote: false`, and no production secret enters the Worker.
		config.account_id = localWorkersAiAccountId;
		config.ai = { binding: "AI", remote: true };
		const vars: JsonObject = isObject(config.vars) ? config.vars : {};
		config.vars = vars;
		delete vars.KERNEL_FORCE_WORKERS_AI;
		// Native inference needs an explicit provider ref; Auto requires Gateway auth.
		vars.KERNEL_WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";
		// Cloudflare creates the default gateway on the first authenticated call.
		// Keep the admission identity complete even when no custom gateway is given.
		vars.AI_GATEWAY_ACCOUNT_ID = localWorkersAiAccountId!;
		vars.AI_GATEWAY_LLM_ID = localAiGatewayId || "default";
		vars.AI_GATEWAY_BINDING_PROVIDERS = "";
	}
	applyShellVarOverrides(config);
	if (
		localInferenceBackend === "workers-ai" &&
		isApi &&
		isObject(config.vars)
	) {
		const model =
			typeof config.vars.KERNEL_WORKERS_AI_MODEL === "string"
				? config.vars.KERNEL_WORKERS_AI_MODEL.trim()
				: "";
		config.vars.KERNEL_MODEL_REF = `workers-ai/${model}`;
	}
	return config;
}

export function writeLocalWranglerConfig(cwd = process.cwd()): string {
	const source = join(cwd, "wrangler.jsonc");
	const target = join(cwd, "wrangler.local.generated.json");
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(
		target,
		`${JSON.stringify(createLocalWranglerConfig(source), null, "\t")}\n`,
	);
	return target;
}

/**
 * Where this checkout's Wrangler/Miniflare dev registry lives.
 *
 * The registry is how locally-running Workers find each other's service
 * bindings, and it defaults to ONE machine-global directory
 * (`$HOME/Library/Preferences/.wrangler/registry` on macOS). Tedix runs several
 * checkouts at once by design — agents work in linked worktrees — and every one
 * of them registers Workers under the SAME names. Whichever booted last wins,
 * so a service binding can silently resolve to another checkout's Worker: a
 * request served by the wrong code with no error anywhere. Scoping the registry
 * to the checkout makes each stack's bindings resolve to its own Workers.
 *
 * Both variables are required and must agree: `wrangler dev` reads
 * WRANGLER_REGISTRY_PATH, the Cloudflare Vite plugin reads
 * MINIFLARE_REGISTRY_PATH, and setting only one splits the stack across two
 * registries — strictly worse than setting neither.
 */
export function resolveLocalRegistryPath(cwd = process.cwd()): string {
	const explicit = process.env.TEDIX_LOCAL_REGISTRY_PATH?.trim();
	return explicit
		? resolve(explicit)
		: resolve(cwd, "../../.wrangler/registry");
}

export function resolveLocalPersistPath(
	cwd = process.cwd(),
	explicitPath = explicitLocalPersistTo,
): string {
	return explicitPath
		? resolve(explicitPath)
		: resolve(cwd, "../../.wrangler/state");
}

async function run(): Promise<void> {
	const rawArguments = process.argv.slice(2);
	const command =
		rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
	if (command.length === 0) {
		throw new Error("usage: bun scripts/dev-local.ts -- <command> [args...]");
	}

	const wranglerConfigPath = join(process.cwd(), "wrangler.jsonc");
	const configPath = existsSync(wranglerConfigPath)
		? writeLocalWranglerConfig()
		: null;
	let executable = command[0];
	if (!executable) throw new Error("missing command");
	const args = command.slice(1);
	if (basename(executable) === "wrangler") {
		executable = "bunx";
		args.unshift("wrangler");
	}
	if (basename(executable) === "bunx" && args[0] === "wrangler") {
		if (!configPath) {
			throw new Error(
				"wrangler command requires wrangler.jsonc; this workspace is configured through cloudflare.config.ts",
			);
		}
		args.push("--config", configPath);
		if (args[1] === "dev" || args[1] === "d1") {
			// `--local` disables Wrangler's remote-binding proxy wholesale. Omit it
			// only for the explicit Workers AI lane: the generated config still marks
			// every data binding `remote: false` and marks only `AI` remote. D1 CLI
			// operations are always local, including the migrations preceding this boot.
			if (args[1] !== "dev" || localInferenceBackend !== "workers-ai") {
				args.push("--local");
			}
			args.push("--persist-to", resolveLocalPersistPath());
		}
	}

	const child = spawn(executable, args, {
		cwd: process.cwd(),
		env: {
			...process.env,
			...LOCAL_PROCESS_ENV,
			...(configPath ? { TEDIX_WRANGLER_CONFIG: configPath } : {}),
			CLOUDFLARE_ENV: "",
			WRANGLER_REGISTRY_PATH: resolveLocalRegistryPath(),
			MINIFLARE_REGISTRY_PATH: resolveLocalRegistryPath(),
		},
		stdio: "inherit",
	});
	const code = await new Promise<number>((resolveCode, reject) => {
		child.once("error", reject);
		child.once("exit", (exitCode, signal) =>
			resolveCode(exitCode ?? (signal ? 1 : 0)),
		);
	});
	process.exitCode = code;
}

if (import.meta.main) await run();
