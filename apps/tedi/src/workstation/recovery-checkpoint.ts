import {
	WorkstationDispatchUnknownError,
	withWorkstationObservationDeadline,
} from "./computer-body";

const RECOVERY_CHECKPOINT_VERSION = 1;
const COMMAND_TIMEOUT_MS = 10_000;
// Preserve the command budget plus the former 15-second transport grace.
const OBSERVATION_TIMEOUT_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const HASH = /^[a-f0-9]{64}$/;

export type CheckpointExecResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

export type LockedCheckpointNative = {
	exec(
		command: string,
		options?: { timeout?: number },
	): Promise<CheckpointExecResult>;
	writeFile(path: string, content: string): Promise<void>;
};

/** exec owns the native checkout lock for its complete finite transaction and
 * revalidates authority after acquisition. writeFile only stages unique scratch
 * inputs outside the checkout; it never grants authority to modify repository files. */
export type WithLockedCheckpoint = <T>(
	operation: (native: LockedCheckpointNative) => Promise<T>,
) => Promise<T>;

export type RecoveryCheckpointProvenance = {
	taskId: string;
	workstationId: string;
	leaseId: string;
	containerPlacementId: string;
};

type CheckpointStorage = {
	get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
	put(
		key: string,
		value: string,
		options?: {
			httpMetadata?: { contentType?: string };
			onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
		},
	): Promise<{ etag: string } | null>;
};

type BundleDescriptor = {
	key: string;
	bytes: number;
	sha256: string;
	prerequisite: string;
};
type RecoveryCheckpointManifest = {
	version: typeof RECOVERY_CHECKPOINT_VERSION;
	baseCommit: string;
	bytes: number;
	createdAt: string;
	patchKey: string;
	patchEncoding?: "base64";
	reason: string;
	workdir: string;
	provenance?: RecoveryCheckpointProvenance;
	preparedStartSha?: string;
	bundle?: BundleDescriptor;
	clean?: true;
};

export type WorkstationRecoveryCheckpointResult = {
	baseCommit?: string;
	bytes?: number;
	error?: string;
	executionId?: string;
	observation?: "unknown";
	patchKey?: string;
	bundleKey?: string;
	provenance?: RecoveryCheckpointProvenance;
	preparedStartSha?: string;
	status:
		| "already_restored"
		| "clean"
		| "failed"
		| "missing"
		| "persisted"
		| "restored"
		| "unavailable";
};

type CheckpointInput = {
	manifestKey: string;
	storage: CheckpointStorage | null;
	workdir: string;
	preparedStartSha: string;
	provenance: RecoveryCheckpointProvenance;
	withLockedCheckpoint: WithLockedCheckpoint;
};

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function fail(error: unknown): WorkstationRecoveryCheckpointResult {
	return {
		status: "failed",
		...(error instanceof WorkstationDispatchUnknownError
			? { executionId: error.executionId, observation: "unknown" as const }
			: {}),
		error: error instanceof Error ? error.message : String(error),
	};
}
function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}
async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
function validProvenance(value: RecoveryCheckpointProvenance): boolean {
	return (
		!!value &&
		[
			value.taskId,
			value.workstationId,
			value.leaseId,
			value.containerPlacementId,
		].every(
			(part) =>
				typeof part === "string" && part.length > 0 && part.length <= 256,
		)
	);
}
function validateInput(input: CheckpointInput): void {
	if (
		!COMMIT.test(input.preparedStartSha) ||
		!validProvenance(input.provenance) ||
		!input.workdir.startsWith("/")
	) {
		throw new Error("invalid checkpoint repository identity");
	}
}
function parseManifest(text: string): RecoveryCheckpointManifest {
	if (byteLength(text) > 16_384)
		throw new Error("recovery manifest is oversized");
	const value = JSON.parse(text) as RecoveryCheckpointManifest;
	if (
		!value ||
		value.version !== RECOVERY_CHECKPOINT_VERSION ||
		!COMMIT.test(value.baseCommit) ||
		!Number.isSafeInteger(value.bytes) ||
		value.bytes < 0 ||
		value.bytes > MAX_BYTES ||
		typeof value.createdAt !== "string" ||
		typeof value.reason !== "string" ||
		typeof value.workdir !== "string" ||
		(value.patchEncoding !== undefined && value.patchEncoding !== "base64") ||
		typeof value.patchKey !== "string" ||
		!/[a-f0-9]{64}\.patch$/.test(value.patchKey) ||
		(value.provenance !== undefined && !validProvenance(value.provenance)) ||
		(value.preparedStartSha !== undefined &&
			!COMMIT.test(value.preparedStartSha)) ||
		(value.clean !== undefined && value.clean !== true)
	)
		throw new Error("invalid recovery checkpoint manifest");
	if (
		value.bundle !== undefined &&
		(!value.bundle ||
			!value.provenance ||
			!value.preparedStartSha ||
			value.bundle.prerequisite !== value.preparedStartSha ||
			!HASH.test(value.bundle.sha256) ||
			typeof value.bundle.key !== "string" ||
			!value.bundle.key.endsWith(`/${value.bundle.sha256}.bundle`) ||
			!COMMIT.test(value.bundle.prerequisite) ||
			!Number.isSafeInteger(value.bundle.bytes) ||
			value.bundle.bytes <= 0 ||
			value.bundle.bytes + value.bytes > MAX_BYTES)
	) {
		throw new Error("invalid recovery bundle descriptor");
	}
	if (
		value.clean &&
		(value.bytes !== 0 ||
			value.bundle ||
			!value.provenance ||
			value.baseCommit !== value.preparedStartSha)
	)
		throw new Error("invalid clean checkpoint");
	return value;
}
async function exec(
	native: LockedCheckpointNative,
	command: string,
): Promise<string> {
	const result = await native.exec(`bash -c ${quote(command)}`, {
		timeout: COMMAND_TIMEOUT_MS,
	});
	if (result.exitCode !== 0)
		throw new Error(
			result.stderr || `checkpoint command exited ${result.exitCode}`,
		);
	return result.stdout;
}

