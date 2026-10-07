/**
 * `getSessionLessons`: approved lessons of the caller's organization only,
 * filtered to the session's repo and harness, ranked, and trimmed to budget.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { normalizeRepo, selectSessionLessons } from "./agent-session-lessons";
import { agentTurnTriageContractRouter } from "./agent-turn-triage";

const ORG_1 = "00000000-0000-4000-8000-000000000001";
const ORG_2 = "00000000-0000-4000-8000-000000000002";

const row = (
	id: string,
	content: string,
	scope: Record<string, string> | null = null,
	confidence = 0.8,
) => ({
	id,
	content,
	priority: "active" as const,
	confidence,
	metadata: (scope ? { learningFeed: { version: 1, scope } } : null) as never,
	updatedAt: "2026-10-07T00:00:00Z",
});

describe("selectSessionLessons", () => {
	it("keeps general and matching lessons, ranks repo and topic matches first", () => {
		const result = selectSessionLessons(
			[
				row("general-00", "Report the actual cause of a failure."),
				row("tedix-repo", "Edit the ops overlay with a wrangler binding.", {
					repo: "tedix",
					harness: "general",
					topic: "general",
				}),
				row("other-repo", "Other product only.", {
					repo: "example-app",
					harness: "general",
					topic: "general",
				}),
				row("codex-only", "Codex sandbox rule.", {
					repo: "general",
					harness: "codex",
					topic: "general",
				}),
				row("claude-001", "Claude hook rule.", {
					repo: "general",
					harness: "claude-code",
					topic: "general",
				}),
				row("deploy-top", "Gate lesson.", {
					repo: "general",
					harness: "general",
					topic: "deploy",
				}),
			],
			{
				harness: "claude-code",
				repo: "git@github.com:Tedix-HQ/tedix.git",
				topics: ["deploy"],
				budgetBytes: 3200,
			},
		);
		expect(result.lessons.map((lesson) => lesson.id)).toEqual([
			"tedix-repo",
			"claude-001",
			"deploy-top",
			"general-00",
		]);
		expect(result.lessons[0]).toMatchObject({
			shortId: "tedix-re",
			scope: { repo: "tedix", harness: "general", topic: "general" },
		});
		expect(result.lessons[3]!.scope).toEqual({
			repo: "general",
			harness: "general",
			topic: "general",
		});
		expect(result).toMatchObject({ matched: 4, truncated: false });
	});

	it("drops repo-scoped lessons when the session has no repo, and trims to budget", () => {
		const lessons = Array.from({ length: 10 }, (_, n) =>
			row(`lesson-${n}`, "x".repeat(300), null, 1 - n / 100),
		);
		lessons.push(
			row("repo-only", "scoped", {
				repo: "tedix",
				harness: "general",
				topic: "general",
			}),
		);
		const result = selectSessionLessons(lessons, {
			harness: "codex",
			budgetBytes: 1000,
		});
		expect(result.lessons.map((lesson) => lesson.id)).toEqual([
			"lesson-0",
			"lesson-1",
			"lesson-2",
		]);
		expect(result).toMatchObject({ matched: 10, truncated: true });
	});

	it("normalizes Git origins", () => {
		for (const origin of [
			"https://github.com/tedix-hq/tedix.git",
			"git@github.com:tedix-hq/tedix.git",
			"ssh://git@github.com/tedix-hq/tedix",
			"github.com/Tedix-HQ/tedix/",
		])
			expect(normalizeRepo(origin)).toBe("github.com/tedix-hq/tedix");
	});
});

describe("getSessionLessons procedure", () => {
	function context(organizationId: string, scopes: string[]): BaseContext {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(memoryFacts));
		sqlite.exec(`INSERT INTO memory_facts
			(id, organization_id, topic_key, content, fact_type, status, review_status, use_policy)
			VALUES
			('fact-org-1', '${ORG_1}', 'learning-feed:lesson:general:general:a', 'Org one lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation'),
			('fact-pending', '${ORG_1}', 'learning-feed:decision:tedix:codex:b', 'Unapproved.', 'preference', 'probation', 'pending', 'requires_user_confirmation'),
			('fact-org-2', '${ORG_2}', 'learning-feed:lesson:general:general:a', 'Org two lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation')`);
		const env = {
			ENVIRONMENT: "test",
			DB: createD1Facade(sqlite),
		} as unknown as CloudflareEnv;
		return {
			apiKey: { id: "key-1", name: "test", organizationId, scopes },
			authType: "apikey",
			db: createDbClient(env.DB) as BaseContext["db"],
			env,
			headers: new Headers(),
			organizationId,
			url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
		} as BaseContext;
	}

	it("returns only the caller organization's approved lessons", async () => {
		const result = await createRouterClient(agentTurnTriageContractRouter, {
			context: context(ORG_1, ["mcp:messaging.read"]),
		}).getSessionLessons({ harness: "codex" });
		expect(result.organizationId).toBe(ORG_1);
		expect(result.lessons.map((lesson) => lesson.text)).toEqual([
			"Org one lesson.",
		]);
	});

	it("requires the messaging read scope", async () => {
		await expect(
			createRouterClient(agentTurnTriageContractRouter, {
				context: context(ORG_1, ["mcp:work.read"]),
			}).getSessionLessons({ harness: "codex" }),
		).rejects.toThrow();
	});
});
