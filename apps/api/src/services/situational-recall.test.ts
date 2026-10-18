import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { memoryFacts } from "@tedix/db/schema/memory-graph";
import { projects } from "@tedix/db/schema/projects";
import { organizations } from "@tedix/db/schema/organizations";
import { workItems } from "@tedix/db/schema/work-items";
import { learningInteractionEvents } from "@tedix/db/schema/learning-feedback";
import type { BaseContext } from "../rpc/orpc";
import {
	recallDispatchBrief,
	backfillTriggers,
	recordIncident,
	triggersOf,
	updateTriggers,
} from "./situational-recall";
import { getSessionLessons } from "../rpc/routers/agent-session-lessons";
import {
	listApprovedAgentLessons,
	setAgentLessonTriggers,
} from "@tedix/db/queries/memory-graph/agent-lessons";
const { model } = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock("./lesson-distiller", () => ({ runDistillModel: model }));
const org = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const lesson = "33333333-3333-4333-8333-333333333333";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [
		organizations,
		memoryFacts,
		projects,
		workItems,
		learningInteractionEvents,
	])
		sqlite.exec(schemaDdl(table));
	sqlite
		.prepare(
			"INSERT INTO projects (id,org_id,key,name,created_at) VALUES (?,?,?,?,?)",
		)
		.run(project, org, "EX", "Example", "2026-01-01T00:00:00Z");
	sqlite
		.prepare(
			"INSERT INTO memory_facts (id,organization_id,topic_key,content,fact_type,status,review_status,use_policy,created_at,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			lesson,
			org,
			"learning-feed:example",
			"Check the companion configuration.",
			"preference",
			"active",
			"confirmed",
			"can_use_as_instruction",
			"2026-01-01T00:00:00Z",
			JSON.stringify({
				learningFeed: {
					scope: { repo: "general", harness: "general", topic: "general" },
				},
			}),
		);
	const context = {
		db: createDbClient(createD1Facade(sqlite)),
		authType: "user",
		user: { sub: "example-user" },
		env: {},
	} as BaseContext;
	return { sqlite, context };
}
describe("situational recall persistence", () => {
	it("backfills missing triggers only, preserves edits and tenant boundaries", async () => {
		const { context, sqlite } = fixture();
		model.mockResolvedValue('{"pathGlobs":["apps/*/worker.jsonc"]}');
		expect(await backfillTriggers(context, org, 10)).toEqual({
			updated: 1,
			remaining: 0,
		});
		expect(await backfillTriggers(context, org, 10)).toEqual({
			updated: 0,
			remaining: 0,
		});
		await expect(
			updateTriggers(context, "other-org", lesson, { keywords: ["bad"] }),
		).rejects.toThrow("unavailable");
		const [row] = await listApprovedAgentLessons(
			context.db,
			org,
			"learning-feed:",
		);
		await updateTriggers(context, org, lesson, { commands: ["tool deploy"] });
		expect(
			await setAgentLessonTriggers(context.db, org, row!, {
				keywords: ["stale"],
			}),
		).toBe(false);
		const catalog = await getSessionLessons(context, org, {
			harness: "codex",
			catalog: true,
			budgetBytes: 200,
		});
		expect(catalog.lessons[0]!.triggers).toEqual({ commands: ["tool deploy"] });
		expect(catalog.truncated).toBe(false);
		const [current] = await listApprovedAgentLessons(
			context.db,
			org,
			"learning-feed:",
		);
		sqlite
			.prepare("UPDATE memory_facts SET content=? WHERE id=?")
			.run("Edited lesson", lesson);
		expect(
			await setAgentLessonTriggers(context.db, org, current!, {
				keywords: ["old text"],
			}),
		).toBe(false);
	});
	it("links a failure to a preexisting lesson and proposes one delivery investigation per actor, preserving unknown", async () => {
		const { context, sqlite } = fixture();
		await updateTriggers(context, org, lesson, { keywords: ["shape changed"] });
		const input = {
			eventId: "run-1",
			reason: "Shape changed at run 12345678",
			occurredAt: "2026-10-17T00:00:00Z",
			lessonIds: [],
			projectId: project,
			actor: {
				sessionId: "codex:example",
				harness: "codex",
				hookTrust: "untrusted" as const,
				dispatchPath: "example-launcher",
				delivery: "unknown" as const,
			},
		};
		const first = await recordIncident(context, org, input);
		const second = await recordIncident(context, org, {
			...input,
			eventId: "run-2",
			reason: "Shape changed at run 98765432",
		});
		expect(first.lessonIds).toEqual([lesson]);
		expect(second.workItemIds).toEqual(first.workItemIds);
		const work = sqlite
			.prepare("SELECT disposition,metadata FROM work_items")
			.get()!;
		expect(work.disposition).toBe("proposed");
		expect(JSON.parse(String(work.metadata)).reportedActor.hookTrust).toBe(
			"untrusted",
		);
		const observed = await recordIncident(context, org, {
			...input,
			eventId: "run-3",
			actor: { ...input.actor, delivery: "observed" },
		});
		expect(observed.workItemIds).toEqual([]);
		await expect(recordIncident(context, "other-org", input)).rejects.toThrow(
			"Project unavailable",
		);
	});
	it("does not propose against a lesson written after the incident", async () => {
		const { context } = fixture();
		expect(
			(
				await recordIncident(context, org, {
					eventId: "old",
					reason: "configuration failed",
					occurredAt: "2025-01-01T00:00:00Z",
					lessonIds: [lesson],
					projectId: project,
					actor: {
						sessionId: "old",
						harness: "example",
						hookTrust: "unknown",
						dispatchPath: "unknown",
						delivery: "unknown",
					},
				})
			).workItemIds,
		).toEqual([]);
		expect(
			triggersOf({ learningFeed: { triggers: { keywords: [1] } } } as never),
		).toBeUndefined();
	});
});