// One native invocation observes HEAD, objects and the dirty patch under the caller's
// writer lock. Bound files before emitting their encoded contents over transport.
function captureCommand(preparedStartSha: string): string {
	return [
		"set -euo pipefail",
		"head=$(git rev-parse --verify HEAD)",
		`git merge-base --is-ancestor ${quote(preparedStartSha)} "$head" || { echo 'prepared start is not an available ancestor of HEAD' >&2; exit 1; }`,
		'tmp=$(mktemp -d "$(git rev-parse --absolute-git-dir)/tedix-capture.XXXXXX")',
		`trap 'rm -f "$tmp/patch" "$tmp/bundle"; rmdir "$tmp"' EXIT`,
		': > "$tmp/bundle"',
		`if [ "$head" != ${quote(preparedStartSha)} ]; then rm "$tmp/bundle"; git bundle create "$tmp/bundle" HEAD ^${quote(preparedStartSha)}; fi`,
		'git diff --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --binary --full-index HEAD > "$tmp/patch"',
		'while IFS= read -r -d "" path; do code=0; git diff --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --binary --no-index -- /dev/null "$path" >> "$tmp/patch" || code=$?; if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then exit "$code"; fi; done < <(git ls-files --others --exclude-standard -z)',
		`bytes=$(( $(wc -c < "$tmp/patch") + $(wc -c < "$tmp/bundle") )); [ "$bytes" -le ${MAX_BYTES} ] || { echo 'recovery checkpoint exceeds ${MAX_BYTES} bytes' >&2; exit 1; }`,
		`if [ ! -s "$tmp/patch" ] && [ -n "$(git status --porcelain=v1)" ]; then echo 'dirty repository produced no recoverable patch' >&2; exit 1; fi`,
		'printf "%s\\n" "$head"; base64 < "$tmp/bundle" | tr -d "\\r\\n"; printf "\\n"; base64 < "$tmp/patch" | tr -d "\\r\\n"; printf "\\n"',
	].join("\n");
}

function decode(value: string): string {
	if (
		value.length > Math.ceil(MAX_BYTES / 3) * 4 ||
		/[^A-Za-z0-9+/=]/.test(value)
	) {
		throw new Error("invalid or oversized checkpoint transport payload");
	}
	const decoded = atob(value);
	if (decoded.length > MAX_BYTES)
		throw new Error("oversized checkpoint transport payload");
	return decoded;
}
function encodeText(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 8192)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
	return btoa(binary);
}

async function putPayload(
	storage: CheckpointStorage,
	key: string,
	value: string,
	contentType: string,
): Promise<void> {
	const written = await storage.put(key, value, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: { contentType },
	});
	if (!written) {
		const existing = await storage.get(key);
		if (!existing || (await existing.text()) !== value)
			throw new Error(
				"existing immutable checkpoint payload failed integrity check",
			);
	}
}

/** Durably acknowledge captured Git-visible state; callers must retain the body
 * on failure and must never replay the original mutation to obtain a checkpoint. */
