import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_VERSION, IS_STANDALONE_BUILD } from "./shared";

const DEFAULT_BASE_URL = "https://downloads.tedix.dev";
const DEFAULT_CHECK_TTL_MS = 60 * 60 * 1_000;
const JSON_LIMIT_BYTES = 1024 * 1024;
const ARTIFACT_LIMIT_BYTES = 512 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const ARTIFACT_TIMEOUT_MS = 30 * 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT_BYTES = 64 * 1024;

interface SemVer {
	major: string;
	minor: string;
	patch: string;
	prerelease: string[];
}

interface LatestRelease {
	schemaVersion: 1;
	version: string;
	sourceSha: string;
	manifestUrl: string;
}

interface ReleaseAsset {
	name: string;
	sha256: string;
	size: number;
	url: string;
}

interface ReleaseManifest {
	schemaVersion: 1;
	version: string;
	sourceSha: string;
	assets: ReleaseAsset[];
}

interface LatestCache {
	baseUrl: string;
	checkedAt: number;
	latest: LatestRelease;
	manifest: ReleaseManifest;
}

export interface UpdateCommandOptions {
	check: boolean;
	force: boolean;
	json: boolean;
	version?: string;
}

/**
 * A running `<binary> --version` probe. The default adapter is a real child
 * process; tests substitute in-memory probes so termination is exercised
 * without real processes or wall-clock waits.
 */
export interface VersionProbe {
	exited: Promise<number | null>;
	kill(): void;
	stderr: ReadableStream<Uint8Array>;
	stdout: ReadableStream<Uint8Array>;
}

export interface UpdateRuntime {
	baseUrl?: string;
	configDir?: string;
	fetch?: typeof fetch;
	installPath?: string;
	now?: () => number;
	spawnVersionProbe?: (path: string) => VersionProbe;
	standalone?: boolean;
	// Runtime adapters can use shorter deadlines; these are not CLI options.
	downloadIdleTimeoutMs?: number;
	downloadTimeoutMs?: number;
	versionTimeoutMs?: number;
}

function parseSemVer(version: string): SemVer {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (!match) throw new Error(`Invalid Tedix CLI version: ${version}`);
	return {
		major: match[1]!,
		minor: match[2]!,
		patch: match[3]!,
		prerelease: match[4]?.split(".") ?? [],
	};
}

function compareNumericIdentifiers(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left === right ? 0 : left < right ? -1 : 1;
}

export function compareVersions(
	leftVersion: string,
	rightVersion: string,
): number {
	const left = parseSemVer(leftVersion);
	const right = parseSemVer(rightVersion);
	for (const field of ["major", "minor", "patch"] as const) {
		const comparison = compareNumericIdentifiers(left[field], right[field]);
		if (comparison !== 0) return comparison;
	}
	if (left.prerelease.length === 0 || right.prerelease.length === 0) {
		return left.prerelease.length === right.prerelease.length
			? 0
			: left.prerelease.length === 0
				? 1
				: -1;
	}
	for (
		let index = 0;
		index < Math.max(left.prerelease.length, right.prerelease.length);
		index++
	) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined || rightPart === undefined) {
			return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
		}
		if (leftPart === rightPart) continue;
		const leftNumeric = /^\d+$/.test(leftPart);
		const rightNumeric = /^\d+$/.test(rightPart);
		if (leftNumeric && rightNumeric) {
			return compareNumericIdentifiers(leftPart, rightPart);
		}
		if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
		return leftPart < rightPart ? -1 : 1;
	}
	return 0;
}

function distributionBaseUrl(runtime: UpdateRuntime): string {
	return (
		runtime.baseUrl ??
		process.env.TEDIX_CLI_BASE_URL ??
		DEFAULT_BASE_URL
	).replace(/\/+$/, "");
}

