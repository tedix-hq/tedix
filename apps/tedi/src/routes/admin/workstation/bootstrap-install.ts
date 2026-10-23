import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { type WorkstationInstallStatus } from "@tedix/api-contract/schemas/workstation";
import {
	shellSingleQuote,
	packageManagerForLockfile,
	packageManagerCacheDir,
	WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER,
	WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS,
	WORKSTATION_JOBS_DIR,
	parseKeyValueLines,
	WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH,
	execCheckoutOperation,
	parseProcessId,
} from "./shared";

/** Marker echoed because workstation bootstrap deliberately skips lifecycle scripts. */
export const WORKSTATION_INSTALL_DEGRADED_MARKER =
	"TEDIX_WORKSTATION_INSTALL=no-scripts";

export const WORKSTATION_INSTALL_REUSE_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=reuse-cache";

export const WORKSTATION_INSTALL_RETRY_PRESERVE_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=retry-preserve-cache";

export const WORKSTATION_INSTALL_RETRY_CLEAN_CACHE_MARKER =
	"TEDIX_WORKSTATION_INSTALL=retry-clean-cache";

export const WORKSTATION_BUN_BOOTSTRAP_FILTERS =
	"--filter '!@tedix/cms' --filter '!@tedix/cms-runtime'";

export const WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS = `--frozen-lockfile --ignore-scripts ${WORKSTATION_BUN_BOOTSTRAP_FILTERS}`;

// Must equal the repo's packageManager pin; bun-version-alignment.test.ts
// is the guard, because this drifted for a day and made every delegated
// verification command unsatisfiable.
export const WORKSTATION_BUN_VERSION = "1.4.4";

export const WORKSTATION_BUN_ALIGNMENT_TIMEOUT_SECONDS = 120;

export const WORKSTATION_BUN_INSTALL_PHASE_TIMEOUT_SECONDS = 300;

export const WORKSTATION_BUN_INSTALL_ATTEMPTS = 3;

/**
 * Install dependencies without lifecycle scripts in the constrained workstation.
 *
 * A plain `bun install --frozen-lockfile` dies compiling
 * `better-sqlite3`, a transitive dependency of the `emdash` CMS package whose
 * `prebuild-install` finds no matching prebuilt binary in the sandbox and
 * falls back to a node-gyp build that cannot complete there. More importantly,
 * the full monorepo lifecycle-script pass can monopolize the container long
 * enough that every status and tool probe times out. Waiting for that pass to
 * fail before retrying is therefore not a usable fallback: the verifier loses
 * its control plane before the retry begins.
 *
 * A workstation exists to run the repo's own tooling (edit, lint, format,
 * test, commit). No coding turn needs a natively-compiled SQLite driver for a
 * CMS runtime that never boots here — the repo's own suites use `node:sqlite`.
 * So bootstrap uses the same frozen lockfile while skipping lifecycle scripts
 * and the two CMS runtime workspaces from the outset. CMS work can install its
 * scoped workspace explicitly; making every coding session pay that native
 * dependency cost leaves the workstation unusable. The policy is announced on
 * stdout so the degraded native environment remains visible rather than silent.
 */
export function withoutLifecycleScripts(command: string): string {
	return `echo ${shellSingleQuote(WORKSTATION_INSTALL_DEGRADED_MARKER)} && ${command}`;
}