export async function persistWorkstationRecoveryCheckpoint(
	input: CheckpointInput & {
		patchPrefix: string;
		reason: string;
	},
): Promise<WorkstationRecoveryCheckpointResult> {
	if (!input.storage) return { status: "unavailable" };
	try {
		validateInput(input);
		const previous = await input.storage.get(input.manifestKey);
		if (previous) parseManifest(await previous.text());
		const captured = await input.withLockedCheckpoint((native) =>
			exec(native, captureCommand(input.preparedStartSha)),
		);
		const [baseCommit, bundleBase64, patchBase64, extra] = captured.split("\n");
		if (
			!baseCommit ||
			!COMMIT.test(baseCommit) ||
			bundleBase64 === undefined ||
			patchBase64 === undefined ||
			extra !== "" ||
			captured.split("\n").length !== 4
		) {
			throw new Error("invalid checkpoint capture envelope");
		}
		const bundleBytes = decode(bundleBase64).length;
		const patch = patchBase64;
		const bytes = decode(patchBase64).length;
		if (
			bytes + bundleBytes > MAX_BYTES ||
			(baseCommit !== input.preparedStartSha && !bundleBytes)
		)
			throw new Error("invalid or oversized checkpoint capture");
		const patchKey = `${input.patchPrefix}/${await sha256(patch)}.patch`;
		const bundleHash = bundleBytes ? await sha256(bundleBase64) : undefined;
		const bundle: BundleDescriptor | undefined = bundleHash
			? {
					key: `${input.patchPrefix}/${bundleHash}.bundle`,
					bytes: bundleBytes,
					sha256: bundleHash,
					prerequisite: input.preparedStartSha,
				}
			: undefined;
		const manifest: RecoveryCheckpointManifest = {
			version: RECOVERY_CHECKPOINT_VERSION,
			baseCommit,
			bytes,
			createdAt: new Date().toISOString(),
			patchKey,
			patchEncoding: "base64",
			reason: input.reason,
			workdir: input.workdir,
			provenance: input.provenance,
			preparedStartSha: input.preparedStartSha,
			...(bundle ? { bundle } : {}),
			...(bytes === 0 && !bundle ? { clean: true as const } : {}),
		};
		// Hash-addressed payloads are immutable. Never remove a previous reader's data.
		await putPayload(
			input.storage,
			patchKey,
			patch,
			"text/plain; charset=utf-8",
		);
		if (bundle)
			await putPayload(input.storage, bundle.key, bundleBase64, "text/plain");
		const published = await input.storage.put(
			input.manifestKey,
			`${JSON.stringify(manifest)}\n`,
			{
				onlyIf: previous
					? { etagMatches: previous.etag }
					: { etagDoesNotMatch: "*" },
				httpMetadata: { contentType: "application/json" },
			},
		);
		if (!published)
			throw new Error(
				"recovery checkpoint publication conflict; captured state was not made active",
			);
		return {
			baseCommit,
			bytes,
			patchKey,
			...(bundle ? { bundleKey: bundle.key } : {}),
			provenance: input.provenance,
			preparedStartSha: input.preparedStartSha,
			status: manifest.clean ? "clean" : "persisted",
		};
	} catch (error) {
		return fail(error);
	}
}

/** Restore commits plus dirty bytes into a clean, compatible prepared repository.
 * Temporary payloads, preflight and application share the caller's writer lock. */
