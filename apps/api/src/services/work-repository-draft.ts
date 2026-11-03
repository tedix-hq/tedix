import {
	RepositoryCandidateDescriptorSchema,
	RepositoryCandidateSelectedPathsSchema,
	type RepositoryCandidateDescriptor,
} from "@tedix/api-contract/schemas/repository-candidate";
import {
	WorkAttemptRepositorySchema,
	type WorkAttemptRepository,
} from "@tedix/api-contract/schemas/work-items";
import {
	repositoryCandidateContentDigest,
	repositoryCandidateContentError,
	repositoryCandidateDocKey,
	repositoryCandidateRoomName,
	REPOSITORY_CANDIDATE_MAX_FILE_BYTES,
} from "@tedix/api-contract/utils/repository-candidate";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import { ACTIVE_ATTEMPT_STATES } from "@tedix/db/queries/work-items/factory-state";
import { workAttemptRepositoryDescriptionPrefix } from "./work-artifacts-repository";

export class RepositoryCandidateError extends Error {}

export function liveRepositoryCandidateScope(
	work: WorkItem,
	attempt: WorkAttempt,
	at = new Date().toISOString(),
): WorkAttemptRepository {
	if (
		work.disposition !== "accepted" ||
		work.completedAt ||
		work.cancelledAt ||
		attempt.orgId !== work.orgId ||
		attempt.workItemId !== work.id ||
		!attempt.admissionId ||
		!ACTIVE_ATTEMPT_STATES.some((state) => state === attempt.runtimeState) ||
		!attempt.expiresAt ||
		attempt.expiresAt <= at
	)
		throw new RepositoryCandidateError(
			"Shared repository editing requires an active admitted Attempt",
		);
	const parsed = WorkAttemptRepositorySchema.safeParse(
		attempt.metadata.repository,
	);
	if (
		!parsed.success ||
		parsed.data.status !== "ready" ||
		!parsed.data.repositoryId ||
		parsed.data.workItemId !== work.id ||
		parsed.data.attemptId !== attempt.id ||
		parsed.data.admissionId !== attempt.admissionId
	)
		throw new RepositoryCandidateError(
			"Attempt has no ready Artifacts repository",
		);
	return parsed.data;
}

export function recordedRepositoryCandidate(
	work: WorkItem,
	attempt: WorkAttempt,
): RepositoryCandidateDescriptor {
	const repository = liveRepositoryCandidateScope(work, attempt);
	const parsed = RepositoryCandidateDescriptorSchema.safeParse(
		attempt.metadata.repositoryCandidate,
	);
	if (!parsed.success)
		throw new RepositoryCandidateError(
			"Current executor has not initialized a shared repository candidate",
		);
	const descriptor = parsed.data;
	if (
		descriptor.organizationId !== work.orgId ||
		descriptor.workItemId !== work.id ||
		descriptor.attemptId !== attempt.id ||
		descriptor.admissionId !== attempt.admissionId ||
		descriptor.repositoryId !== repository.repositoryId ||
		descriptor.repositoryName !== repository.repositoryName ||
		descriptor.roomName !== repositoryCandidateRoomName(descriptor) ||
		descriptor.docKey !== repositoryCandidateDocKey(descriptor)
	)
		throw new RepositoryCandidateError(
			"Recorded repository candidate has different provenance",
		);
	return descriptor;
}

