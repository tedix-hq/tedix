/**
 * `getSessionLessons`: approved lessons of the caller's organization only,
 * filtered to the session's repo and harness, ranked, and trimmed to budget.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it, vi } from "vite-plus/test";
import { isHoldoutSession } from "../../services/lesson-delivery";
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
	topicKey: null,
	metadata: (scope ? { learningFeed: { version: 1, scope } } : null) as never,
	updatedAt: "2026-10-07T00:00:00Z",
});

describe("selectSessionLessons", () => {
	it("puts a person's standing preferences first", () => {
		const standing = {
			...row("standing-1", "Standing preferences: answer briefly."),
			metadata: {
				learningFeed: {
					version: 1,
					hoisted: true,
					scope: { repo: "general", harness: "general", topic: "standing" },
				},
			} as never,
		};
		const result = selectSessionLessons(
			[
				row("tedix-repo", "Repo and harness lesson.", {
					repo: "tedix",
					harness: "codex",
					topic: "ship",
				}),
				standing,
			],
			{ harness: "codex", repo: "tedix", budgetBytes: 3200 },
		);
		expect(result.lessons.map((l) => l.id)).toEqual([
			"standing-1",
			"tedix-repo",
		]);
	});

	it("ranks answer-style lessons, then core rules, above repo matches", () => {
		const result = selectSessionLessons(
			[
				row("tedix-repo", "Repo and harness lesson.", {
					repo: "tedix",
					harness: "codex",
					topic: "ship",
				}),
				{ ...row("core-rule", "Call the workers tedis."), priority: "core" },
				row("answer", "How to answer and report: - Answer in plain English", {
					repo: "general",
					harness: "general",
					topic: "communication",
				}),
			],
			{ harness: "codex", repo: "tedix", budgetBytes: 3200 },
		);
		expect(result.lessons.map((l) => l.id)).toEqual([
			"answer",
			"core-rule",
			"tedix-repo",
		]);
	});

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

	it("delivers a distilled lesson's rules for the branch's subjects, standing ones whole", () => {
		const mined = (
			id: string,
			hoisted: boolean,
			content: string,
			rules: object[],
		) => ({
			...row(id, content),
			metadata: {
				learningFeed: {
					version: 1,
					autoConfirmed: true,
					...(hoisted ? { hoisted: true } : {}),
					scope: {
						repo: "general",
						harness: "general",
						topic: hoisted ? "standing" : "git",
					},
					rules,
				},
			} as never,
		});
		const rows = [
			mined(
				"standing",
				true,
				"How the user works:\n- Answer short\n- Push promptly",
				[
					{
						rule: "Answer short",
						subject: "communication",
						key: "comms.length",
					},
					{ rule: "Push promptly", subject: "git", key: "git.push" },
				],
			),
			mined(
				"git",
				false,
				"Git and shipping:\n- Rebase before pushing\n- Never open pull requests",
				[
					{
						rule: "Rebase before pushing",
						subject: "git",
						key: "git.push.rebase",
					},
					{
						rule: "Never open pull requests",
						subject: "git",
						key: "git.pull-requests",
					},
				],
			),
			mined("tests", false, "Code and architecture:\n- Write a test first", [
				{ rule: "Write a test first", subject: "coding", key: "coding.tests" },
			]),
			{ ...row("core", "Call the workers tedis."), priority: "core" as const },
		];
		const branch = selectSessionLessons(rows, {
			harness: "codex",
			topics: ["rebase", "push"],
			budgetBytes: 3200,
		});
		expect(branch.lessons.map((l) => [l.id, l.text])).toEqual([
			[
				"standing",
				"How the user works:\n- Answers: Answer short\n- Git: Push promptly",
			],
			["core", "Call the workers tedis."],
			["git", "Git and shipping:\n- Rebase before pushing"],
		]);
		expect(branch.ruleKeys).toEqual({
			standing: ["comms.length", "git.push"],
			git: ["git.push.rebase"],
		});
		// No subject named: every lesson, as before.
		expect(
			selectSessionLessons(rows, { harness: "codex", budgetBytes: 3200 })
				.lessons,
		).toHaveLength(4);
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
	const startWorkflow = vi.fn(async (_options: unknown) => ({
		id: "instance-1",
	}));
	function context(
		organizationId: string,
		scopes: string[],
		userId?: string,
	): BaseContext {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(memoryFacts));
		sqlite.exec(`INSERT INTO memory_facts
			(id, organization_id, topic_key, content, fact_type, status, review_status, use_policy)
			VALUES
			('fact-org-1', '${ORG_1}', 'learning-feed:lesson:general:general:a', 'Org one lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation'),
			('fact-pending', '${ORG_1}', 'learning-feed:decision:tedix:codex:b', 'Unapproved.', 'preference', 'probation', 'pending', 'requires_user_confirmation'),
			('fact-org-2', '${ORG_2}', 'learning-feed:lesson:general:general:a', 'Org two lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation')`);
		sqlite.exec(`INSERT INTO memory_facts
			(id, organization_id, topic_key, content, fact_type, status, review_status, use_policy, visibility, metadata)
			VALUES
			('fact-mine', '${ORG_1}', 'learning-feed:decision:general:codex:x:user:user-a', 'My lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation', 'private', '{"learningFeed":{"ownerUserId":"user-a"}}'),
			('fact-theirs', '${ORG_1}', 'learning-feed:decision:general:codex:x:user:user-b', 'Their lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation', 'private', '{"learningFeed":{"ownerUserId":"user-b"}}')`);
		const env = {
			ENVIRONMENT: "test",
			DB: createD1Facade(sqlite),
			MEMORY_REFLECTION_WORKFLOW: { create: startWorkflow },
		} as unknown as CloudflareEnv;
		return {
			apiKey: { id: "key-1", name: "test", organizationId, scopes },
			authType: "apikey",
			db: createDbClient(env.DB) as BaseContext["db"],
			env,
			headers: new Headers(),
			organizationId,
			url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
			...(userId ? { user: { sub: userId } } : {}),
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

	it("adds only the calling user's own personal lessons", async () => {
		const texts = async (userId?: string) =>
			(
				await createRouterClient(agentTurnTriageContractRouter, {
					context: context(ORG_1, ["mcp:messaging.read"], userId),
				}).getSessionLessons({ harness: "codex" })
			).lessons
				.map((lesson) => lesson.text)
				.sort();
		expect(await texts("user-a")).toEqual(["My lesson.", "Org one lesson."]);
		expect(await texts("user-b")).toEqual(["Org one lesson.", "Their lesson."]);
		expect(await texts()).toEqual(["Org one lesson."]);
	});

	it("mines on demand for the caller's organization with the write scope only", async () => {
		startWorkflow.mockClear();
		const result = await createRouterClient(agentTurnTriageContractRouter, {
			context: context(ORG_1, ["mcp:messaging.write"]),
		}).mineSessionLessons({});
		expect(result).toMatchObject({
			organizationId: ORG_1,
			factsWritten: 0,
			factsArchived: 0,
			budgetHit: false,
			inProgress: true,
		});
		// Each person's whole history is distilled by its own Workflow instance.
		expect(startWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				params: { organizationId: ORG_1, scope: "lessons" },
			}),
		);
		await expect(
			createRouterClient(agentTurnTriageContractRouter, {
				context: context(ORG_1, ["mcp:messaging.read"]),
			}).mineSessionLessons({}),
		).rejects.toThrow();
	});

	it("requires the messaging read scope", async () => {
		await expect(
			createRouterClient(agentTurnTriageContractRouter, {
				context: context(ORG_1, ["mcp:work.read"]),
			}).getSessionLessons({ harness: "codex" }),
		).rejects.toThrow();
	});
});

describe("getSessionLessons holdout and delivery log", () => {
	function context(): { ctx: BaseContext; sqlite: DatabaseSync } {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(memoryFacts));
		// The generated DDL leaves out SQL defaults; D1 has CURRENT_TIMESTAMP.
		sqlite.exec(
			schemaDdl(learningInteractionEvents).replace(
				/(created_at\W*\s+text\s+NOT NULL)/i,
				"$1 DEFAULT CURRENT_TIMESTAMP",
			),
		);
		sqlite.exec(`INSERT INTO memory_facts
			(id, organization_id, topic_key, content, fact_type, status, review_status, use_policy, metadata)
			VALUES
			('fact-written', '${ORG_1}', 'learning-feed:lesson:general:general:naming', 'Written lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation', '{"learningFeed":{"scope":{"topic":"naming"}}}'),
			('fact-mined', '${ORG_1}', 'learning-feed:decision:general:general:communication', 'Mined lesson.', 'preference', 'active', 'confirmed', 'requires_user_confirmation', '{"learningFeed":{"autoConfirmed":true,"scope":{"topic":"communication"}}}')`);
		const env = {
			ENVIRONMENT: "test",
			DB: createD1Facade(sqlite),
		} as unknown as CloudflareEnv;
		return {
			sqlite,
			ctx: {
				apiKey: {
					id: "key-1",
					name: "test",
					organizationId: ORG_1,
					scopes: ["mcp:messaging.read"],
				},
				authType: "apikey",
				db: createDbClient(env.DB) as BaseContext["db"],
				env,
				headers: new Headers(),
				organizationId: ORG_1,
				url: new URL("https://api.tedix.test/rpc/agentTurnTriage"),
			} as BaseContext,
		};
	}
	async function sessionIn(holdout: boolean): Promise<string> {
		for (let i = 0; ; i++) {
			const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
			if ((await isHoldoutSession(id)) === holdout) return id;
		}
	}

	it("withholds only learned lessons from a holdout session and logs both arms", async () => {
		const { ctx, sqlite } = context();
		const client = createRouterClient(agentTurnTriageContractRouter, {
			context: ctx,
		});
		const texts = (result: { lessons: Array<{ text: string }> }) =>
			result.lessons.map((lesson) => lesson.text).sort();
		const delivered = await client.getSessionLessons({
			harness: "codex",
			sessionId: await sessionIn(false),
		});
		expect(delivered.holdout).toBe(false);
		expect(texts(delivered)).toEqual(["Mined lesson.", "Written lesson."]);
		const holdoutId = await sessionIn(true);
		const held = await client.getSessionLessons({
			harness: "codex",
			sessionId: holdoutId,
		});
		expect(held.holdout).toBe(true);
		expect(texts(held)).toEqual(["Written lesson."]);
		// Without a session id nothing is withheld or recorded.
		const plain = await client.getSessionLessons({ harness: "codex" });
		expect(plain.holdout).toBeUndefined();
		expect(texts(plain)).toEqual(["Mined lesson.", "Written lesson."]);
		// A repeat with the same lessons adds no row.
		await client.getSessionLessons({ harness: "codex", sessionId: holdoutId });
		const rows = sqlite
			.prepare(
				"SELECT thread_id, event_kind, metadata FROM learning_interaction_events WHERE surface = 'lesson_delivery'",
			)
			.all() as Array<{
			thread_id: string;
			event_kind: string;
			metadata: string;
		}>;
		expect(rows).toHaveLength(2);
		const holdoutRow = rows.find((row) => row.thread_id === holdoutId)!;
		expect(holdoutRow.event_kind).toBe("delivered");
		expect(JSON.parse(holdoutRow.metadata)).toMatchObject({
			holdout: true,
			lessonIds: ["fact-written"],
			measured: [
				{
					id: "fact-mined",
					topicKey: "learning-feed:decision:general:general:communication",
					subjects: ["communication"],
				},
			],
		});
	});
});
