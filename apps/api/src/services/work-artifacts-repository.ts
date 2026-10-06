import {
	WorkAttemptRepositorySchema,
	type WorkAttemptRepository,
	type WorkAttemptRepositoryRequest,
} from "@tedix/api-contract/schemas/work-items";

type RepositoryHandle = Pick<ArtifactsRepo, "info" | "log" | "fork"> &
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

function descriptionPrefix(
	params: ProvisionWorkAttemptRepositoryParams,
): string {
	return `tedix-work:${params.workItemId};attempt:${params.attemptId};admission:${params.admissionId}`;
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

function dispose(repository: RepositoryHandle): void {
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

export function readWorkAttemptRepository(
	metadata: unknown,
): WorkAttemptRepository | null {
	const parsed = WorkAttemptRepositorySchema.safeParse(
		typeof metadata === "object" &&
			metadata !== null &&
			"repository" in metadata
			? metadata.repository
			: undefined,
	);
	return parsed.success ? parsed.data : null;
}
