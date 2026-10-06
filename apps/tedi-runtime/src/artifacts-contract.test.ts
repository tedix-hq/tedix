/**
 * Moved from packages/artifacts-core when the single-consumer package was
 * inlined here. This app's test:run executes each src/*.test.ts with plain
 * `bun run`, so assertions use node:assert like the sibling tests.
 */
import assert from "node:assert/strict";
import {
	artifactsRepoDescriptionForTediSlug,
	artifactsRepoNameForTediId,
	dailyLogArtifactPath,
	formatDailyLogEntry,
	isArtifactsErrorCode,
	TEDIX_ARTIFACTS_DEFAULT_BRANCH,
	utcDateSlug,
} from "./artifacts-contract";

// Repo identity and branch stay stable.
assert.equal(TEDIX_ARTIFACTS_DEFAULT_BRANCH, "main");
assert.equal(artifactsRepoNameForTediId("5eed0099-0000"), "5eed0099-0000");
assert.equal(
	artifactsRepoDescriptionForTediSlug("cto"),
	"Tedix operating text state for cto",
);

// Structured and Miniflare-proxied Artifacts errors classify correctly.
assert.equal(isArtifactsErrorCode({ code: "NOT_FOUND" }, "NOT_FOUND"), true);
assert.equal(
	isArtifactsErrorCode(
		new Error("ArtifactsError: Repository not found: repo-1."),
		"NOT_FOUND",
	),
	true,
);
assert.equal(
	isArtifactsErrorCode(
		new Error("ArtifactsError: Repository already exists: repo-1."),
		"ALREADY_EXISTS",
	),
	true,
);
assert.equal(
	isArtifactsErrorCode(new Error("ArtifactsError: Unauthorized"), "NOT_FOUND"),
	false,
);

// Daily-log file contract.
assert.equal(utcDateSlug(Date.UTC(2026, 4, 29, 23, 59, 59)), "2026-05-29");
assert.equal(
	dailyLogArtifactPath("2026-05-29"),
	"workspace/daily/2026-05-29.md",
);
assert.equal(
	formatDailyLogEntry({
		ts: Date.UTC(2026, 4, 29, 12),
		role: "assistant",
		content: "Done.  ",
		turnId: "turn-1",
	}),
	"\n## 2026-05-29T12:00:00.000Z  assistant  `turn-1`\n\nDone.\n\n---\n",
);

console.log("artifacts-contract.test.ts: ok");
