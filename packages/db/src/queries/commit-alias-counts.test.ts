import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { CommitAliasCountLocationSchema } from "@tedix/api-contract/schemas/commit-alias-counts";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { gitCommitAliases } from "../schema/git-commit-aliases";
import {
	workAttempts,
	workItems,
	workItemComments,
} from "../schema/work-items";
import {
	workInteractions,
	workInteractionCardRevisions,
} from "../schema/work-factory";
import { kernelRequests } from "../schema/kernel-requests";
import {
	externalAgentAttributions,
	externalAgentReviewEvidence,
} from "../schema/external-agent-identity";
import { learningInteractionEvents } from "../schema/learning-feedback";
import {
	findStoredOldCommits,
	readCommitAliasCountPage,
} from "./commit-alias-counts";

it("executes every count projection against the real schemas and matches only old aliases in the requested repository", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		for (const table of [
			gitCommitAliases,
			workAttempts,
			workItems,
			workItemComments,
			workInteractions,
			workInteractionCardRevisions,
			kernelRequests,
			externalAgentAttributions,
			externalAgentReviewEvidence,
			learningInteractionEvents,
		])
			sqlite.exec(schemaDdl(table));
		const db = createDbQueryClient(createD1Facade(sqlite));
		for (const location of CommitAliasCountLocationSchema.options)
			expect(await readCommitAliasCountPage(db, location, "")).toEqual([]);
		const insert = sqlite.prepare(
			"INSERT INTO git_commit_aliases(old_sha,new_sha,repository,created_at) VALUES (?,?,?,'2026-01-01T00:00:00Z')",
		);
		insert.run("a".repeat(40), "b".repeat(40), "example/project");
		insert.run("a".repeat(39) + "c", "d".repeat(40), "example/project");
		insert.run("e".repeat(40), "f".repeat(40), "example/other");
		expect(
			await findStoredOldCommits(
				db,
				"example/project",
				["a".repeat(7), "b".repeat(7), "e".repeat(7)],
				true,
			),
		).toEqual([{ sha: "a".repeat(7) }]);
		expect(
			await findStoredOldCommits(db, "example/project", ["a".repeat(7)], false),
		).toEqual([]);
	} finally {
		sqlite.close();
	}
});
