import type { OsDevLane } from "./dev-lane";

/**
 * Public build configuration for the Tedix OS SPA.
 *
 * Public values are baked into the browser bundle as `define` constants.
 * Independent installations have no Tedix Cloud default: a build that cannot
 * resolve every one of them fails loudly instead of quietly shipping the
 * Cloud identity into a self-hosted or exported checkout. Resolution order:
 *
 * 1. `TEDIX_BUILD_<NAME>` in the environment (always wins).
 * 2. In the isolated local lane only, the local-development sentinel.
 * 3. The text bindings of `apps/os/cloudflare.config.ts` for the build mode —
 *    the same checked-in, non-secret Worker config that `src/worker.ts` reads
 *    at runtime, so the SPA and its Worker agree on one source. The OSS export
 *    redacts every text value to a placeholder, which is treated as unset.
 * 4. The exact managed OS and broker origins only when the configured
 *    Descope base is the managed auth host.
 * 5. Otherwise a `MissingOsBuildConfigError` naming the exact variables.
 *
 * Documented in apps/os/README.md § Build configuration.
 */
export const OS_BUILD_VARIABLES = [
	"API_URL",
	"DESCOPE_PROJECT_ID",
	"DESCOPE_BASE_URL",
	"OS_URL",
	"SESSION_BROKER_URL",
] as const;

export type OsBuildVariable = (typeof OS_BUILD_VARIABLES)[number];
export type OsBuildConfig = Record<OsBuildVariable, string>;

/**
 * Values for the zero-account local lane. `DESCOPE_PROJECT_ID` is the same
 * sentinel `@tedix/auth/local-demo` exports as `LOCAL_DEMO_PROJECT_ID` and
 * `scripts/dev-local.ts` writes into the local Worker's vars; the Descope base
 * URL dead-ends on a closed loopback port exactly like the Worker-side value.
 * `API_URL` matches `LOCAL_OS_URL` in `scripts/run-local.ts`; the SPA ignores
 * it in the local lane and calls the same-origin `/api` proxy instead.
 */
export const LOCAL_OS_BUILD_SENTINELS: OsBuildConfig = {
	API_URL: "http://localhost:3030/api",
	DESCOPE_PROJECT_ID: "local-development-disabled",
	DESCOPE_BASE_URL: "http://127.0.0.1:9",
	OS_URL: "https://os.tedix.dev",
	SESSION_BROKER_URL: "https://auth.tedix.dev",
};

/** Placeholder the public export writes in place of every private var. */
export const PUBLIC_OVERLAY_PLACEHOLDER = "configured-via-private-overlay";

export const OS_BUILD_ENV_PREFIX = "TEDIX_BUILD_";

export class MissingOsBuildConfigError extends Error {
	constructor(readonly missing: readonly OsBuildVariable[]) {
		super(
			[
				`Tedix OS build configuration is incomplete: ${missing
					.map((name) => `${OS_BUILD_ENV_PREFIX}${name}`)
					.join(", ")} not set.`,
				"The OS build has no Tedix Cloud default. Set the variable(s) above in the",
				"environment, or set the matching text bindings in",
				"apps/os/cloudflare.config.ts for a deployed installation. The isolated local",
				"lane (`bun run-local`, `bun run dev:os-local`) supplies its own sentinels.",
				'See apps/os/README.md, section "Build configuration".',
			].join("\n"),
		);
		this.name = "MissingOsBuildConfigError";
	}
}

/**
 * The isolated local lane is the only one that may build without explicit
 * values. `TEDIX_BUILD_LOCAL_DEMO_ENABLED=true` is the existing marker both
 * launchers (`scripts/run-local.ts`, `scripts/dev/os-local.ts`) already set on
 * the OS build; the Worker-backed HMR lane and the fixture dev server are
 * local by construction.
 */
export function isLocalOsBuildLane(
	environment: NodeJS.ProcessEnv,
	lane: OsDevLane,
	command: "build" | "serve",
): boolean {
	if (environment.TEDIX_BUILD_LOCAL_DEMO_ENABLED === "true") return true;
	if (lane === "local-worker") return true;
	return command === "serve" && lane === "fixtures";
}

function presentString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed === PUBLIC_OVERLAY_PLACEHOLDER) return null;
	return trimmed;
}

function assertCanonicalOrigin(value: string): void {
	try {
		const url = new URL(value);
		if (
			url.protocol === "https:" &&
			!url.port &&
			!url.username &&
			!url.password &&
			value === url.origin
		)
			return;
	} catch {
		// Reject without echoing the value into build logs.
	}
	throw new Error("OS installation origins must be canonical HTTPS hosts");
}

/** The Worker's text bindings in one config mode, as the SPA build reads them. */
export async function readWorkerVars(
	mode: string,
): Promise<Record<string, string>> {
	const { default: config } = await import("../cloudflare.config");
	const { worker } = await config({ mode, isPreview: false });
	return Object.fromEntries(
		Object.entries(worker.env ?? {}).flatMap(([name, binding]) =>
			binding.type === "text" ? [[name, binding.value]] : [],
		),
	);
}

export function resolveOsBuildConfig(input: {
	environment: NodeJS.ProcessEnv;
	localLane: boolean;
	workerVars: Record<string, unknown> | null;
}): OsBuildConfig {
	const resolved: Partial<OsBuildConfig> = {};
	const missing: OsBuildVariable[] = [];
	for (const name of OS_BUILD_VARIABLES) {
		const managedOrigin =
			resolved.DESCOPE_BASE_URL === "https://auth.tedix.dev";
		const managedDefault = managedOrigin
			? name === "OS_URL"
				? "https://os.tedix.dev"
				: name === "SESSION_BROKER_URL"
					? "https://auth.tedix.dev"
					: null
			: null;
		const value =
			presentString(input.environment[`${OS_BUILD_ENV_PREFIX}${name}`]) ??
			(input.localLane ? LOCAL_OS_BUILD_SENTINELS[name] : null) ??
			presentString(input.workerVars?.[name]) ??
			managedDefault;
		if (value === null) missing.push(name);
		else resolved[name] = value;
	}
	if (missing.length > 0) throw new MissingOsBuildConfigError(missing);
	const config = resolved as OsBuildConfig;
	if (!input.localLane) {
		assertCanonicalOrigin(config.OS_URL);
		assertCanonicalOrigin(config.SESSION_BROKER_URL);
		if (config.SESSION_BROKER_URL !== config.DESCOPE_BASE_URL) {
			throw new Error(
				"OS session broker and Descope base origins must be the same auth host",
			);
		}
		if (config.OS_URL === config.SESSION_BROKER_URL) {
			throw new Error("OS and session broker origins must differ");
		}
		if (
			(config.OS_URL === "https://os.tedix.dev") !==
			(config.SESSION_BROKER_URL === "https://auth.tedix.dev")
		) {
			throw new Error("An installation cannot mix managed Tedix origins");
		}
	}
	return config;
}
