import {
	WorkAttemptRepositorySchema,
	type WorkAttemptRepository,
	type WorkAttemptRepositoryReadRequest,
	type WorkAttemptRepositoryReadResult,
	type WorkAttemptRepositoryRequest,
} from "@tedix/api-contract/schemas/work-items";

type RepositoryHandle = Pick<ArtifactsRepo, "info" | "log" | "fork"> &
	Partial<Disposable>;
type RepositoryReadHandle = Pick<
	ArtifactsRepo,
	"info" | "log" | "readTree" | "readFile"
> &
	Partial<Disposable>;
type ArtifactsBinding = Pick<Artifacts, "create" | "get">;

export interface ProvisionWorkAttemptRepositoryParams {
	artifacts: ArtifactsBinding | undefined;
	enabled: boolean;
	request: WorkAttemptRepositoryRequest;
	workItemId: string;
	workItemVersion: number;
	admissionSpecRevision: string;
	admissionId: string;
	attemptId: string;
	observedAt?: string;
}

function repositoryName(params: ProvisionWorkAttemptRepositoryParams): string {
	return `work-${params.workItemId.slice(0, 8)}-${params.attemptId}`.toLowerCase();
}

/**
 * The provenance marker written into a Work Attempt repository's description.
 * Reads verify it again at use time so a persisted name can never reach a
 * repository some other principal renamed or recreated.
 */
export function workAttemptRepositoryDescriptionPrefix(params: {
	workItemId: string;
	attemptId: string;
	admissionId: string;
}): string {
	return `tedix-work:${params.workItemId};attempt:${params.attemptId};admission:${params.admissionId}`;
}

function descriptionPrefix(
	params: ProvisionWorkAttemptRepositoryParams,
): string {
	return workAttemptRepositoryDescriptionPrefix(params);
}

function unavailable(
	params: ProvisionWorkAttemptRepositoryParams,
	reason: string,
): WorkAttemptRepository {
	return WorkAttemptRepositorySchema.parse({
		version: 1,
		provider: "cloudflare_artifacts",
		status: "unavailable",
		mode: params.request.mode,
		repositoryName: repositoryName(params),
		repositoryId: null,
		remote: null,
		defaultBranch: null,
		sourceRepositoryName:
			params.request.mode === "fork"
				? params.request.sourceRepositoryName
				: null,
		sourceRef: params.request.mode === "fork" ? params.request.sourceRef : null,
		baseRevision: null,
		workItemId: params.workItemId,
		workItemVersion: params.workItemVersion,
		admissionSpecRevision: params.admissionSpecRevision,
		admissionId: params.admissionId,
		attemptId: params.attemptId,
		observedAt: params.observedAt ?? new Date().toISOString(),
		reason,
	});
}

function ready(
	params: ProvisionWorkAttemptRepositoryParams,
	repository: {
		id: string;
		name: string;
		remote: string;
		defaultBranch: string;
	},
	baseRevision: string | null,
): WorkAttemptRepository {
	return WorkAttemptRepositorySchema.parse({
		version: 1,
		provider: "cloudflare_artifacts",
		status: "ready",
		mode: params.request.mode,
		repositoryName: repository.name,
		repositoryId: repository.id,
		remote: repository.remote,
		defaultBranch: repository.defaultBranch,
		sourceRepositoryName:
			params.request.mode === "fork"
				? params.request.sourceRepositoryName
				: null,
		sourceRef: params.request.mode === "fork" ? params.request.sourceRef : null,
		baseRevision,
		workItemId: params.workItemId,
		workItemVersion: params.workItemVersion,
		admissionSpecRevision: params.admissionSpecRevision,
		admissionId: params.admissionId,
		attemptId: params.attemptId,
		observedAt: params.observedAt ?? new Date().toISOString(),
		reason: null,
	});
}

function artifactErrorCode(error: unknown): string | null {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: null;
}

function dispose(repository: Partial<Disposable>): void {
	try {
		repository[Symbol.dispose]?.();
	} catch {
		// Releasing an RPC capability must not obscure the repository outcome.
	}
}