export function bunInstallWithResilientCache(
	cacheDir: string,
	installArguments: string,
): string {
	const cache = shellSingleQuote(cacheDir);
	const version = shellSingleQuote(WORKSTATION_BUN_VERSION);
	const install = `rm -rf -- node_modules && mkdir -p ${cache} && timeout ${WORKSTATION_BUN_INSTALL_PHASE_TIMEOUT_SECONDS} env BUN_INSTALL_CACHE_DIR=${cache} bun install ${installArguments} --network-concurrency "$network_concurrency"`;
	return `if [ "$(bun --version)" != ${version} ]; then echo 'TEDIX_WORKSTATION_INSTALL=align-bun' && timeout ${WORKSTATION_BUN_ALIGNMENT_TIMEOUT_SECONDS} npm install -g --force bun@${WORKSTATION_BUN_VERSION}; fi && test "$(bun --version)" = ${version} && attempt=1 && install_status=1 && while [ "$attempt" -le ${WORKSTATION_BUN_INSTALL_ATTEMPTS} ]; do if [ "$attempt" -eq 1 ]; then network_concurrency=8; echo ${shellSingleQuote(WORKSTATION_INSTALL_REUSE_CACHE_MARKER)} attempt="$attempt"; elif [ "$attempt" -eq 2 ]; then network_concurrency=4; echo ${shellSingleQuote(WORKSTATION_INSTALL_RETRY_PRESERVE_CACHE_MARKER)} attempt="$attempt" >&2; else network_concurrency=2; echo ${shellSingleQuote(WORKSTATION_INSTALL_RETRY_CLEAN_CACHE_MARKER)} attempt="$attempt" >&2; rm -rf -- ${cache}; fi; ${install}; install_status=$?; if [ "$install_status" -eq 0 ]; then break; fi; attempt=$((attempt + 1)); done && [ "$install_status" -eq 0 ]`;
}

export function installCommandForLockfile(lockfile: string | null): string {
	const packageManager = packageManagerForLockfile(lockfile);
	const cacheDir = packageManagerCacheDir(packageManager);
	const mkdirCache = `mkdir -p ${shellSingleQuote(cacheDir)}`;
	if (packageManager === "bun") {
		const installArguments = WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS;
		return withoutLifecycleScripts(
			bunInstallWithResilientCache(cacheDir, installArguments),
		);
	}
	if (packageManager === "pnpm") {
		const store = `--store-dir ${shellSingleQuote(`${cacheDir}/store`)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`pnpm install --frozen-lockfile --ignore-scripts ${store}`)}`;
	}
	if (packageManager === "yarn") {
		const yarnCache = `YARN_CACHE_FOLDER=${shellSingleQuote(cacheDir)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`${yarnCache} yarn install --frozen-lockfile --ignore-scripts`)}`;
	}
	if (packageManager === "npm") {
		const npmCache = `npm_config_cache=${shellSingleQuote(cacheDir)}`;
		return `${mkdirCache} && ${withoutLifecycleScripts(`${npmCache} npm ci --ignore-scripts`)}`;
	}
	const installArguments = `--ignore-scripts ${WORKSTATION_BUN_BOOTSTRAP_FILTERS}`;
	return withoutLifecycleScripts(
		bunInstallWithResilientCache(cacheDir, installArguments),
	);
}

/** The marker describes the install actually usable by this runtime, not just its lockfile. */
export function dependencyFingerprintCommand(
	lockfile: string,
	lockfileHash: string,
): string {
	const policies = Object.fromEntries(
		[
			"bun.lock",
			"bun.lockb",
			"package-lock.json",
			"pnpm-lock.yaml",
			"yarn.lock",
			"",
		].map((name) => [
			name,
			{
				manager: packageManagerForLockfile(name || null),
				install: name.startsWith("bun.lock")
					? `bun@${WORKSTATION_BUN_VERSION} install ${WORKSTATION_BUN_BOOTSTRAP_ARGUMENTS}`
					: installCommandForLockfile(name || null),
			},
		]),
	);
	const script = `const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const [lockfile, expectedHash] = process.argv.slice(1);
const policies = ${JSON.stringify(policies)};
const policy = policies[lockfile];
if (!policy) throw new Error("Unsupported dependency lockfile");
const hash = createHash("sha256").update(fs.readFileSync(lockfile || "package.json")).digest("hex");
if (hash !== expectedHash) throw new Error("Dependency lockfile changed during preparation");
const manager = policy.manager === "unknown" ? "bun" : policy.manager;
const version = execFileSync(manager, ["--version"], { encoding: "utf8" }).trim();
const identity = { lockfile, hash, policy: policy.install, manager, version, node: process.version, platform: process.platform, arch: process.arch };
process.stdout.write(createHash("sha256").update(JSON.stringify(identity)).digest("hex"));`;
	return `node -e ${shellSingleQuote(script)} ${lockfile} ${lockfileHash}`;
}