function configDir(runtime: UpdateRuntime): string {
	return (
		runtime.configDir ??
		process.env.TEDIX_CONFIG_DIR ??
		join(homedir(), ".tedix")
	);
}

function targetPath(runtime: UpdateRuntime): string {
	return runtime.installPath ?? process.execPath;
}

function isHomebrewManaged(target: string): boolean {
	let resolved = target;
	try {
		resolved = realpathSync(target);
	} catch {
		// The ordinary missing-path error below owns invalid installations.
	}
	const segments = resolved.split(/[\\/]+/);
	const cellar = segments.lastIndexOf("Cellar");
	return cellar >= 0 && segments[cellar + 1] === "tedix";
}

function requireMutableStandalone(runtime: UpdateRuntime): void {
	if (!(runtime.standalone ?? IS_STANDALONE_BUILD)) {
		throw new Error(
			"This Tedix CLI is running from a source checkout. Self-update is disabled here; install or update the standalone binary with https://downloads.tedix.dev/install.sh.",
		);
	}
	if (
		!existsSync(targetPath(runtime)) ||
		!statSync(targetPath(runtime)).isFile()
	) {
		throw new Error(
			`Installed Tedix CLI binary was not found at ${targetPath(runtime)}`,
		);
	}
	if (isHomebrewManaged(targetPath(runtime))) {
		throw new Error(
			"Homebrew manages this Tedix CLI installation. Use `brew upgrade tedix-hq/tap/tedix` to update it or `brew reinstall tedix-hq/tap/tedix` to repair it; `tedix update` and `tedix rollback` are disabled for package-manager-owned binaries.",
		);
	}
}

function platformAsset(version: string): string {
	const os = process.platform === "darwin" ? "darwin" : process.platform;
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	if (!(os === "darwin" || os === "linux")) {
		throw new Error(
			"Self-update currently supports standalone macOS and Linux installations",
		);
	}
	return `tedix-${version}-${os}-${arch}`;
}

async function readBoundedResponse(
	response: Response,
	limit: number,
	label: string,
): Promise<Buffer> {
	if (!response.ok) {
		throw new Error(`${label} request failed (${response.status})`);
	}
	const contentLength = response.headers.get("content-length");
	const declared = contentLength === null ? undefined : Number(contentLength);
	if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
		throw new Error(`${label} exceeds the ${limit}-byte download limit`);
	}
	if (!response.body) throw new Error(`${label} response had no body`);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > limit) {
				await reader.cancel();
				throw new Error(`${label} exceeds the ${limit}-byte download limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, received);
}

async function fetchJson(
	url: string,
	runtime: UpdateRuntime,
	options?: { mutableAliasAt: number },
): Promise<unknown> {
	const requestUrl = options
		? `${url}${url.includes("?") ? "&" : "?"}t=${options.mutableAliasAt}`
		: url;
	let bytes: Buffer;
	try {
		const response = await (runtime.fetch ?? fetch)(requestUrl, {
			headers: {
				Accept: "application/json",
				...(options ? { "Cache-Control": "no-cache" } : {}),
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		bytes = await readBoundedResponse(
			response,
			JSON_LIMIT_BYTES,
			"Release metadata",
		);
	} catch (error) {
		throw new Error(
			`Release metadata could not be read from ${url}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`Release metadata was not valid JSON: ${requestUrl}`);
	}
}

function validateLatest(value: unknown, runtime: UpdateRuntime): LatestRelease {
	const latest = value as Partial<LatestRelease>;
	if (
		latest?.schemaVersion !== 1 ||
		typeof latest.version !== "string" ||
		typeof latest.sourceSha !== "string" ||
		!/^[0-9a-f]{40}$/.test(latest.sourceSha) ||
		typeof latest.manifestUrl !== "string"
	) {
		throw new Error("Latest release metadata is invalid");
	}
	parseSemVer(latest.version);
	const expected = `${distributionBaseUrl(runtime)}/releases/${latest.version}/manifest.json`;
	if (latest.manifestUrl !== expected) {
		throw new Error(
			"Latest release metadata contains an unexpected manifest URL",
		);
	}
	return latest as LatestRelease;
}