async function existingRepository(
	params: ProvisionWorkAttemptRepositoryParams,
	name: string,
): Promise<WorkAttemptRepository | null> {
	if (!params.artifacts) return null;
	let repository: RepositoryHandle;
	try {
		repository = await params.artifacts.get(name);
	} catch (error) {
		if (artifactErrorCode(error) === "NOT_FOUND") return null;
		throw error;
	}
	try {
		const info = await repository.info();
		const prefix = descriptionPrefix(params);
		const forkPrefix =
			params.request.mode === "fork"
				? `${prefix};source:${params.request.sourceRepositoryName};ref:${encodeURIComponent(params.request.sourceRef)};base:`
				: null;
		if (
			(params.request.mode === "create" && info.description !== prefix) ||
			(params.request.mode === "fork" &&
				!info.description?.startsWith(forkPrefix!))
		) {
			return unavailable(
				params,
				"The deterministic repository name is owned by different provenance",
			);
		}
		const baseRevision =
			params.request.mode === "fork"
				? (info.description?.match(/;base:([a-f0-9]{40})$/)?.[1] ?? null)
				: null;
		if (params.request.mode === "fork" && !baseRevision) {
			return unavailable(
				params,
				"The existing fork does not carry an exact base revision",
			);
		}
		return ready(params, info, baseRevision);
	} finally {
		dispose(repository);
	}
}

/**
 * Provision one deterministic, isolated Artifacts repository for an admitted
 * Attempt. The initial write token is deliberately discarded: tokens are
 * short-lived capabilities and never belong in D1, logs, or API responses.
 */
export async function provisionWorkAttemptRepository(
	params: ProvisionWorkAttemptRepositoryParams,
): Promise<WorkAttemptRepository> {
	if (!params.enabled) {
		return unavailable(
			params,
			"Work Attempt Artifacts repositories are disabled",
		);
	}
	if (!params.artifacts) {
		return unavailable(params, "Cloudflare Artifacts binding is unavailable");
	}
	const name = repositoryName(params);
	try {
		const existing = await existingRepository(params, name);
		if (existing) return existing;
		const prefix = descriptionPrefix(params);
		if (params.request.mode === "create") {
			const created = await params.artifacts.create(name, {
				description: prefix,
				readOnly: false,
				setDefaultBranch: "main",
			});
			return ready(params, created, null);
		}

		const source = await params.artifacts.get(
			params.request.sourceRepositoryName,
		);
		try {
			const sourceInfo = await source.info();
			if (
				params.request.sourceRef !== "HEAD" &&
				params.request.sourceRef !== sourceInfo.defaultBranch
			) {
				return unavailable(
					params,
					"Artifacts forks can only preserve the source default branch",
				);
			}
			const [head] = await source.log({
				ref: sourceInfo.defaultBranch,
				limit: 1,
			});
			if (!head) {
				return unavailable(
					params,
					`Source ref ${params.request.sourceRef} does not resolve to a commit`,
				);
			}
			if (
				params.request.expectedBaseRevision &&
				params.request.expectedBaseRevision !== head.hash
			) {
				return unavailable(
					params,
					"Source ref changed before repository provisioning",
				);
			}
			const forked = await source.fork(name, {
				description: `${prefix};source:${params.request.sourceRepositoryName};ref:${encodeURIComponent(params.request.sourceRef)};base:${head.hash}`,
				defaultBranchOnly: true,
				readOnly: false,
			});
			return ready(params, forked, head.hash);
		} finally {
			dispose(source);
		}
	} catch (error) {
		const code = artifactErrorCode(error);
		return unavailable(
			params,
			code
				? `Cloudflare Artifacts rejected repository provisioning (${code})`
				: "Cloudflare Artifacts repository provisioning failed",
		);
	}
}

/** Bounded immutable reads keep a review response inside the oRPC budget. */
const REPOSITORY_READ_FILE_BYTES = 512 * 1024;
const REPOSITORY_READ_TREE_ENTRIES = 500;
const BINARY_SNIFF_BYTES = 8_192;

export class WorkAttemptRepositoryReadError extends Error {
	readonly code: "unavailable" | "not_found";
	constructor(code: "unavailable" | "not_found", message: string) {
		super(message);
		this.name = "WorkAttemptRepositoryReadError";
		this.code = code;
	}
}

