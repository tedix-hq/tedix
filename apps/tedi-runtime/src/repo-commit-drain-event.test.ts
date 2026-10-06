import assert from "node:assert/strict";
import {
	buildRepoCommitDrainedEvent,
	repoCommitChangeSummaryFromRow,
} from "./repo-commit-drain-event";
import type { RepoCommitRow } from "./repo-commit-store";

function row(overrides: Partial<RepoCommitRow> = {}): RepoCommitRow {
	return {
		id: "ledger-1",
		approvalRequestId: "approval-1",
		owner: "tedix-hq",
		repo: "tedix",
		baseRef: "main",
		branch: "pi/proof",
		message: "docs: proof",
		changesJson: JSON.stringify({
			changes: [
				{ path: "docs/a.md", content: "hello" },
				{ path: "docs/remove.md", content: null },
			],
		}),
		openPr: 0,
		prBase: null,
		riskTier: "high",
		status: "committed",
		commitSha: "abc123",
		prUrl: null,
		error: null,
		claimToken: null,
		createdAt: 1,
		updatedAt: 2,
		...overrides,
	};
}

{
	const summary = repoCommitChangeSummaryFromRow(row());
	assert.deepEqual(summary, {
		addedOrModified: ["docs/a.md"],
		deleted: ["docs/remove.md"],
		fileCount: 2,
		totalBytes: 5,
	});
}

{
	const summary = repoCommitChangeSummaryFromRow(
		row({
			changesJson: JSON.stringify({
				changes: [{ path: "docs/utf8.md", content: "€😀" }],
			}),
		}),
	);
	assert.deepEqual(summary, {
		addedOrModified: ["docs/utf8.md"],
		deleted: [],
		fileCount: 1,
		totalBytes: 7,
	});
}

{
	const summary = repoCommitChangeSummaryFromRow(
		row({ changesJson: '{"changes":' }),
	);
	assert.deepEqual(summary, {
		addedOrModified: [],
		deleted: [],
		fileCount: 0,
		totalBytes: 0,
	});
}

{
	const summary = repoCommitChangeSummaryFromRow(
		row({ changesJson: JSON.stringify({ changes: { path: "docs/leak.md" } }) }),
	);
	assert.deepEqual(summary, {
		addedOrModified: [],
		deleted: [],
		fileCount: 0,
		totalBytes: 0,
	});
}

{
	const event = buildRepoCommitDrainedEvent({
		conversationId: "cto:agent:main:main",
		createdAt: "2026-06-28T00:00:00.000Z",
		drainedAt: "2026-06-28T00:00:01.000Z",
		row: row() as RepoCommitRow & { commitSha: string },
		runId: "tedi-1:repo:repo_commit_ledger-1",
		tediId: "tedi-1",
	});
	assert.equal(
		event.id,
		"tedi-1:repo:repo_commit_ledger-1:repo-commit-drained:abc123",
	);
	assert.equal(event.kind, "repo_commit.drained");
	assert.equal(event.payload.commitSha, "abc123");
	assert.equal(event.payload.tool, "repo_commit_drain");
	assert.equal(event.payload.changeSummary.fileCount, 2);
	assert.equal(event.runtime.metadata.source, "repo_commit_drain");
	assert.equal(JSON.stringify(event).includes("hello"), false);
}

{
	const args = {
		conversationId: "cto:agent:main:main",
		createdAt: "2026-06-28T00:00:00.000Z",
		drainedAt: "2026-06-28T00:00:01.000Z",
		row: row() as RepoCommitRow & { commitSha: string },
		runId: "tedi-1:repo:repo_commit_ledger-1",
		tediId: "tedi-1",
	};
	assert.equal(
		buildRepoCommitDrainedEvent(args).id,
		buildRepoCommitDrainedEvent({
			...args,
			createdAt: "2026-06-28T00:05:00.000Z",
			drainedAt: "2026-06-28T00:05:01.000Z",
		}).id,
		"event id is deterministic across repeated drains",
	);
}

{
	const args = {
		conversationId: "cto:agent:main:main",
		createdAt: "2026-06-28T00:00:00.000Z",
		drainedAt: "2026-06-28T00:00:01.000Z",
		row: row() as RepoCommitRow & { commitSha: string },
		runId: "tedi-1:repo:repo_commit_ledger-1",
		tediId: "tedi-1",
	};
	const durableEvidenceById = new Map<string, unknown>();
	for (const event of [
		buildRepoCommitDrainedEvent(args),
		buildRepoCommitDrainedEvent({
			...args,
			createdAt: "2026-06-28T00:05:00.000Z",
			drainedAt: "2026-06-28T00:05:01.000Z",
		}),
	]) {
		durableEvidenceById.set(event.id, event);
	}
	assert.equal(
		durableEvidenceById.size,
		1,
		"repeated repo_commit_drain calls should upsert one durable drained evidence row",
	);
	assert.equal(
		(durableEvidenceById.values().next().value as { id: string }).id,
		"tedi-1:repo:repo_commit_ledger-1:repo-commit-drained:abc123",
	);
}

console.log("repo-commit-drain-event.test.ts OK");