function validateManifest(
	value: unknown,
	version: string,
	runtime: UpdateRuntime,
): ReleaseManifest {
	const manifest = value as Partial<ReleaseManifest>;
	if (
		manifest?.schemaVersion !== 1 ||
		manifest.version !== version ||
		typeof manifest.sourceSha !== "string" ||
		!/^[0-9a-f]{40}$/.test(manifest.sourceSha) ||
		!Array.isArray(manifest.assets)
	) {
		throw new Error("Release manifest identity is invalid");
	}
	for (const asset of manifest.assets) {
		if (
			typeof asset?.name !== "string" ||
			typeof asset.url !== "string" ||
			!/^[0-9a-f]{64}$/.test(asset.sha256) ||
			!Number.isSafeInteger(asset.size) ||
			asset.size <= 0 ||
			asset.size > ARTIFACT_LIMIT_BYTES ||
			asset.url !==
				`${distributionBaseUrl(runtime)}/releases/${version}/${asset.name}`
		) {
			throw new Error("Release manifest contains an invalid artifact");
		}
	}
	return manifest as ReleaseManifest;
}

function cachePath(runtime: UpdateRuntime): string {
	return join(configDir(runtime), "update-check.json");
}

async function loadLatest(
	runtime: UpdateRuntime,
	useCache: boolean,
): Promise<{ latest: LatestRelease; manifest?: ReleaseManifest }> {
	const path = cachePath(runtime);
	const now = runtime.now?.() ?? Date.now();
	const ttl = Number(
		process.env.TEDIX_UPDATE_CHECK_TTL_MS ?? DEFAULT_CHECK_TTL_MS,
	);
	if (useCache && existsSync(path)) {
		try {
			const cached = JSON.parse(readFileSync(path, "utf8")) as LatestCache;
			if (cached.baseUrl === distributionBaseUrl(runtime)) {
				const latest = validateLatest(cached.latest, runtime);
				if (compareVersions(latest.version, CLI_VERSION) < 0) {
					rmSync(path, { force: true });
				} else {
					const age = now - cached.checkedAt;
					if (Number.isFinite(age) && age >= 0 && age < ttl) {
						const manifest = validateManifest(
							cached.manifest,
							latest.version,
							runtime,
						);
						if (manifest.sourceSha !== latest.sourceSha) {
							throw new Error("Cached release source SHA does not match");
						}
						return { latest, manifest };
					}
				}
			}
		} catch {
			// A malformed cache is only a hint; refresh canonical release metadata.
		}
	}
	const latest = validateLatest(
		await fetchJson(`${distributionBaseUrl(runtime)}/latest.json`, runtime, {
			mutableAliasAt: now,
		}),
		runtime,
	);
	if (!useCache) return { latest };
	const manifest = await loadManifest(latest.version, runtime);
	if (manifest.sourceSha !== latest.sourceSha) {
		throw new Error(
			"Latest release metadata and manifest source SHA do not match",
		);
	}
	if (compareVersions(latest.version, CLI_VERSION) >= 0) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(
			path,
			`${JSON.stringify({ baseUrl: distributionBaseUrl(runtime), checkedAt: now, latest, manifest })}\n`,
			{ mode: 0o600 },
		);
	}
	return { latest, manifest };
}

async function loadManifest(
	version: string,
	runtime: UpdateRuntime,
): Promise<ReleaseManifest> {
	parseSemVer(version);
	return validateManifest(
		await fetchJson(
			`${distributionBaseUrl(runtime)}/releases/${version}/manifest.json`,
			runtime,
		),
		version,
		runtime,
	);
}