export function verifiedInstallCommandForLockfile(
	lockfile: string | null,
	lockfileHash: string,
): string {
	const marker = shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER);
	const markerTemp = shellSingleQuote(
		`${WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER}.tmp`,
	);
	const fingerprint = dependencyFingerprintCommand(
		shellSingleQuote(lockfile ?? ""),
		shellSingleQuote(lockfileHash),
	);
	// A failed install must never leave a readiness marker. Recompute after install:
	// Bun alignment can change the toolchain, and the lockfile may have changed.
	return `dependency_fingerprint=$(${fingerprint}) && if [ -f ${marker} ] && [ "$(cat ${marker})" = "$dependency_fingerprint" ]; then echo 'TEDIX_WORKSTATION_INSTALL=prepared'; else rm -f -- ${marker} ${markerTemp} && ${installCommandForLockfile(lockfile)} && dependency_fingerprint=$(${fingerprint}) && mkdir -p node_modules && printf '%s\\n' "$dependency_fingerprint" > ${markerTemp} && mv ${markerTemp} ${marker}; fi`;
}

export function isStuckInstall(
	startedAt: string | null,
	running: boolean,
): boolean {
	if (!running || !startedAt) return false;
	const started = Date.parse(startedAt);
	return (
		Number.isFinite(started) &&
		Date.now() - started > WORKSTATION_BOOTSTRAP_INSTALL_STUCK_MS
	);
}

export function bootstrapInstallPointerPath(installProcessId: string): string {
	return `${WORKSTATION_JOBS_DIR}/${installProcessId}-current`;
}

export function parseBootstrapProbeOutput(output: string) {
	const probe = parseKeyValueLines(output);
	// A missing response is not an explicit observation of a manifest-free repo.
	if (probe.packageJson !== "0" && probe.packageJson !== "1") {
		throw new Error(
			"Bootstrap readiness probe returned missing or invalid packageJson observation",
		);
	}
	return probe;
}

export function bootstrapProbeCommand(installProcessId: string): string {
	const installPointerPath = bootstrapInstallPointerPath(installProcessId);
	return [
		"set -u",
		"printf 'packageJson='; if [ -f package.json ]; then printf '1\\n'; else printf '0\\n'; fi",
		"printf 'nodeModules='; if [ -d node_modules ]; then printf '1\\n'; else printf '0\\n'; fi",
		"lockfile=''",
		'for candidate in bun.lock bun.lockb package-lock.json pnpm-lock.yaml yarn.lock; do if [ -f "$candidate" ]; then lockfile="$candidate"; break; fi; done',
		"printf 'lockfile=%s\\n' \"$lockfile\"",
		'lockfile_hash=""',
		'hash_target="$lockfile"; if [ -z "$hash_target" ] && [ -f package.json ]; then hash_target=package.json; fi',
		'if [ -n "$hash_target" ]; then if command -v sha256sum >/dev/null 2>&1; then lockfile_hash=$(sha256sum "$hash_target" | awk \'{print $1}\'); elif command -v shasum >/dev/null 2>&1; then lockfile_hash=$(shasum -a 256 "$hash_target" | awk \'{print $1}\'); fi; fi',
		"printf 'lockfileHash=%s\\n' \"$lockfile_hash\"",
		`active_install_id=${shellSingleQuote(installProcessId)}`,
		`if [ -n "$lockfile_hash" ] && [ -f ${shellSingleQuote(installPointerPath)} ]; then install_pointer=$(cat ${shellSingleQuote(installPointerPath)}); pointer_hash=\${install_pointer%%=*}; pointer_id=\${install_pointer#*=}; case "$pointer_id" in ''|*[!A-Za-z0-9_.:-]*) ;; *) if [ "$pointer_hash" = "$lockfile_hash" ]; then active_install_id="$pointer_id"; fi ;; esac; fi`,
		"printf 'installProcessId=%s\\n' \"$active_install_id\"",
		`dependency_fingerprint=""; if [ -n "$lockfile_hash" ]; then dependency_fingerprint=$(${dependencyFingerprintCommand('"$lockfile"', '"$lockfile_hash"')}) || exit 1; fi`,
		`printf 'depsReady='; if [ -n "$dependency_fingerprint" ] && [ -f ${shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER)} ] && [ "$(cat ${shellSingleQuote(WORKSTATION_BOOTSTRAP_DEPENDENCY_MARKER)})" = "$dependency_fingerprint" ]; then printf '1\\n'; else printf '0\\n'; fi`,
		`if [ -f ${shellSingleQuote(WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH)} ]; then printf 'cacheRestoredAt='; cat ${shellSingleQuote(WORKSTATION_BOOTSTRAP_CACHE_RESTORED_AT_PATH)}; printf '\\n'; fi`,
	].join(" && ");
}

