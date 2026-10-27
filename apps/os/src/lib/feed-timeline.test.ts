import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	ActivityFeedItemSchema,
	type ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import { setOsFormattingPreferences } from "@/lib/format";
import {
	activityDays,
	activityHeadline,
	activityStatus,
	collapseActivity,
	matchesActivityWho,
} from "./feed-timeline";

afterEach(() => setOsFormattingPreferences({ locale: null, timezone: null }));

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

	it("shows a partial result as amber Partly done, keeping red for real failures", () => {
		const result = (resultOutcome: ActivityFeedItem["resultOutcome"]) =>
			activityStatus(
				item({ kind: "result", done: false, stalled: true, resultOutcome }),
			);
		expect(result("partial")).toEqual({
			tone: "warning",
			label: "Partly done",
		});
		expect(result("expired")).toEqual({ tone: "warning", label: "Paused" });
		expect(result("cancelled")).toEqual({ tone: "neutral", label: "Stopped" });
		expect(result("failed")).toEqual({ tone: "error", label: "Didn't finish" });
	});

	it("cleans codes and ids out of older stored headlines and detail lines", () => {
		const story = activityHeadline(
			item({
				kind: "result",
				sentence:
					"partial_result Delegated tedi reported Outcome: needs_follow_up.",
				explanation:
					"Failed: partial_result\n\nUpdate skill 7d2e9b14-6a03-4c8f-b1d2-5e9f0a3c8b67 with the new schedule.",
			}),
		);
		expect(story).toEqual({
			headline: "Delegated tedi reported needs follow-up.",
			detail: "Update skill with the new schedule.",
		});
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

	it("labels days and outcome chips in Spanish for a Spanish reader", () => {
		setOsFormattingPreferences({ locale: "es-ES", timezone: null });
		const now = new Date("2026-10-26T15:00:00.000Z");
		const days = activityDays(
			[
				item({ id: "today", at: "2026-10-26T08:00:00.000Z" }),
				item({ id: "yesterday", at: "2026-10-25T08:00:00.000Z" }),
				item({ id: "old", at: "2026-10-20T08:00:00.000Z" }),
			],
			"UTC",
			now,
			"es-ES",
		);
		expect(days.map((d) => d.label)).toEqual([
			"Hoy",
			"Ayer",
			new Intl.DateTimeFormat("es-ES", {
				weekday: "short",
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			}).format(new Date("2026-10-20T12:00:00Z")),
		]);
		expect(activityStatus(item({ kind: "result" }))).toEqual({
			tone: "success",
			label: "Terminado",
		});
		expect(
			activityStatus(item({ kind: "result", done: false, stalled: true })),
		).toEqual({ tone: "error", label: "No terminó" });
		expect(
			activityStatus(
				item({ kind: "result", done: false, resultOutcome: "partial" }),
			),
		).toEqual({ tone: "warning", label: "Hecho en parte" });
		expect(
			activityHeadline(
				item({
					sentence: "partial_result El tedi informó Outcome: needs_follow_up.",
				}),
			).headline,
		).toBe("El tedi informó necesita seguimiento.");
		expect(
			activityStatus(item({ classId: "work:attempt.failed", done: false }))
				?.label,
		).toBe("Necesita revisión");
	});
});
