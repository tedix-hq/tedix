import {
	WorkAttemptRepositorySchema,
	WorkAttemptRepositoryLifecycleSchema,
	type WorkRepositoryReviewInput,
	type WorkRepositoryReviewResult,
} from "@tedix/api-contract/schemas/work-items";

type ReviewRepository = Pick<
	ArtifactsRepo,
	"info" | "readCommit" | "readTree" | "readFile" | "log"
> &
	Partial<Disposable>;
const MAX_FILE_BYTES = 262_144;

export class RepositoryReviewUnavailable extends Error {}

async function readText(
	repository: ReviewRepository,
	ref: string | null,
	path: string,
): Promise<NonNullable<WorkRepositoryReviewResult["head"]>> {
	if (!ref) return { status: "missing", text: null, bytes: null };
	const blob = await repository.readFile({ ref, path });
	if (!blob) return { status: "missing", text: null, bytes: null };
	if (blob.size > MAX_FILE_BYTES)
		return { status: "too_large", text: null, bytes: blob.size };
	try {
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(await blob.arrayBuffer());
		if (text.includes("\0"))
			return { status: "binary", text: null, bytes: blob.size };
		return { status: "text", text, bytes: blob.size };
	} catch {
		return { status: "binary", text: null, bytes: blob.size };
	}
}

/** Read only admitted repository provenance and immutable settlement revisions. */
export async function readWorkRepositoryReview(params: {
	artifacts: Pick<Artifacts, "get"> | undefined;
	attempt: {
		id: string;
		workItemId: string;
		admissionId: string | null;
		finishedAt: string | null;
		outcome: string | null;
		metadata: unknown;
	};
	input: WorkRepositoryReviewInput;
}): Promise<WorkRepositoryReviewResult> {
	const { attempt, input } = params;
	const metadata = attempt.metadata as Record<string, unknown> | null;
	const repository = WorkAttemptRepositorySchema.safeParse(
		metadata?.repository,
	);
	const lifecycle = WorkAttemptRepositoryLifecycleSchema.safeParse(
		metadata?.repositoryLifecycle,
	);
	if (
		!params.artifacts ||
		!attempt.finishedAt ||
		!attempt.outcome ||
		!repository.success ||
		!lifecycle.success ||
		repository.data.status !== "ready" ||
		repository.data.workItemId !== input.id ||
		attempt.workItemId !== input.id ||
		repository.data.attemptId !== attempt.id ||
		attempt.id !== input.attemptId ||
		repository.data.admissionId !== attempt.admissionId ||
		lifecycle.data.headRevision !== input.expectedHeadRevision
	) {
		throw new RepositoryReviewUnavailable(
			"An immutable repository result is unavailable for this Attempt",
		);
	}
	const provenance = repository.data;
	const headRevision = lifecycle.data.headRevision;
	const handle: ReviewRepository = await params.artifacts.get(
		provenance.repositoryName,
	);
	try {
		const info = await handle.info();
		const prefix = `tedix-work:${input.id};attempt:${attempt.id};admission:${attempt.admissionId}`;
		const description =
			provenance.mode === "fork"
				? `${prefix};source:${provenance.sourceRepositoryName};ref:${encodeURIComponent(provenance.sourceRef!)};base:${provenance.baseRevision}`
				: prefix;
		if (
			info.id !== provenance.repositoryId ||
			info.name !== provenance.repositoryName ||
			info.description !== description
		) {
			throw new RepositoryReviewUnavailable(
				"Repository provenance no longer matches this Attempt",
			);
		}
		const commit = await handle.readCommit(headRevision);
		if (!commit || commit.hash !== headRevision)
			throw new RepositoryReviewUnavailable(
				"The recorded result commit is unavailable",
			);
		const result: WorkRepositoryReviewResult = {
			workItemId: input.id,
			attemptId: attempt.id,
			baseRevision: provenance.baseRevision,
			headRevision,
			path: input.path,
			operation: input.operation,
			entries: [],
			commits: [],
			nextOffset: null,
			truncated: false,
			base: null,
			head: null,
		};
		if (input.operation === "history") {
			const commits = await handle.log({
				ref: headRevision,
				offset: input.offset,
				limit: 51,
			});
			result.commits = commits
				.slice(0, 50)
				.map(({ hash, message, authoredAt }) => ({
					hash,
					message: message.slice(0, 4_000),
					authoredAt,
				}));
			result.nextOffset =
				commits.length > 50 && input.offset < 10_000 ? input.offset + 50 : null;
			result.truncated = commits.length > 50 && result.nextOffset === null;
			return result;
		}
		if (input.operation === "compare") {
			if (!input.path)
				throw new RepositoryReviewUnavailable("Choose a file to compare");
			[result.base, result.head] = await Promise.all([
				readText(handle, provenance.baseRevision, input.path),
				readText(handle, headRevision, input.path),
			]);
			return result;
		}
		async function directory(
			root: string | null,
		): Promise<ArtifactsTreeEntry[]> {
			if (!root) return [];
			let treeHash = root;
			for (const segment of input.path ? input.path.split("/") : []) {
				const tree = await handle.readTree(treeHash);
				if (!tree)
					throw new RepositoryReviewUnavailable(
						"The recorded tree is unavailable",
					);
				const entry = tree.find(
					(item) => item.name === segment && item.type === "tree",
				);
				if (!entry) return [];
				treeHash = entry.hash;
			}
			const entries = await handle.readTree(treeHash);
			if (!entries)
				throw new RepositoryReviewUnavailable(
					"The recorded tree is unavailable",
				);
			return entries;
		}
		const baseCommit = provenance.baseRevision
			? await handle.readCommit(provenance.baseRevision)
			: null;
		if (provenance.baseRevision && !baseCommit)
			throw new RepositoryReviewUnavailable(
				"The recorded base commit is unavailable",
			);
		const [before, after] = await Promise.all([
			directory(baseCommit?.treeHash ?? null),
			directory(commit.treeHash),
		]);
		const baseEntries = new Map(before.map((entry) => [entry.name, entry]));
		const headEntries = new Map(after.map((entry) => [entry.name, entry]));
		const names = [
			...new Set([...baseEntries.keys(), ...headEntries.keys()]),
		].sort();
		result.entries = names.slice(0, 500).map((name) => {
			const base = baseEntries.get(name),
				head = headEntries.get(name);
			const entry = head ?? base!;
			return {
				name,
				type: entry.type,
				hash: entry.hash,
				change: !base
					? "added"
					: !head
						? "removed"
						: base.hash === head.hash && base.type === head.type
							? "unchanged"
							: "modified",
			};
		});
		result.truncated = names.length > 500;
		return result;
	} finally {
		handle[Symbol.dispose]?.();
	}
}