export interface ReadWorkAttemptRepositoryParams {
	artifacts: ArtifactsBinding | undefined;
	repository: WorkAttemptRepository;
	request: WorkAttemptRepositoryReadRequest;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

function toCommitResult(commit: ArtifactsCommitMetadata) {
	return {
		hash: commit.hash,
		treeHash: commit.treeHash,
		message: commit.message,
		author: { name: commit.author.name, email: commit.author.email },
		parents: commit.parents,
		committedAt: new Date(commit.committedAt * 1000).toISOString(),
	};
}

async function resolveRevision(
	repo: RepositoryReadHandle,
	ref: string,
): Promise<ArtifactsCommitMetadata | null> {
	const [head] = await repo.log({ ref, limit: 1 });
	return head ?? null;
}

async function readDirectory(
	repo: RepositoryReadHandle,
	treeHash: string,
	segments: string[],
): Promise<ArtifactsTreeEntry[] | null> {
	let current = treeHash;
	for (const segment of segments) {
		const entries = await repo.readTree(current);
		const entry = entries?.find((candidate) => candidate.name === segment);
		if (!entry || entry.type !== "tree") return null;
		current = entry.hash;
	}
	return repo.readTree(current);
}

/**
 * Read commit history, a directory tree, or one file from the immutable
 * Artifacts repository bound to an Attempt. The persisted provenance record
 * is verified against the live repository description before any object is
 * returned, so a caller can only ever reach the repo this Attempt recorded.
 */
export async function readWorkAttemptRepository(
	params: ReadWorkAttemptRepositoryParams,
): Promise<WorkAttemptRepositoryReadResult> {
	const { artifacts, repository, request } = params;
	if (!artifacts) {
		throw new WorkAttemptRepositoryReadError(
			"unavailable",
			"Cloudflare Artifacts binding is unavailable",
		);
	}
	if (repository.status !== "ready" || !repository.repositoryId) {
		throw new WorkAttemptRepositoryReadError(
			"not_found",
			"Attempt has no ready Artifacts repository",
		);
	}
	let repo: RepositoryReadHandle;
	try {
		repo = await artifacts.get(repository.repositoryName);
	} catch (error) {
		const code = artifactErrorCode(error);
		throw new WorkAttemptRepositoryReadError(
			code === "NOT_FOUND" ? "not_found" : "unavailable",
			code === "NOT_FOUND"
				? "The recorded Artifacts repository no longer exists"
				: `Cloudflare Artifacts rejected the repository lookup (${code ?? "unexpected"})`,
		);
	}
	try {
		const info = await repo.info();
		const prefix = workAttemptRepositoryDescriptionPrefix(repository);
		const description =
			repository.mode === "fork"
				? `${prefix};source:${repository.sourceRepositoryName};ref:${encodeURIComponent(repository.sourceRef!)};base:${repository.baseRevision}`
				: prefix;
		if (
			info.id !== repository.repositoryId ||
			info.name !== repository.repositoryName ||
			info.description !== description
		) {
			throw new WorkAttemptRepositoryReadError(
				"not_found",
				"The recorded repository name resolves to different provenance",
			);
		}
		const ref =
			"ref" in request && request.ref ? request.ref : info.defaultBranch;
		const head = await resolveRevision(repo, ref);
		const resolvedRevision = head?.hash ?? null;
		if (request.operation === "log") {
			const commits = head
				? await repo.log({
						ref: head.hash,
						limit: request.limit,
						offset: request.offset,
					})
				: [];
			return {
				operation: "log",
				repository,
				resolvedRevision,
				commits: commits.map(toCommitResult),
			};
		}
		if (request.operation === "tree") {
			const path = request.path ?? "";
			const entries = head
				? await readDirectory(repo, head.treeHash, path ? path.split("/") : [])
				: null;
			return {
				operation: "tree",
				repository,
				resolvedRevision,
				path,
				exists: entries !== null,
				entries: (entries ?? [])
					.slice(0, REPOSITORY_READ_TREE_ENTRIES)
					.map((entry) => ({
						name: entry.name,
						path: path ? `${path}/${entry.name}` : entry.name,
						mode: entry.mode,
						hash: entry.hash,
						type: entry.type,
					})),
				truncated: (entries?.length ?? 0) > REPOSITORY_READ_TREE_ENTRIES,
			};
		}
		const blob = head
			? await repo.readFile({ ref: head.hash, path: request.path })
			: null;
		if (!blob) {
			return {
				operation: "file",
				repository,
				resolvedRevision,
				path: request.path,
				exists: false,
				size: null,
				mediaType: null,
				binary: false,
				dataBase64: null,
				truncated: false,
			};
		}
		const bytes = new Uint8Array(
			await blob.slice(0, REPOSITORY_READ_FILE_BYTES).arrayBuffer(),
		);
		return {
			operation: "file",
			repository,
			resolvedRevision,
			path: request.path,
			exists: true,
			size: blob.size,
			mediaType: blob.type || null,
			binary: bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0),
			dataBase64: bytesToBase64(bytes),
			truncated: blob.size > REPOSITORY_READ_FILE_BYTES,
		};
	} catch (error) {
		if (error instanceof WorkAttemptRepositoryReadError) throw error;
		const code = artifactErrorCode(error);
		throw new WorkAttemptRepositoryReadError(
			"unavailable",
			code
				? `Cloudflare Artifacts rejected the repository read (${code})`
				: "Cloudflare Artifacts repository read failed",
		);
	} finally {
		dispose(repo);
	}
}
