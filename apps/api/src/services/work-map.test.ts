import { describe, expect, it } from "vite-plus/test";
import type { WorkMapSnapshot } from "@tedix/db/queries/work-items/map";
import { buildWorkMap, buildWorkMapLanes } from "./work-map";

const NOW = Date.parse("2026-11-06T09:00:00.000Z");
const at = (secondsAgo: number) =>
	new Date(NOW - secondsAgo * 1000).toISOString();

function heartbeat(
	lane: string,
	secondsAgo: number,
	extra: Partial<WorkMapSnapshot["heartbeats"][number]> = {},
): WorkMapSnapshot["heartbeats"][number] {
	return {
		orgId: "org_a",
		reporterId: "mac-1",
		executor: lane === "supervisor" ? "supervisor" : "codex",
		lane,
		running: true,
		observedAt: at(secondsAgo),
		reportedAt: at(secondsAgo),
		lastAdmissionAt: null,
		slotsInUse: 0,
		slotsTotal: 2,
		topReason: null,
		topReasonCount: null,
		duty: null,
		...extra,
	};
}

function item(
	id: string,
	extra: Partial<WorkMapSnapshot["items"][number]> = {},
): WorkMapSnapshot["items"][number] {
	return {
		id,
		title: `Item ${id}`,
		disposition: "accepted",
		priority: "medium",
		projectId: "p1",
		objectiveId: null,
		workClass: null,
		parentId: "epic",
		ownerType: "user",
		ownerId: "u-owner",
		stewardType: null,
		stewardId: null,
		createdAt: at(86_400 * 3),
		acceptedAt: at(86_400 * 3),
		executor: "codex",
		laneState: null,
		lastEventAt: at(3600),
		lastEventType: "comment",
		lastComment: null,
		attemptState: null,
		...extra,
	};
}

const empty: WorkMapSnapshot = {
	items: [],
	truncated: false,
	epics: [],
	childCounts: [],
	projects: [
		{ id: "p1", name: "EU", objectiveId: "o1", ownerUserId: "u-lead" },
	],
	objectives: [{ id: "o1", title: "EU customers" }],
	interactions: [],
	relations: [],
	claims: [],
	heartbeats: [],
};

describe("buildWorkMapLanes", () => {
	it("marks a stopped supervisor down within one minute and its runners unknown", () => {
		const up = buildWorkMapLanes(
			[heartbeat("supervisor", 20), heartbeat("lane-a", 60)],
			NOW,
		);
		expect(up.find((l) => l.kind === "supervisor")?.state).toBe("up");

		const lanes = buildWorkMapLanes(
			[heartbeat("supervisor", 50), heartbeat("lane-a", 60)],
			NOW,
		);
		const supervisor = lanes.find((l) => l.kind === "supervisor")!;
		expect(supervisor.state).toBe("down");
		expect(supervisor.reason).toMatch(/sign-in/);
		expect(lanes.find((l) => l.lane === "lane-a")?.state).toBe("unknown");
		expect(lanes[0]?.kind).toBe("supervisor");
	});

	it("infers the supervisor from runner reports on older CLIs without false alarms", () => {
		const fresh = buildWorkMapLanes([heartbeat("lane-a", 130)], NOW);
		expect(fresh.find((l) => l.kind === "supervisor")).toMatchObject({
			state: "up",
			heartbeat: false,
		});
		const stopped = buildWorkMapLanes([heartbeat("lane-a", 7 * 3600)], NOW);
		expect(stopped.find((l) => l.kind === "supervisor")?.state).toBe("down");
	});

	it("shows a runner that is not running as stopped with its last problem", () => {
		const lanes = buildWorkMapLanes(
			[
				heartbeat("supervisor", 5),
				heartbeat("lane-a", 60, {
					running: false,
					topReason: "login-blocked",
					topReasonCount: 3,
				}),
			],
			NOW,
		);
		const runner = lanes.find((l) => l.lane === "lane-a")!;
		expect(runner.state).toBe("stopped");
		expect(runner.reason).toContain("login-blocked");
	});
});