/** Read only immutable blobs from the exact current base; no repository write token. */
export async function hydrateRepositoryCandidate(params: {
	artifacts: Pick<Artifacts, "get"> | undefined;
	repository: WorkAttemptRepository;
	baseRevision: string;
	paths: string[];
}): Promise<{
	files: Record<string, string>;
	selected: RepositoryCandidateDescriptor["files"];
}> {
	if (!RepositoryCandidateSelectedPathsSchema.safeParse(params.paths).success)
		throw new RepositoryCandidateError(
			"Selected file paths exceed the shared editing limits",
		);
	if (!params.artifacts)
		throw new RepositoryCandidateError(
			"Cloudflare Artifacts binding is unavailable",
		);
	const repo = await params.artifacts.get(params.repository.repositoryName);
	try {
		const info = await repo.info();
		const prefix = workAttemptRepositoryDescriptionPrefix(params.repository);
		const description =
			params.repository.mode === "fork"
				? `${prefix};source:${params.repository.sourceRepositoryName};ref:${encodeURIComponent(params.repository.sourceRef!)};base:${params.repository.baseRevision}`
				: prefix;
		if (
			info.id !== params.repository.repositoryId ||
			info.name !== params.repository.repositoryName ||
			info.description !== description
		)
			throw new RepositoryCandidateError(
				"The recorded repository resolves to different provenance",
			);
		const [head] = await repo.log({ ref: info.defaultBranch, limit: 1 });
		if (!head || head.hash !== params.baseRevision)
			throw new RepositoryCandidateError(
				"Repository head changed; the candidate base is stale",
			);
		const trees = new Map<string, ArtifactsTreeEntry[]>();
		async function readTree(hash: string) {
			const cached = trees.get(hash);
			if (cached) return cached;
			if (!/^[a-f0-9]{40}$/.test(hash) || trees.size >= 64)
				throw new RepositoryCandidateError(
					"Selected files exceed the bounded repository tree reads",
				);
			const entries = await repo.readTree(hash);
			if (
				!entries ||
				entries.length > 1024 ||
				entries.some(
					(entry) =>
						entry.name.length > 255 || !/^[a-f0-9]{40}$/.test(entry.hash),
				)
			)
				throw new RepositoryCandidateError(
					"Selected repository tree is missing or exceeds the shared editing limits",
				);
			trees.set(hash, entries);
			return entries;
		}
		const files: Record<string, string> = Object.create(null);
		const selected: RepositoryCandidateDescriptor["files"] = [];
		for (const path of [...params.paths].sort()) {
			let tree = head.treeHash;
			const parts = path.split("/");
			let entry: ArtifactsTreeEntry | undefined;
			for (let index = 0; index < parts.length; index++) {
				entry = (await readTree(tree)).find(
					(candidate) => candidate.name === parts[index],
				);
				if (!entry || (index < parts.length - 1 && entry.type !== "tree"))
					throw new RepositoryCandidateError(
						"Selected file does not exist at the pinned base",
					);
				tree = entry.hash;
			}
			if (
				!entry ||
				!["blob", "exec"].includes(entry.type) ||
				!["100644", "100755"].includes(entry.mode)
			)
				throw new RepositoryCandidateError(
					"Only existing regular text files can be shared",
				);
			const blob = await repo.readBlob(entry.hash);
			if (!blob || blob.size > REPOSITORY_CANDIDATE_MAX_FILE_BYTES)
				throw new RepositoryCandidateError(
					"Selected file is missing or exceeds the shared editing limit",
				);
			let text: string;
			try {
				text = new TextDecoder("utf-8", {
					fatal: true,
					ignoreBOM: true,
				}).decode(await blob.arrayBuffer());
			} catch {
				throw new RepositoryCandidateError(
					"Selected file is not valid UTF-8 text",
				);
			}
			files[path] = text;
			selected.push({ path, blobRevision: entry.hash, bytes: blob.size });
		}
		const contentError = repositoryCandidateContentError(files, params.paths);
		if (contentError) throw new RepositoryCandidateError(contentError);
		return { files, selected };
	} finally {
		repo[Symbol.dispose]();
	}
}

export async function repositoryCandidateDescriptor(params: {
	work: WorkItem;
	attempt: WorkAttempt;
	baseRevision: string;
	selected: RepositoryCandidateDescriptor["files"];
}): Promise<RepositoryCandidateDescriptor> {
	const repository = liveRepositoryCandidateScope(params.work, params.attempt);
	const scope = {
		organizationId: params.work.orgId,
		workItemId: params.work.id,
		attemptId: params.attempt.id,
		admissionId: params.attempt.admissionId!,
		baseRevision: params.baseRevision,
		selectionDigest: await repositoryCandidateContentDigest(
			Object.fromEntries(
				params.selected.map((file) => [file.path, file.blobRevision]),
			),
		),
	};
	return RepositoryCandidateDescriptorSchema.parse({
		version: 1,
		...scope,
		repositoryId: repository.repositoryId,
		repositoryName: repository.repositoryName,
		files: params.selected,
		roomName: repositoryCandidateRoomName(scope),
		docKey: repositoryCandidateDocKey(scope),
		createdAt: new Date().toISOString(),
	});
}
