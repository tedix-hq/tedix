import {
	createTediBodyGenerationCredential,
	hashTediBodyGenerationToken,
	type TediBodyGenerationCredential,
	type TediBodyGenerationStatus,
	type TediBodyKind,
	verifyTediBodyGenerationToken,
} from "@tedix/auth/tedi-identity";
import {
	armRuntimeBodyGeneration,
	type RuntimeBodyGenerationRecord as DbRuntimeBodyGenerationRecord,
	type RuntimeBodyGenerationRow as GenerationRow,
	readRuntimeBodyGeneration,
	terminateRuntimeBodyGeneration,
	touchRuntimeBodyGenerationHeartbeat,
	updateRuntimeBodyGenerationStatus,
} from "@tedix/db/queries/runtime-body-generations";
import {
	workstationExec,
	workstationWriteFile,
	withWorkstationObservationDeadline,
	type WorkstationRuntimeBody,
	type WorkstationRuntimeNamespace,
	type WorkstationExecResult,
} from "../workstation/computer-body";

export const BODY_GENERATION_TOKEN_HEADER = "X-Tedix-Body-Generation-Token";
export const BODY_GENERATION_ID_HEADER = "X-Tedix-Body-Generation-Id";

const DEFAULT_BODY_GENERATION_TTL_MS = 10 * 60 * 1000;
const MAX_GENERATION_CACHE_ENTRIES = 512;
const GENERATION_CACHE_SWEEP_INTERVAL_MS = 60 * 1000;
const generationCache = new Map<string, RuntimeBodyGeneration>();
let lastGenerationCacheSweepMs = 0;

// Deploy ordering: run db:push before Worker deploy so generation enforcement is
// active immediately. Missing generation columns intentionally fall back to
// legacy passthrough so rolling deploys do not 500 before D1 catches up.
export type RuntimeBodyGenerationRecord = DbRuntimeBodyGenerationRecord;

export interface RuntimeBodyGeneration extends Omit<
	TediBodyGenerationCredential,
	"token"
> {
	bodyKind: TediBodyKind;
	externalId: string;
	issuedAt: string;
	status: TediBodyGenerationStatus;
	tediId: string;
	token?: string;
	trackingEnabled: boolean;
}

export interface RuntimeBodyStatus {
	externalId: string;
	generationId: string;
	status: TediBodyGenerationStatus;
	trackingEnabled: boolean;
}

export interface RuntimeBodyLauncher<TBody> {
	arm(options?: { requireToken?: boolean }): Promise<RuntimeBodyGeneration>;
	ensureBody(): Promise<TBody>;
	exec?(
		command: string,
		options?: { cwd?: string; timeout?: number },
	): Promise<unknown>;
	heartbeat(): Promise<RuntimeBodyStatus>;
	status(status?: TediBodyGenerationStatus): Promise<RuntimeBodyStatus>;
	terminateGeneration(reason?: string): Promise<void>;
}

type TediGenerationDb = Pick<D1Database, "prepare">;

function nowIso(now = new Date()): string {
	return now.toISOString();
}

function generationCacheKey(record: RuntimeBodyGenerationRecord): string {
	return `${record.kind}:${record.id}`;
}

function generationExpiresAtMs(generation: RuntimeBodyGeneration): number {
	return new Date(generation.tokenExpiresAt).getTime();
}

function isUnexpired(
	value: string | null | undefined,
	now = new Date(),
): boolean {
	if (!value) return false;
	const expiresAt = new Date(value).getTime();
	return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

function sweepGenerationCache(nowMs = Date.now(), force = false): void {
	if (
		!force &&
		nowMs - lastGenerationCacheSweepMs < GENERATION_CACHE_SWEEP_INTERVAL_MS &&
		generationCache.size <= MAX_GENERATION_CACHE_ENTRIES
	) {
		return;
	}
	lastGenerationCacheSweepMs = nowMs;
	for (const [key, generation] of generationCache) {
		const expiresAt = generationExpiresAtMs(generation);
		if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
			generationCache.delete(key);
		}
	}
	if (generationCache.size <= MAX_GENERATION_CACHE_ENTRIES) return;
	const oldest = [...generationCache.entries()].sort(
		([, a], [, b]) => generationExpiresAtMs(a) - generationExpiresAtMs(b),
	);
	for (const [key] of oldest.slice(
		0,
		generationCache.size - MAX_GENERATION_CACHE_ENTRIES,
	)) {
		generationCache.delete(key);
	}
}