export async function ensureBootstrapInstallProcessId(
	c: Context<AppEnv>,
	fallbackProcessId: string,
	lockfileHash: string,
): Promise<string> {
	const candidate = `${fallbackProcessId}-${crypto.randomUUID().slice(0, 12)}`;
	const pointer = shellSingleQuote(
		bootstrapInstallPointerPath(fallbackProcessId),
	);
	const result = await execCheckoutOperation(
		c,
		[
			`mkdir -p ${shellSingleQuote(WORKSTATION_JOBS_DIR)}`,
			`current=''; if [ -f ${pointer} ]; then current=$(cat ${pointer}); fi`,
			`pointer_hash=\${current%%=*}; pointer_id=\${current#*=}`,
			`if [ "$pointer_hash" != ${shellSingleQuote(lockfileHash)} ] || ! printf '%s' "$pointer_id" | grep -Eq '^[A-Za-z0-9_.:-]+$'; then pointer_id=${shellSingleQuote(candidate)}; tmp=${pointer}.${shellSingleQuote(candidate)}.tmp; printf '%s\\n' ${shellSingleQuote(`${lockfileHash}=${candidate}`)} > "$tmp"; mv "$tmp" ${pointer}; fi`,
			"printf 'installProcessId=%s\\n' \"$pointer_id\"",
		].join(" && "),
		{ timeout: 30_000 },
	);
	if (result.exitCode !== 0 || result.timedOut) {
		throw new Error(
			result.stderr ||
				result.stdout ||
				"failed to allocate a bootstrap install execution id",
		);
	}
	return (
		parseProcessId(
			parseKeyValueLines(result.stdout ?? "").installProcessId,
			candidate,
		) ?? candidate
	);
}

export function installStatusFromProbe(input: {
	depsReady: boolean;
	hasInstallJob: boolean;
	installCanceledAt: string | null;
	installExitCode: number | null;
	installError?: string | null;
	installRunning: boolean;
	installStartedAt: string | null;
	installTimedOutAt: string | null;
	packageJson: boolean;
}): WorkstationInstallStatus {
	if (!input.packageJson) return "not_required";
	if (input.installTimedOutAt) return "timed_out";
	if (input.depsReady) return "ready";
	if (input.installCanceledAt) return "canceled";
	if (input.installRunning && isStuckInstall(input.installStartedAt, true)) {
		return "stuck";
	}
	if (input.installRunning) return "running";
	if (input.installError) return "failed";
	if (typeof input.installExitCode === "number") {
		return input.installExitCode === 0 ? "completed" : "failed";
	}
	return input.hasInstallJob ? "unknown" : "missing";
}