export async function restoreWorkstationRecoveryCheckpoint(
	input: CheckpointInput,
): Promise<WorkstationRecoveryCheckpointResult> {
	if (!input.storage) return { status: "unavailable" };
	try {
		validateInput(input);
		const object = await input.storage.get(input.manifestKey);
		if (!object) return { status: "missing" };
		const manifest = parseManifest(await object.text());
		if (
			manifest.workdir !== input.workdir ||
			(manifest.provenance &&
				manifest.provenance.taskId !== input.provenance.taskId)
		) {
			throw new Error("recovery checkpoint repository/task identity mismatch");
		}
		const patchObject = await input.storage.get(manifest.patchKey);
		if (!patchObject) throw new Error("recovery patch is missing");
		const patch = await patchObject.text();
		if (
			(manifest.patchEncoding === "base64"
				? decode(patch).length
				: byteLength(patch)) !== manifest.bytes ||
			!manifest.patchKey.endsWith(`/${await sha256(patch)}.patch`)
		)
			throw new Error("recovery patch integrity check failed");
		let bundleBase64 = "";
		if (manifest.bundle) {
			const object = await input.storage.get(manifest.bundle.key);
			if (!object) throw new Error("recovery bundle is missing");
			bundleBase64 = await object.text();
			if (
				decode(bundleBase64).length !== manifest.bundle.bytes ||
				(await sha256(bundleBase64)) !== manifest.bundle.sha256
			)
				throw new Error("recovery bundle integrity check failed");
		}
		const receipt = {
			baseCommit: manifest.baseCommit,
			bytes: manifest.bytes,
			patchKey: manifest.patchKey,
			...(manifest.bundle ? { bundleKey: manifest.bundle.key } : {}),
			provenance: manifest.provenance,
			preparedStartSha: manifest.preparedStartSha,
		};
		if (manifest.clean)
			return await input.withLockedCheckpoint(async () => ({
				...receipt,
				status: "clean" as const,
			}));
		const markerName = `tedix-recovery-${await sha256(`${manifest.baseCommit}:${manifest.patchKey}`)}`;
		const state = await input.withLockedCheckpoint(async (native) => {
			// Payload staging is outside the checkout; the one restore process owns
			// all protected changes and deletes its own input only after it settles.
			const directory = `/tmp/tedix-restore-${crypto.randomUUID()}`;
			const patchPath = `${directory}.patch`;
			const bundlePath = `${directory}.bundle`;
			let restoredState: string | undefined;
			let operationError: unknown;

			try {
				await withWorkstationObservationDeadline(
					() =>
						native.writeFile(
							`${patchPath}.base64`,
							manifest.patchEncoding === "base64" ? patch : encodeText(patch),
						),
					{
						timeoutMs: OBSERVATION_TIMEOUT_MS,
						operation: "recovery checkpoint write",
					},
				);
				if (manifest.bundle)
					await withWorkstationObservationDeadline(
						() => native.writeFile(`${bundlePath}.base64`, bundleBase64),
						{
							timeoutMs: OBSERVATION_TIMEOUT_MS,
							operation: "recovery checkpoint write",
						},
					);
				restoredState = (
					await exec(
						native,
						[
							"set -euo pipefail",
							`trap ${quote(`status=$?; if ! rm -f -- ${[patchPath, `${patchPath}.base64`, bundlePath, `${bundlePath}.base64`, `${directory}.index`, `${directory}.combined.patch`].map(quote).join(" ")}; then echo "recovery cleanup failed" >&2; exit 1; fi; exit "$status"`)} EXIT`,
							`base64 -d < ${quote(`${patchPath}.base64`)} > ${quote(patchPath)}`,
							`marker="$(git rev-parse --absolute-git-dir)/${markerName}"`,
							...(manifest.bundle
								? [
										`base64 -d < ${quote(`${bundlePath}.base64`)} > ${quote(bundlePath)}`,
										`git cat-file -e ${quote(`${manifest.bundle.prerequisite}^{commit}`)}`,
										`git bundle verify ${quote(bundlePath)} >&2`,
										`git -c core.hooksPath=/dev/null fetch --no-write-fetch-head ${quote(bundlePath)} HEAD >&2`,
									]
								: []),
							`git cat-file -e ${quote(`${manifest.baseCommit}^{commit}`)}`,
							`git merge-base --is-ancestor ${quote(input.preparedStartSha)} ${quote(manifest.baseCommit)} || { echo 'recovery HEAD is incompatible with prepared start' >&2; exit 1; }`,
							'if [ -f "$marker" ]; then echo already_restored; exit 0; fi',
							`head=$(git rev-parse HEAD); [ "$head" = ${quote(input.preparedStartSha)} ] || [ "$head" = ${quote(manifest.baseCommit)} ] || { echo 'refusing to replace unrelated HEAD' >&2; exit 1; }`,
							`if [ -n "$(git status --porcelain=v1)" ]; then echo 'refusing to apply a recovery checkpoint over unrelated dirty work' >&2; exit 1; fi`,
							`export GIT_INDEX_FILE=${quote(`${directory}.index`)}; git read-tree ${quote(manifest.baseCommit)}`,
							...(manifest.bytes
								? [
										`git apply --cached --binary --whitespace=nowarn ${quote(patchPath)}`,
									]
								: []),
							`git diff --cached --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ --binary --full-index HEAD > ${quote(`${directory}.combined.patch`)}`,
							"unset GIT_INDEX_FILE",
							`if [ -s ${quote(`${directory}.combined.patch`)} ]; then git apply --check --binary ${quote(`${directory}.combined.patch`)}; fi`,
							`git -c core.hooksPath=/dev/null checkout --detach --no-overwrite-ignore ${quote(manifest.baseCommit)} >&2`,
							...(manifest.bytes
								? [`git apply --binary --whitespace=nowarn ${quote(patchPath)}`]
								: []),
							'touch "$marker"; echo restored',
						].join("\n"),
					)
				).trim();
			} catch (error) {
				operationError = error ?? new Error("checkpoint restore failed");
			}
			if (operationError) throw operationError;
			return restoredState;
		});
		if (state !== "restored" && state !== "already_restored")
			throw new Error("invalid recovery restore receipt");
		return { ...receipt, status: state };
	} catch (error) {
		return fail(error);
	}
}