function getCachedGeneration(
	key: string,
	options: { requireToken?: boolean } = {},
): RuntimeBodyGeneration | null {
	sweepGenerationCache();
	const cached = generationCache.get(key);
	if (!cached) return null;
	if (!isUnexpired(cached.tokenExpiresAt)) {
		generationCache.delete(key);
		return null;
	}
	if (options.requireToken && !cached.token) return null;
	return cached;
}

function setCachedGeneration(
	key: string,
	generation: RuntimeBodyGeneration,
): void {
	sweepGenerationCache();
	generationCache.set(key, generation);
	sweepGenerationCache(
		Date.now(),
		generationCache.size > MAX_GENERATION_CACHE_ENTRIES,
	);
}

function isReusableGeneration(
	row: GenerationRow | null,
	now = new Date(),
): row is GenerationRow & {
	bodyGenerationId: string;
	bodyGenerationTokenHash: string;
	bodyGenerationTokenExpiresAt: string;
} {
	return Boolean(
		row?.bodyGenerationId &&
		row.bodyGenerationTokenHash &&
		isUnexpired(row.bodyGenerationTokenExpiresAt, now) &&
		row.bodyGenerationStatus !== "failed" &&
		row.bodyGenerationStatus !== "terminated" &&
		row.bodyGenerationStatus !== "expired",
	);
}

function applyGenerationRow(
	generation: RuntimeBodyGeneration,
	row: GenerationRow & {
		bodyGenerationId: string;
		bodyGenerationTokenHash: string;
		bodyGenerationTokenExpiresAt: string;
	},
): RuntimeBodyGeneration {
	generation.bodyKind = row.bodyGenerationKind ?? generation.bodyKind;
	generation.externalId = row.bodyGenerationExternalId ?? generation.externalId;
	generation.status = row.bodyGenerationStatus ?? generation.status;
	generation.tokenHash = row.bodyGenerationTokenHash;
	generation.tokenExpiresAt = row.bodyGenerationTokenExpiresAt;
	generation.trackingEnabled = true;
	return generation;
}

function isMissingGenerationSchemaError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /no such column|no column named|no such table/i.test(message);
}

async function safeStore<T>(
	operation: () => Promise<T>,
	fallback: T,
): Promise<
	{ ok: true; value: T } | { ok: false; missingSchema: boolean; value: T }
> {
	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		if (isMissingGenerationSchemaError(error)) {
			return { ok: false, missingSchema: true, value: fallback };
		}
		console.warn(
			"[runtime-body] generation store operation failed:",
			error instanceof Error ? error.message : error,
		);
		return { ok: false, missingSchema: false, value: fallback };
	}
}

async function readGenerationRow(
	db: TediGenerationDb,
	record: RuntimeBodyGenerationRecord,
): Promise<GenerationRow | null> {
	return readRuntimeBodyGeneration(db, record);
}

async function armGenerationRecord(
	db: TediGenerationDb,
	record: RuntimeBodyGenerationRecord,
	generation: RuntimeBodyGeneration,
): Promise<boolean> {
	const store = await safeStore(
		() => armRuntimeBodyGeneration(db, record, generation, nowIso()),
		false,
	);
	return store.ok && store.value;
}

async function updateGenerationStatus(
	db: TediGenerationDb,
	record: RuntimeBodyGenerationRecord,
	input: {
		generationId: string;
		status: TediBodyGenerationStatus;
		externalId: string;
	},
): Promise<boolean> {
	const at = nowIso();
	const store = await safeStore(
		() => updateRuntimeBodyGenerationStatus(db, record, { ...input, at }),
		false,
	);
	return store.ok && store.value;
}

async function touchGenerationHeartbeat(
	db: TediGenerationDb,
	record: RuntimeBodyGenerationRecord,
	input: {
		generationId: string;
		externalId: string;
	},
): Promise<boolean> {
	const at = nowIso();
	const store = await safeStore(
		() => touchRuntimeBodyGenerationHeartbeat(db, record, { ...input, at }),
		false,
	);
	return store.ok && store.value;
}

async function clearGenerationRecord(
	db: TediGenerationDb,
	record: RuntimeBodyGenerationRecord,
	input: { generationId: string },
): Promise<void> {
	const at = nowIso();
	await safeStore(async () => {
		await terminateRuntimeBodyGeneration(db, record, {
			generationId: input.generationId,
			at,
		});
		return true;
	}, false);
}