it("prefixes a dispatched lane without hooks and never shares a sender's private lesson", async () => {
	const { context, sqlite } = fixture();
	await updateTriggers(context, org, lesson, {
		pathGlobs: ["apps/*/worker.jsonc"],
	});
	sqlite
		.prepare(
			"INSERT INTO memory_facts (id,organization_id,topic_key,content,fact_type,status,review_status,use_policy,visibility,metadata) VALUES (?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			"private",
			org,
			"learning-feed:private",
			"Private sender preference.",
			"preference",
			"active",
			"confirmed",
			"can_use_as_instruction",
			"private",
			JSON.stringify({
				learningFeed: {
					ownerUserId: "example-user",
					triggers: { keywords: ["worker"] },
				},
			}),
		);
	const result = await recallDispatchBrief(context, org, {
		brief: "Edit apps/example/worker.jsonc",
		harness: "codex",
		targetUserId: "other-user",
	});
	expect(result.prompt).toContain("Confirm you applied");
	expect(result.prompt).not.toContain("Private sender preference");
	expect(result.lessonRecall.lessonIds).toEqual([lesson]);
});

it("preserves a full dispatch brief and reports recall that cannot fit the contract", async () => {
	const { context } = fixture();
	await updateTriggers(context, org, lesson, { keywords: ["configuration"] });
	const brief = "configuration " + "x".repeat(19_986);
	const result = await recallDispatchBrief(context, org, {
		brief,
		harness: "codex",
	});
	expect(result.prompt).toBe(brief);
	expect(result.lessonRecall.status).toBe("truncated");
	expect(result.lessonRecall.lessonIds).toEqual([]);
});

it("reuses an opaque incident's lesson link across harnesses without exposing another reporter's personal incident", async () => {
	const { context } = fixture();
	const first = {
		eventId: "opaque-first",
		reason: "Provider plan rejected",
		occurredAt: "2026-10-17T00:00:00Z",
		lessonIds: [lesson],
		projectId: project,
		actor: {
			sessionId: "codex:first",
			harness: "codex",
			hookTrust: "trusted" as const,
			dispatchPath: "example",
			delivery: "observed" as const,
		},
	};
	expect((await recordIncident(context, org, first)).workItemIds).toEqual([]);
	const again = {
		...first,
		eventId: "opaque-again",
		occurredAt: "2026-10-17T00:01:00Z",
		lessonIds: [],
		actor: {
			...first.actor,
			sessionId: "claude:second",
			harness: "claude-code",
			hookTrust: "unknown" as const,
			delivery: "absent" as const,
		},
	};
	const recurrence = await recordIncident(context, org, again);
	expect(recurrence.lessonIds).toEqual([lesson]);
	expect(recurrence.workItemIds).toHaveLength(1);
	const otherReporter = {
		...context,
		user: { sub: "other-user" },
	} as BaseContext;
	const privateLink = await recordIncident(otherReporter, org, {
		...again,
		eventId: "other-reporter",
		actor: { ...again.actor, sessionId: "other-session" },
	});
	expect(privateLink.lessonIds).toEqual([]);
	expect(privateLink.workItemIds).toEqual([]);
	const machine = {
		...context,
		authType: "apikey",
		user: undefined,
		apiKey: { id: "example-key" },
	} as BaseContext;
	const machineLink = await recordIncident(machine, org, {
		...again,
		eventId: "machine-reporter",
		actor: { ...again.actor, sessionId: "machine-session" },
	});
	expect(machineLink.lessonIds).toEqual([]);
	expect(machineLink.workItemIds).toEqual([]);
});

it("recalls repository-scoped lessons from the repository named in a brief for any harness", async () => {
	const { context, sqlite } = fixture();
	await updateTriggers(context, org, lesson, {
		pathGlobs: ["apps/*/worker.jsonc"],
	});
	sqlite
		.prepare(
			"UPDATE memory_facts SET metadata=json_set(metadata,'$.learningFeed.scope.repo',?) WHERE id=?",
		)
		.run("example-product", lesson);
	const result = await recallDispatchBrief(context, org, {
		brief: "Repo /work/example-product. Update apps/example/worker.jsonc",
		harness: "custom-harness",
	});
	expect(result.lessonRecall.lessonIds).toEqual([lesson]);
	const other = await recallDispatchBrief(context, org, {
		brief: "Repo /work/other-product. Update apps/example/worker.jsonc",
		harness: "custom-harness",
	});
	expect(other.lessonRecall.lessonIds).toEqual([]);
});