function acquireInstallLock(target: string): () => void {
	const lockPath = `${target}.update.lock`;
	let descriptor: number;
	try {
		descriptor = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new Error(
				`Another Tedix CLI update is already active (${lockPath})`,
			);
		}
		throw error;
	}
	try {
		writeSync(
			descriptor,
			`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
		);
		fsyncSync(descriptor);
	} catch (error) {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
		throw error;
	}
	return () => {
		closeSync(descriptor);
		try {
			unlinkSync(lockPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
}

async function downloadAsset(
	asset: ReleaseAsset,
	temporary: string,
	runtime: UpdateRuntime,
	progress: boolean,
): Promise<void> {
	const controller = new AbortController();
	const idleMs = runtime.downloadIdleTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const totalMs = runtime.downloadTimeoutMs ?? ARTIFACT_TIMEOUT_MS;
	const totalTimer = setTimeout(
		() =>
			controller.abort(
				new Error(`Artifact download exceeded ${totalMs / 1000} seconds`),
			),
		totalMs,
	);
	totalTimer.unref();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const resetTimeout = () => {
		clearTimeout(timer);
		timer = setTimeout(
			() =>
				controller.abort(
					new Error(`Artifact download stalled for ${idleMs / 1000} seconds`),
				),
			idleMs,
		);
		timer.unref();
	};
	resetTimeout();
	try {
		const response = await (runtime.fetch ?? fetch)(asset.url, {
			signal: controller.signal,
		});
		if (!response.ok)
			throw new Error(`Artifact download failed (${response.status})`);
		const contentLength = response.headers.get("content-length");
		const declared = contentLength === null ? undefined : Number(contentLength);
		if (
			declared !== undefined &&
			Number.isFinite(declared) &&
			declared !== asset.size
		) {
			throw new Error(
				`Artifact size mismatch for ${asset.name}: expected ${asset.size}, got ${declared}`,
			);
		}
		if (!response.body) throw new Error("Artifact download had no body");
		const descriptor = openSync(temporary, "wx", 0o755);
		const hash = createHash("sha256");
		const reader = response.body.getReader();
		let received = 0;
		let nextPercent = 10;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value.byteLength > 0) resetTimeout();
				received += value.byteLength;
				if (received > asset.size || received > ARTIFACT_LIMIT_BYTES) {
					await reader.cancel();
					throw new Error(
						`Artifact download exceeded its declared size (${asset.size})`,
					);
				}
				const percent = Math.floor((received * 100) / asset.size);
				if (progress && percent >= nextPercent) {
					console.error(`Downloading Tedix: ${percent}%`);
					nextPercent = (Math.floor(percent / 10) + 1) * 10;
				}
				hash.update(value);
				let written = 0;
				while (written < value.byteLength) {
					const count = writeSync(
						descriptor,
						value,
						written,
						value.byteLength - written,
					);
					if (count <= 0)
						throw new Error("Artifact download could not be written");
					written += count;
				}
			}
			fsyncSync(descriptor);
		} finally {
			reader.releaseLock();
			closeSync(descriptor);
		}
		if (received !== asset.size || hash.digest("hex") !== asset.sha256) {
			throw new Error(
				"Downloaded artifact failed SHA-256 or size verification",
			);
		}
		chmodSync(temporary, 0o755);
	} catch (error) {
		const reason = controller.signal.aborted ? controller.signal.reason : error;
		throw new Error(
			`Could not download ${asset.name}: ${reason instanceof Error ? reason.message : String(reason)}`,
			{ cause: error },
		);
	} finally {
		clearTimeout(timer);
		clearTimeout(totalTimer);
		controller.abort();
	}
}

function spawnVersionProbe(path: string): VersionProbe {
	const child = Bun.spawn([path, "--version"], {
		stdin: "ignore",
		stderr: "pipe",
		stdout: "pipe",
	});
	return {
		exited: child.exited,
		kill: () => child.kill("SIGKILL"),
		stderr: child.stderr,
		stdout: child.stdout,
	};
}

/**
 * Run `<binary> --version` with the time and output bounded by this code, not
 * by the process: a probe that is still running at the deadline or that has
 * emitted more than the output limit is killed, and its output is discarded.
 */
async function smokeVersion(
	path: string,
	runtime: UpdateRuntime,
	expected?: string,
): Promise<string> {
	const probe = (runtime.spawnVersionProbe ?? spawnVersionProbe)(path);
	let terminated = false;
	const terminate = () => {
		if (terminated) return;
		terminated = true;
		probe.kill();
	};
	const timer = setTimeout(
		terminate,
		runtime.versionTimeoutMs ?? VERSION_TIMEOUT_MS,
	);
	let received = 0;
	const collect = async (
		stream: ReadableStream<Uint8Array>,
	): Promise<string> => {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > VERSION_OUTPUT_LIMIT_BYTES) terminate();
				else chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return terminated ? "" : Buffer.concat(chunks).toString("utf8");
	};
	let exitCode: number | null;
	let stdout: string;
	try {
		[exitCode, stdout] = await Promise.all([
			probe.exited,
			collect(probe.stdout),
			collect(probe.stderr),
		]);
	} finally {
		clearTimeout(timer);
	}
	const version = stdout.trim();
	if (
		terminated ||
		exitCode !== 0 ||
		received > VERSION_OUTPUT_LIMIT_BYTES ||
		(expected !== undefined && version !== expected)
	) {
		throw new Error(
			expected
				? `Downloaded artifact failed the version smoke test (expected ${expected}; time and output are bounded)`
				: "Previous binary failed its version smoke test (time and output are bounded)",
		);
	}
	parseSemVer(version);
	return version;
}

function durableCopy(source: string, destination: string): void {
	copyFileSync(source, destination);
	chmodSync(destination, 0o755);
	const descriptor = openSync(destination, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Preserve the active binary and replace it with one rename. The command path
 * is never renamed away first, so a crash cannot create an absent-binary gap.
 */
function activateAtomically(target: string, candidate: string): void {
	const previous = `${target}.previous`;
	const previousTemporary = `${previous}.prepare-${process.pid}`;
	rmSync(previousTemporary, { force: true });
	durableCopy(target, previousTemporary);
	renameSync(previousTemporary, previous);
	fsyncDirectory(dirname(target));
	renameSync(candidate, target);
	fsyncDirectory(dirname(target));
}

function releaseAsset(manifest: ReleaseManifest): ReleaseAsset {
	const name = platformAsset(manifest.version);
	const asset = manifest.assets.find((candidate) => candidate.name === name);
	if (!asset)
		throw new Error(`Release manifest has no verified ${name} artifact`);
	return asset;
}

async function installVersion(
	manifest: ReleaseManifest,
	runtime: UpdateRuntime,
	progress: boolean,
): Promise<Record<string, unknown>> {
	requireMutableStandalone(runtime);
	const target = targetPath(runtime);
	const release = acquireInstallLock(target);
	const temporary = `${target}.download-${process.pid}-${Date.now()}`;
	try {
		const asset = releaseAsset(manifest);
		if (progress)
			console.error(
				`Downloading Tedix (${(asset.size / 1024 / 1024).toFixed(1)} MiB)…`,
			);
		await downloadAsset(asset, temporary, runtime, progress);
		if (progress) console.error("Verifying downloaded executable…");
		await smokeVersion(temporary, runtime, manifest.version);
		activateAtomically(target, temporary);
		return {
			changed: true,
			path: target,
			previous: true,
			sourceSha: manifest.sourceSha,
			version: manifest.version,
		};
	} finally {
		rmSync(temporary, { force: true });
		release();
	}
}

export async function runRollbackCommand(
	options: { json: boolean },
	runtime: UpdateRuntime = {},
): Promise<number> {
	requireMutableStandalone(runtime);
	const target = targetPath(runtime);
	const previous = `${target}.previous`;
	const release = acquireInstallLock(target);
	const candidate = `${target}.rollback-${process.pid}-${Date.now()}`;
	try {
		if (!existsSync(previous)) {
			throw new Error("No previous Tedix CLI binary is available");
		}
		if (!options.json) console.error("Checking previous executable…");
		const version = await smokeVersion(previous, runtime);
		durableCopy(previous, candidate);
		activateAtomically(target, candidate);
		const result = { changed: true, path: target, version };
		console.log(
			options.json
				? JSON.stringify(result)
				: `Rolled back Tedix CLI to ${version}`,
		);
		return 0;
	} finally {
		rmSync(candidate, { force: true });
		release();
	}
}

export async function runUpdateCommand(
	options: UpdateCommandOptions,
	runtime: UpdateRuntime = {},
): Promise<number> {
	if (options.check && options.force) {
		throw new Error("--force applies only when installing an update");
	}
	if (!options.check) requireMutableStandalone(runtime);
	if (!options.json) {
		console.error(`Current version: ${CLI_VERSION}`);
		console.error(
			options.version
				? `Checking release ${options.version}…`
				: "Checking for updates to latest version…",
		);
	}
	const resolved = options.version
		? undefined
		: await loadLatest(runtime, options.check);
	const latest = resolved?.latest;
	const version = options.version ?? latest?.version;
	if (!version) throw new Error("No Tedix CLI release version was resolved");
	const manifest = resolved?.manifest ?? (await loadManifest(version, runtime));
	if (latest && manifest.sourceSha !== latest.sourceSha) {
		throw new Error(
			"Latest release metadata and manifest source SHA do not match",
		);
	}
	releaseAsset(manifest);
	const comparison = compareVersions(CLI_VERSION, version);
	if (options.check) {
		const result = {
			ahead: comparison > 0,
			available: true,
			current: CLI_VERSION,
			explicit: options.version !== undefined,
			target: version,
			updateAvailable: comparison < 0,
		};
		console.log(
			options.json
				? JSON.stringify(result)
				: comparison < 0
					? `Tedix ${version} is available. Run \`tedix update${options.version ? ` ${version}` : ""}\` to install it.`
					: comparison > 0
						? `Tedix CLI ${CLI_VERSION} is newer than ${version}`
						: `Tedix is up to date (version ${CLI_VERSION}).`,
		);
		return 0;
	}
	if (!options.force && comparison === 0) {
		const result = { changed: false, current: CLI_VERSION, target: version };
		console.log(
			options.json
				? JSON.stringify(result)
				: `Tedix is up to date (version ${CLI_VERSION}).`,
		);
		return 0;
	}
	if (!options.force && comparison > 0 && options.version === undefined) {
		const result = {
			changed: false,
			current: CLI_VERSION,
			staleLatest: true,
			target: version,
		};
		console.log(
			options.json
				? JSON.stringify(result)
				: `Tedix CLI ${CLI_VERSION} is newer than the published latest alias (${version}); no change made`,
		);
		return 0;
	}
	if (!options.force && comparison > 0) {
		throw new Error(
			`Refusing to downgrade Tedix CLI from ${CLI_VERSION} to ${version} without --force`,
		);
	}
	if (!options.json) {
		console.error(
			comparison === 0
				? `\nReinstalling Tedix ${version} via standalone download…\n`
				: `\nUpdating Tedix from ${CLI_VERSION} to ${version} via standalone download…\n`,
		);
	}
	const result = await installVersion(manifest, runtime, !options.json);
	console.log(
		options.json
			? JSON.stringify(result)
			: `\n🎉 Successfully ${comparison === 0 ? `reinstalled Tedix ${version}` : `updated Tedix from ${CLI_VERSION} to ${version}`}!\nRestart any running Tedix sessions to use the new version.`,
	);
	return 0;
}