export async function verifyArmedBodyGeneration(
	db: TediGenerationDb,
	input: {
		record?: RuntimeBodyGenerationRecord;
		tediId?: string;
		generationId: string | null | undefined;
		token: string | null | undefined;
		now?: Date;
	},
): Promise<boolean> {
	if (!input.generationId) return false;
	const record =
		input.record ??
		(input.tediId
			? ({ kind: "tedi", id: input.tediId, tediId: input.tediId } as const)
			: null);
	if (!record) return false;
	const store = await safeStore(() => readGenerationRow(db, record), null);
	const row = store.value;
	if (!row || row.bodyGenerationId !== input.generationId) return false;
	return verifyTediBodyGenerationToken({
		expectedHash: row.bodyGenerationTokenHash,
		now: input.now,
		token: input.token,
		tokenExpiresAt: row.bodyGenerationTokenExpiresAt,
	});
}

export function attachBodyGenerationHeaders(
	headers: Headers,
	generation: RuntimeBodyGeneration,
): Headers {
	if (generation.token) {
		headers.set(BODY_GENERATION_ID_HEADER, generation.generationId);
		headers.set(BODY_GENERATION_TOKEN_HEADER, generation.token);
	}
	return headers;
}

export function attachBodyGenerationSecrets<
	T extends { secrets: Record<string, string | undefined> },
