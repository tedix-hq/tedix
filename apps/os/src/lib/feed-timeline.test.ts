import { describe, expect, it } from "vite-plus/test";
import {
	ActivityFeedItemSchema,
	type ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import {
	activityDays,
	activityHeadline,
	activityStatus,
	collapseActivity,
	matchesActivityWho,
} from "./feed-timeline";

const item = (patch: Partial<ActivityFeedItem>): ActivityFeedItem =>
	ActivityFeedItemSchema.parse({
		id: "work:1",
		actor: "Cedar",
		sentence: "Cedar filed 3 receipts for October.",
		source: "/work/items/1",
		projectId: null,
		workItemId: null,
		tediId: null,
		kind: "work",
		classId: "work:work.completed",
		importance: "low",
		at: "2026-10-26T09:00:00.000Z",
		dueAt: null,
		needsAction: false,
		stalled: false,
		done: true,
		explanation: "",
		reactions: [],
		...patch,
	});

describe("activity timeline", () => {
	it("splits a headline from at most one added line and skips receipt boilerplate", () => {
		expect(
			activityHeadline(
				item({
					sentence:
						"Reconciler found an €840 quantity mismatch. 500 invoiced, 480 received.",
				}),
			),
		).toEqual({
			headline: "Reconciler found an €840 quantity mismatch.",
			detail: "500 invoiced, 480 received.",
		});
		expect(
			activityHeadline(
				item({
					sentence: "On-call could not reach the status page.",
					explanation:
						"On-call could not reach the status page. It retries in 30 minutes.\n\nRecorded in the linked Work history.",
				}),
				["Recorded in the linked Work history."],
			),
		).toEqual({
			headline: "On-call could not reach the status page.",
			detail: "It retries in 30 minutes.",
		});
		expect(
			activityHeadline(
				item({ explanation: "Recorded in the linked Work history." }),
				["Recorded in the linked Work history."],
			).detail,
		).toBe("");
	});

	it("sorts people, tedis, apps and shipped work into their chips", () => {
		const person = item({ actorIdentity: { type: "user", id: "morgan" } });
		const tedi = item({ tediId: "11111111-1111-4111-8111-111111111111" });
		const agent = item({
			actorIdentity: { type: "external_agent", id: null, harness: "codex" },
		});
		const app = item({ actorIdentity: { type: "system" }, done: false });
		expect(matchesActivityWho(person, "people")).toBe(true);
		expect(matchesActivityWho(tedi, "tedis")).toBe(true);
		expect(matchesActivityWho(agent, "tedis")).toBe(true);
		expect(matchesActivityWho(app, "apps")).toBe(true);
		expect(matchesActivityWho(app, "shipped")).toBe(false);
		expect(matchesActivityWho(person, "shipped")).toBe(true);
		expect(matchesActivityWho(app, "all")).toBe(true);
	});

	it("marks finished and failed outcomes, never a pending decision", () => {
		expect(activityStatus(item({ kind: "result" }))?.tone).toBe("success");
		expect(
			activityStatus(item({ kind: "result", done: false, stalled: true }))
				?.tone,
		).toBe("error");
		expect(
			activityStatus(item({ classId: "work:attempt.failed", done: false }))
				?.label,
		).toBe("Needs a look");
		expect(activityStatus(item({}))).toBeNull();
		expect(
			activityStatus(item({ kind: "decision", needsAction: true })),
		).toBeNull();
	});

	it("groups by day newest first and folds three repeated events into one row", () => {
		const now = new Date("2026-10-26T15:00:00.000Z");
		const commits = [0, 1, 2].map((n) =>
			item({
				id: `commit:${n}`,
				actor: "Codex",
				sentence: `Codex shipped fix ${n}.`,
				at: `2026-10-25T1${n}:00:00.000Z`,
			}),
		);
		const days = activityDays(
			[
				...commits,
				item({ id: "today", at: "2026-10-26T08:00:00.000Z" }),
				item({ id: "old", at: "2026-10-20T08:00:00.000Z" }),
			],
			"UTC",
			now,
			"en-US",
		);
		expect(days.map((d) => d.label)).toEqual([
			"Today",
			"Yesterday",
			"Tue, Oct 20",
		]);
		const yesterday = collapseActivity(days[1]!.items);
		expect(yesterday).toHaveLength(1);
		expect(yesterday[0]).toMatchObject({ kind: "group", actor: "Codex" });
		expect(
			yesterday[0]!.kind === "group" && yesterday[0]!.items.map((i) => i.id),
		).toEqual(["commit:2", "commit:1", "commit:0"]);
		expect(collapseActivity(commits.slice(0, 2))).toHaveLength(2);
		expect(
			collapseActivity([
				commits[0]!,
				{ ...commits[1]!, needsAction: true },
				commits[2]!,
			]).every((entry) => entry.kind === "item"),
		).toBe(true);
	});
});