describe("buildWorkMap", () => {
	it("builds epic progress and names a blocker and an actor for every item not moving", () => {
		const map = buildWorkMap(
			{
				...empty,
				items: [
					item("a", { lastEventAt: at(20 * 3600) }),
					item("b", {
						laneState: "held",
						lastComment:
							"Dispatcher execution held for Work revision 3: tests fail. Three identical failures; held until the Work revision changes.",
					}),
					item("c"),
					item("d", {
						ownerType: null,
						ownerId: null,
						projectId: null,
						lastEventAt: at(30 * 3600),
					}),
					item("e", {
						disposition: "proposed",
						createdAt: at(40 * 3600),
						lastEventAt: at(40 * 3600),
					}),
				],
				epics: [
					{
						id: "epic",
						title: "Epic: EU data layout",
						disposition: "accepted",
						projectId: "p1",
						objectiveId: null,
						parentId: null,
					},
				],
				childCounts: [
					{ parentId: "epic", disposition: "completed", count: 3 },
					{ parentId: "epic", disposition: "accepted", count: 4 },
					{ parentId: "epic", disposition: "cancelled", count: 1 },
				],
				interactions: [
					{
						id: "ask-1",
						workItemId: "c",
						subject: "Pick the Postgres plan",
						targetType: "user",
						targetId: "u-aaron",
						createdAt: at(5 * 3600),
					},
				],
				relations: [{ fromId: "a", toId: "c", type: "blocks" }],
				heartbeats: [heartbeat("supervisor", 5), heartbeat("lane-a", 30)],
			},
			{ organizationId: "org_a", now: NOW, stalledAfterHours: 12 },
		);

		expect(map.epics[0]?.progress).toEqual({
			total: 8,
			completed: 3,
			cancelled: 1,
			open: 4,
			percentDone: 3 / 7,
		});
		const byId = new Map(map.notMoving.map((row) => [row.workItemId, row]));
		expect([...byId.keys()].sort()).toEqual(["a", "b", "c", "d", "e"]);
		for (const row of map.notMoving) {
			expect(row.blocker.length).toBeGreaterThan(10);
			expect(row.actor).toBeDefined();
		}
		expect(byId.get("b")).toMatchObject({
			kind: "held",
			actor: { type: "user", id: "u-owner" },
		});
		expect(byId.get("b")?.blocker).toMatch(/Three identical failures/);
		expect(byId.get("c")).toMatchObject({
			kind: "waiting_on_person",
			actor: { type: "user", id: "u-aaron" },
			interactionId: "ask-1",
		});
		expect(byId.get("a")?.kind).toBe("stalled");
		expect(byId.get("d")?.actor).toEqual({ type: "unassigned" });
		expect(byId.get("e")?.kind).toBe("waiting_for_approval");
		// Longest wait first.
		expect(map.notMoving[0]?.workItemId).toBe("e");
		expect(
			map.items.find((i) => i.id === "c")?.signals.map((s) => s.kind),
		).toContain("blocked");
	});

	it("flags overlap, duplicates and work with no purpose", () => {
		const map = buildWorkMap(
			{
				...empty,
				items: [
					item("a"),
					item("b"),
					item("c", { projectId: null, parentId: null }),
				],
				claims: [
					{ workItemId: "a", resourceKey: "file:tedix/apps/os/src/x.ts" },
					{ workItemId: "b", resourceKey: "file:tedix/apps/os/src/x.ts" },
				],
				relations: [{ fromId: "a", toId: "c", type: "duplicates" }],
			},
			{ organizationId: "org_a", now: NOW, stalledAfterHours: 12 },
		);
		const kinds = (id: string) =>
			map.items.find((i) => i.id === id)?.signals.map((s) => s.kind);
		expect(kinds("a")).toEqual(expect.arrayContaining(["overlap", "conflict"]));
		expect(kinds("b")).toContain("overlap");
		expect(kinds("c")).toEqual(expect.arrayContaining(["conflict", "orphan"]));
		expect(map.notMoving).toEqual([]);
	});
});