>(tediConfig: T, generation: RuntimeBodyGeneration): T {
	if (!generation.token) return tediConfig;
	tediConfig.secrets.TEDIX_BODY_GENERATION_ID = generation.generationId;
	tediConfig.secrets.TEDIX_BODY_GENERATION_TOKEN = generation.token;
	tediConfig.secrets.TEDIX_BODY_GENERATION_EXPIRES_AT =
		generation.tokenExpiresAt;
	return tediConfig;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function readProofCommand(proofEnvPath: string): string {
	const path = shellSingleQuote(proofEnvPath);
	return `set -eu; test -f ${path}; . ${path}; printf '%s\\n%s' "$TEDIX_BODY_GENERATION_ID" "$TEDIX_BODY_GENERATION_TOKEN"`;
}

interface BodyProof {
	generationId: string | null;
	token: string | null;
}

async function readBodyProof(
	sandbox: WorkstationRuntimeBody,
	proofEnvPath: string,
): Promise<BodyProof> {
	const result = await workstationExec(
		sandbox,
		readProofCommand(proofEnvPath),
		{
			timeout: 5_000,
		},
	);
	if (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.signal !== undefined ||
		result.truncated
	)
		return { generationId: null, token: null };
	const [generationId, token] = String(result.stdout ?? "").split(/\r?\n/);
	return {
		generationId: generationId || null,
		token: token || null,
	};
}

interface CloudflareSandboxLauncherOptions {
	bodyKind: "workstation";
	db: TediGenerationDb;
	externalId?: string;
	namespace: WorkstationRuntimeNamespace;
	proofEnvPath: string;
	record: RuntimeBodyGenerationRecord;
	sandboxId?: string;
	tokenTtlMs?: number;
}

abstract class BaseRuntimeBodyLauncher<
	TBody,
> implements RuntimeBodyLauncher<TBody> {
	protected generation: RuntimeBodyGeneration | null = null;

	protected constructor(
		protected readonly params: {
			bodyKind: TediBodyKind;
			db: TediGenerationDb;
			externalId: string;
			record: RuntimeBodyGenerationRecord;
			tokenTtlMs?: number;
		},
	) {}

	protected get cacheKey(): string {
		return generationCacheKey(this.params.record);
	}

	protected async readReusableGeneration(): Promise<RuntimeBodyGeneration | null> {
		const cached = getCachedGeneration(this.cacheKey);
		if (cached) return cached;

		const store = await safeStore(
			() => readGenerationRow(this.params.db, this.params.record),
			null,
		);
		const row = store.value;
		if (!store.ok || !isReusableGeneration(row)) return null;
		return {
			bodyKind: row.bodyGenerationKind ?? this.params.bodyKind,
			externalId: row.bodyGenerationExternalId ?? this.params.externalId,
			generationId: row.bodyGenerationId,
			issuedAt: row.bodyGenerationHeartbeatAt ?? nowIso(),
			status: row.bodyGenerationStatus ?? "armed",
			tediId: this.params.record.tediId,
			tokenHash: row.bodyGenerationTokenHash,
			tokenExpiresAt: row.bodyGenerationTokenExpiresAt,
			trackingEnabled: true,
		};
	}

	protected invalidateGeneration(generation: RuntimeBodyGeneration): void {
		if (this.generation === generation) this.generation = null;
		generationCache.delete(this.cacheKey);
	}

	protected async refreshTrackingFromStore(
		generation: RuntimeBodyGeneration,
	): Promise<RuntimeBodyGeneration | null> {
		const store = await safeStore(
			() => readGenerationRow(this.params.db, this.params.record),
			null,
		);
		if (!store.ok) {
			return generation.trackingEnabled ? null : generation;
		}
		const row = store.value;
		if (
			!isReusableGeneration(row) ||
			row.bodyGenerationId !== generation.generationId ||
			row.bodyGenerationTokenHash !== generation.tokenHash
		) {
			return null;
		}
		return applyGenerationRow(generation, row);
	}

	protected async validateGenerationForReuse(
		generation: RuntimeBodyGeneration,
		options: { requireToken?: boolean },
	): Promise<RuntimeBodyGeneration | null> {
		if (options.requireToken && !generation.token) return null;
		if (!isUnexpired(generation.tokenExpiresAt)) return null;
		if (!options.requireToken) return generation;
		const current = await this.refreshTrackingFromStore(generation);
		if (!current) {
			this.invalidateGeneration(generation);
			return null;
		}
		setCachedGeneration(this.cacheKey, current);
		return current;
	}

	protected async existingGeneration(): Promise<RuntimeBodyGeneration | null> {
		if (this.generation && isUnexpired(this.generation.tokenExpiresAt)) {
			return this.generation;
		}
		const reusable = await this.readReusableGeneration();
		if (reusable) this.generation = reusable;
		return reusable;
	}

	async arm(
		options: { requireToken?: boolean } = {},
	): Promise<RuntimeBodyGeneration> {
		const cached = getCachedGeneration(this.cacheKey, options);
		if (cached && (await this.validateGenerationForReuse(cached, options))) {
			this.generation = cached;
			return cached;
		}
		if (
			this.generation &&
			isUnexpired(this.generation.tokenExpiresAt) &&
			(!options.requireToken || this.generation.token) &&
			(await this.validateGenerationForReuse(this.generation, options))
		) {
			return this.generation;
		}
		if (!options.requireToken) {
			const reusable = await this.readReusableGeneration();
			if (reusable) {
				this.generation = reusable;
				return reusable;
			}
		}

		const issuedAt = nowIso();
		const credential = await createTediBodyGenerationCredential({
			tokenTtlMs: this.params.tokenTtlMs ?? DEFAULT_BODY_GENERATION_TTL_MS,
		});
		const generation: RuntimeBodyGeneration = {
			...credential,
			bodyKind: this.params.bodyKind,
			externalId: this.params.externalId,
			issuedAt,
			status: "armed",
			tediId: this.params.record.tediId,
			trackingEnabled: false,
		};
		generation.trackingEnabled = await armGenerationRecord(
			this.params.db,
			this.params.record,
			generation,
		);
		this.generation = generation;
		setCachedGeneration(this.cacheKey, generation);
		return generation;
	}

	protected async markStatus(
		status: TediBodyGenerationStatus,
	): Promise<RuntimeBodyStatus> {
		const generation = await this.arm();
		const trackingEnabled =
			generation.trackingEnabled &&
			(await updateGenerationStatus(this.params.db, this.params.record, {
				externalId: generation.externalId,
				generationId: generation.generationId,
				status,
			}));
		generation.status = status;
		generation.trackingEnabled = trackingEnabled;
		setCachedGeneration(this.cacheKey, generation);
		return {
			externalId: generation.externalId,
			generationId: generation.generationId,
			status,
			trackingEnabled,
		};
	}

	abstract ensureBody(): Promise<TBody>;

	async heartbeat(): Promise<RuntimeBodyStatus> {
		const generation = await this.existingGeneration();
		if (!generation) {
			return {
				externalId: this.params.externalId,
				generationId: "",
				status: "ready",
				trackingEnabled: false,
			};
		}
		const trackingEnabled =
			generation.trackingEnabled &&
			(await touchGenerationHeartbeat(this.params.db, this.params.record, {
				externalId: generation.externalId,
				generationId: generation.generationId,
			}));
		return {
			externalId: generation.externalId,
			generationId: generation.generationId,
			status: generation.status,
			trackingEnabled,
		};
	}

	async status(
		status: TediBodyGenerationStatus = "ready",
	): Promise<RuntimeBodyStatus> {
		return this.markStatus(status);
	}

	async terminateGeneration(_reason?: string): Promise<void> {
		const generation = await this.arm();
		await clearGenerationRecord(this.params.db, this.params.record, {
			generationId: generation.generationId,
		});
		generationCache.delete(this.cacheKey);
	}
}

export class CloudflareSandboxWorkstationLauncher extends BaseRuntimeBodyLauncher<WorkstationRuntimeBody> {
	private sandbox: WorkstationRuntimeBody | null = null;

	constructor(
		private readonly sandboxParams: CloudflareSandboxLauncherOptions,
	) {
		super({
			bodyKind: sandboxParams.bodyKind,
			db: sandboxParams.db,
			externalId: sandboxParams.externalId ?? sandboxParams.record.id,
			record: sandboxParams.record,
			tokenTtlMs: sandboxParams.tokenTtlMs,
		});
	}

	async ensureBody(): Promise<WorkstationRuntimeBody> {
		if (!this.sandbox) {
			this.sandbox = this.sandboxParams.namespace.getByName(
				this.sandboxParams.sandboxId ?? this.sandboxParams.record.tediId,
			);
		}
		return this.sandbox;
	}

	override async terminateGeneration(reason?: string): Promise<void> {
		await super.terminateGeneration(reason);
		this.sandbox = null;
	}

	async exec(
		command: string,
		options?: { cwd?: string; timeout?: number },
	): Promise<WorkstationExecResult> {
		const sandbox = await this.ensureBody();
		return workstationExec(sandbox, command, options);
	}

	async writeBodyGenerationProof(): Promise<void> {
		const generation = await this.arm({ requireToken: true });
		if (!generation.token) return;
		const sandbox = await this.ensureBody();
		const content = [
			`export TEDIX_BODY_GENERATION_ID=${shellSingleQuote(generation.generationId)}`,
			`export TEDIX_BODY_GENERATION_TOKEN=${shellSingleQuote(generation.token)}`,
		].join("\n");
		const path = shellSingleQuote(this.sandboxParams.proofEnvPath);
		const prepared = await workstationExec(
			sandbox,
			`set -eu; mkdir -p "$(dirname -- ${path})"; umask 077; : > ${path}; chmod 600 ${path}`,
			{ timeout: 5_000 },
		);
		if (
			prepared.exitCode !== 0 ||
			prepared.timedOut ||
			prepared.signal !== undefined ||
			prepared.truncated
		) {
			throw new Error("Unable to prepare runtime body credential file");
		}
		await withWorkstationObservationDeadline(
			() =>
				workstationWriteFile(
					sandbox,
					this.sandboxParams.proofEnvPath,
					`${content}\n`,
				),
			{ timeoutMs: 5_000, operation: "body credential write" },
		);
	}

	async verifyBodyProof(): Promise<boolean> {
		let generation = await this.existingGeneration();
		if (!generation) return true;
		generation = await this.refreshTrackingFromStore(generation);
		if (!generation?.trackingEnabled) return true;
		// Proof is intentionally both body-presented and D1-current; the env file
		// alone is not authority for marking a generation ready.
		const sandbox = await this.ensureBody();
		const proof = await readBodyProof(sandbox, this.sandboxParams.proofEnvPath);
		if (!proof.generationId || !proof.token) return false;
		if (proof.generationId !== generation.generationId) return false;
		if (generation.token && proof.token !== generation.token) return false;
		const proofHash = await hashTediBodyGenerationToken(proof.token);
		if (proofHash !== generation.tokenHash) return false;
		return verifyArmedBodyGeneration(this.params.db, {
			generationId: proof.generationId,
			record: this.params.record,
			token: proof.token,
		});
	}

	override async status(
		status: TediBodyGenerationStatus = "ready",
	): Promise<RuntimeBodyStatus> {
		const generation = await this.existingGeneration();
		if (!generation) {
			return {
				externalId: this.params.externalId,
				generationId: "",
				status,
				trackingEnabled: false,
			};
		}
		if (status === "ready" && !(await this.verifyBodyProof())) {
			await this.markStatus("failed");
			throw new Error("Runtime body generation credential verification failed");
		}
		return this.markStatus(status);
	}
}

interface CloudflareIsolateLauncherOptions {
	db: TediGenerationDb;
	externalId: string;
	fetcher: Fetcher;
	record: RuntimeBodyGenerationRecord;
	tokenTtlMs?: number;
}

export class CloudflareAgentBodyLauncher extends BaseRuntimeBodyLauncher<Fetcher> {
	constructor(
		private readonly isolateParams: CloudflareIsolateLauncherOptions,
	) {
		super({
			bodyKind: "agent",
			db: isolateParams.db,
			externalId: isolateParams.externalId,
			record: isolateParams.record,
			tokenTtlMs: isolateParams.tokenTtlMs,
		});
	}

	async ensureBody(): Promise<Fetcher> {
		return this.isolateParams.fetcher;
	}
}
