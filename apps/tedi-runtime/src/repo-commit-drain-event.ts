import type { RepoCommitRow } from "./repo-commit-store";

export type RepoCommitDrainedEvent = {
	id: string;
	tediId: string;
	kind: "repo_commit.drained";
	conversationId: string;
	runId: string;
	approvalRequestId?: string;
	payload: {
		tool: "repo_commit_drain";
		ledgerId: string;
		approvalRequestId: string | null;
		owner: string;
		repo: string;
		baseRef: string;
		branch: string;
		commitSha: string;
		prUrl: string | null;
		commitMessage: string;
		openPr: boolean;
		prBase: string | null;
		changeSummary: RepoCommitChangeSummary;
		drainedAt: string;
	};
	runtime: {
		backend: "cloudflare-agents";
		externalId: string;
		metadata: {
			source: "repo_commit_drain";
			approvalRequestId: string | null;
			commitSha: string;
		};
	};
	createdAt: string;
};

export type RepoCommitChangeSummary = {
	addedOrModified: string[];
	deleted: string[];
	fileCount: number;
	totalBytes: number;
};

export function repoCommitChangeSummaryFromRow(
	row: Pick<RepoCommitRow, "changesJson">,
): RepoCommitChangeSummary {
	try {
		const parsed = JSON.parse(row.changesJson) as {
			changes?: Array<{ content?: string | null; path?: string }>;
		};
		const changes = Array.isArray(parsed.changes) ? parsed.changes : [];
		let totalBytes = 0;
		const addedOrModified: string[] = [];
		const deleted: string[] = [];
		for (const change of changes) {
			if (typeof change.path !== "string") continue;
			if (change.content === null) {
				deleted.push(change.path);
				continue;
			}
			addedOrModified.push(change.path);
			if (typeof change.content === "string") {
				totalBytes += new TextEncoder().encode(change.content).byteLength;
			}
		}
		return {
			addedOrModified: addedOrModified.slice(0, 40),
			deleted: deleted.slice(0, 40),
			fileCount: changes.length,
			totalBytes,
		};
	} catch {
		return { addedOrModified: [], deleted: [], fileCount: 0, totalBytes: 0 };
	}
}

export function buildRepoCommitDrainedEvent(input: {
	conversationId: string;
	createdAt: string;
	drainedAt: string;
	row: RepoCommitRow & { commitSha: string };
	runId: string;
	tediId: string;
}): RepoCommitDrainedEvent {
	const { row } = input;
	const eventId = `${input.runId}:repo-commit-drained:${row.commitSha}`;
	return {
		id: eventId,
		tediId: input.tediId,
		kind: "repo_commit.drained",
		conversationId: input.conversationId,
		runId: input.runId,
		...(row.approvalRequestId
			? { approvalRequestId: row.approvalRequestId }
			: {}),
		payload: {
			tool: "repo_commit_drain",
			ledgerId: row.id,
			approvalRequestId: row.approvalRequestId,
			owner: row.owner,
			repo: row.repo,
			baseRef: row.baseRef,
			branch: row.branch,
			commitSha: row.commitSha,
			prUrl: row.prUrl,
			commitMessage: row.message,
			openPr: row.openPr === 1,
			prBase: row.prBase,
			changeSummary: repoCommitChangeSummaryFromRow(row),
			drainedAt: input.drainedAt,
		},
		runtime: {
			backend: "cloudflare-agents",
			externalId: row.id,
			metadata: {
				source: "repo_commit_drain",
				approvalRequestId: row.approvalRequestId,
				commitSha: row.commitSha,
			},
		},
		createdAt: input.createdAt,
	};
}
