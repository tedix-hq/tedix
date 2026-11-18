import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceActivityItem } from "@tedix/api-contract/schemas/workspace-feed";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	canvasOutputsQueryOptions,
	osQuery,
	tediNamesQueryOptions,
	workspaceCollaboratorsQueryOptions,
	workspacePresenceQueryOptions,
} from "@/lib/os-query-options";
import {
	groupActivityByDay,
	WorkspaceActivity,
	workspaceActivityEntries,
} from "./workspace-activity";

const workspaceId = "8a076b09-73c8-4c07-975a-258c65c36fed";

let seq = 0;
function item(
	overrides: Partial<WorkspaceActivityItem> & {
		actor: WorkspaceActivityItem["actor"];
	},
): WorkspaceActivityItem {
	seq += 1;
	return {
		id: `item-${seq}`,
		workspaceId,
		seq,
		kind: "output",
		entityId: "plan",
		revision: 2,
		changeRecordId: `record-${seq}`,
		title: null,
		summary: null,
		occurredAt: "2026-11-08T10:00:00Z",
		...overrides,
	};
}

const action = (
	resource: string,
	operation: string,
	outcome: NonNullable<WorkspaceActivityItem["action"]>["outcome"] = "applied",
	revisionId?: string,
): WorkspaceActivityItem["action"] => ({
	resource,
	operation,
	outcome,
	surface: "workspace_object",
	...(revisionId ? { revisionId } : {}),
});

const file = (outputId: string, revisionId: string) => ({
	artifact: { outputId, revisionId },
});

const names = {
	viewerId: "user-me",
	people: { "user-luz": "Luz Ortega" },
	tedis: { "tedi-1": "Scout" },
	files: { plan: "Launch plan" },
};

/** Each entry as the one sentence a person reads. */
const sentences = (items: WorkspaceActivityItem[], given = names) =>
	workspaceActivityEntries(items, workspaceId, given).map(
		(entry) =>
			`${entry.lead}${entry.file ? ` ${entry.file.title}` : ""}${entry.tail}`,
	);

describe("workspace activity sentences", () => {
	it("names a person, the signed-in person, the agent and a tedi", () => {
		expect(
			sentences([
				item({
					actor: { kind: "user", id: "user-luz" },
					title: "Launch plan",
					...file("plan", "rev-1"),
				}),
				item({
					actor: { kind: "user", id: "user-me" },
					title: "Launch plan",
					...file("plan", "rev-2"),
				}),
				item({
					kind: "run",
					actor: { kind: "external_agent", id: "agent-7f3a" },
					action: action("output", "revise", "applied", "rev-3"),
					...file("plan", "rev-3"),
				}),
				item({
					kind: "run",
					actor: { kind: "tedi", id: "tedi-1" },
					action: action("output", "read"),
				}),
			]),
		).toEqual([
			"Luz Ortega changed Launch plan",
			"You changed Launch plan",
			"The agent changed Launch plan",
			"Scout read a file",
		]);
	});

	it("never prints an id for someone or something it cannot name", () => {
		const entries = workspaceActivityEntries(
			[
				item({
					actor: { kind: "user", id: "user-unknown" },
					title: "Notes",
					...file("notes", "rev-1"),
				}),
				item({
					kind: "run",
					actor: { kind: "tedi", id: "tedi-unknown" },
					action: action("output", "edit", "applied", "rev-9"),
					...file("gone", "rev-9"),
				}),
				item({
					kind: "run",
					actor: { kind: "service", id: "workspace_object" },
					action: action("outputs", "archive", "applied", "rev-8"),
					...file("gone", "rev-8"),
				}),
			],
			workspaceId,
			{},
		);
		expect(
			entries.map((entry) => `${entry.lead} ${entry.file?.title}`),
		).toEqual([
			"Someone changed Notes",
			"The agent changed a file",
			"The agent archived a file",
		]);
		expect(JSON.stringify(entries)).not.toMatch(
			/user-unknown|tedi-unknown|workspace_object|record-/,
		);
	});

	it("credits the agent for what it did while answering a person, and names app work plainly", () => {
		const me = { kind: "user", id: "user-me" } as const;
		expect(
			sentences([
				item({ kind: "run", actor: me, action: action("app", "create") }),
				item({
					kind: "run",
					actor: me,
					action: action("app", "create", "needs_approval"),
				}),
				item({ kind: "run", actor: me, action: action("app", "readFile") }),
				item({ kind: "run", actor: me, action: action("app", "writeFile") }),
				// The person's own change through the app, not the agent's.
				item({ actor: me, title: "Budget", revision: 1, ...file("b", "r1") }),
			]),
		).toEqual([
			"The agent created an app",
			"The agent asked to create an app",
			"The agent read an app's code",
			"The agent changed an app",
			"You created Budget",
		]);
	});

	it("leaves out the check before an app is created and anything it has no plain words for", () => {
		const me = { kind: "user", id: "user-me" } as const;
		expect(
			sentences([
				item({ kind: "run", actor: me, action: action("app_check", "create") }),
				item({
					kind: "run",
					actor: me,
					action: action("something_new", "poke"),
				}),
				item({
					kind: "run",
					actor: me,
					action: action("conversation", "turn.finished"),
				}),
			]),
		).toEqual([]);
	});

	it("tells created, changed, renamed, archived and restored apart", () => {
		const luz = { kind: "user", id: "user-luz" } as const;
		const at = (minute: number) => `2026-11-08T10:${minute}:00Z`;
		// Newest first, as the API returns them.
		expect(
			sentences([
				item({
					actor: luz,
					title: "Launch plan v2",
					summary: "Updated Launch plan v2",
					occurredAt: at(50),
					...file("plan", "rev-2"),
				}),
				item({
					actor: luz,
					title: "Launch plan v2",
					summary: "Archived Launch plan v2",
					occurredAt: at(40),
					...file("plan", "rev-2"),
				}),
				item({
					actor: luz,
					title: "Launch plan v2",
					summary: "Updated Launch plan v2",
					occurredAt: at(30),
					...file("plan", "rev-2"),
				}),
				item({
					actor: luz,
					title: "Launch plan",
					occurredAt: at(20),
					...file("plan", "rev-2"),
				}),
				item({
					actor: luz,
					title: "Launch plan",
					revision: 1,
					occurredAt: at(10),
					...file("plan", "rev-1"),
				}),
			]),
		).toEqual([
			"Luz Ortega restored Launch plan v2",
			"Luz Ortega archived Launch plan v2",
			"Luz Ortega renamed Launch plan v2",
			"Luz Ortega changed Launch plan",
			"Luz Ortega created Launch plan",
		]);
	});

	it("says what an action did when it was stopped or is waiting", () => {
		const agent = { kind: "external_agent", id: "agent-1" } as const;
		expect(
			sentences([
				item({
					kind: "run",
					actor: agent,
					action: action("output", "create", "needs_approval"),
				}),
				item({
					kind: "run",
					actor: agent,
					action: action("outputs", "archive", "denied"),
				}),
				item({
					kind: "run",
					actor: agent,
					action: action("output", "replace", "not_applied"),
				}),
				item({
					kind: "run",
					actor: agent,
					action: action("work", "list"),
				}),
				item({
					kind: "run",
					actor: agent,
					action: action("web", "fetch"),
				}),
			]),
		).toEqual([
			"The agent asked to create a file",
			"The agent was not allowed to archive a file",
			"The agent tried to change a file, but it did not go through",
			"The agent looked at the tasks here",
			"The agent read a web page",
		]);
	});

	it("tells a save once when it was recorded as a file change and an agent action", () => {
		expect(
			sentences([
				item({
					actor: { kind: "service", id: "workspace_object" },
					title: "Launch plan",
					revision: 3,
					...file("plan", "rev-3"),
				}),
				item({
					kind: "run",
					actor: { kind: "tedi", id: "tedi-1" },
					action: action("output", "revise", "applied", "rev-3"),
					...file("plan", "rev-3"),
				}),
			]),
		).toEqual(["Scout changed Launch plan"]);
	});

	it("leaves out other workspaces, unverified files and chat steps", () => {
		const luz = { kind: "user", id: "user-luz" } as const;
		expect(
			sentences([
				item({ actor: luz, title: "Hidden title" }),
				item({
					actor: luz,
					title: "Elsewhere",
					workspaceId: "other",
					...file("x", "rev-1"),
				}),
				item({
					kind: "run",
					actor: luz,
					action: action("conversation", "turn.started"),
				}),
			]),
		).toEqual([]);
	});

	it("links a file that can be opened and groups entries by day", () => {
		const entries = workspaceActivityEntries(
			[
				item({
					actor: { kind: "user", id: "user-luz" },
					title: "Launch plan",
					occurredAt: "2026-11-08T10:00:00Z",
					...file("plan", "rev-2"),
				}),
				item({
					kind: "run",
					actor: { kind: "external_agent", id: "agent-1" },
					action: action("output", "read"),
					occurredAt: "2026-11-07T09:00:00Z",
				}),
			],
			workspaceId,
			names,
		);
		expect(entries[0]?.file).toEqual({
			title: "Launch plan",
			href: "/outputs/plan",
		});
		expect(entries[1]?.file).toEqual({ title: "a file", href: null });
		expect(
			groupActivityByDay(entries, new Date("2026-11-08T12:00:00Z")).map(
				(group) => [group.label, group.entries.length],
			),
		).toEqual([
			["Today", 1],
			["Yesterday", 1],
		]);
	});
});

describe("workspace activity list", () => {
	it("shows sentences with file links, names and times, and no ids", () => {
		const client = new QueryClient();
		const now = new Date().toISOString();
		client.setQueryData<unknown>(
			osQuery.osWorkspaces.workspaces.activity.infiniteOptions({
				input: (before: string | undefined) => ({
					workspaceId,
					kinds: ["output", "run"],
					limit: 50,
					...(before ? { before } : {}),
				}),
				initialPageParam: undefined as string | undefined,
				getNextPageParam: (page) => page.next ?? undefined,
			}).queryKey,
			{
				pageParams: [undefined],
				pages: [
					{
						items: [
							item({
								actor: { kind: "user", id: "user-luz" },
								entityId: "visible",
								title: "Research notes",
								occurredAt: now,
								...file("visible", "rev-2"),
							}),
							item({
								kind: "run",
								actor: { kind: "external_agent", id: "agent-1" },
								action: action("outputs", "archive", "applied", "rev-5"),
								occurredAt: now,
								...file("budget", "rev-5"),
							}),
							item({
								kind: "run",
								actor: { kind: "tedi", id: "tedi-1" },
								action: action("work", "list"),
								occurredAt: now,
							}),
							item({
								actor: { kind: "user", id: "user-luz" },
								entityId: "hidden",
								title: "Hidden title",
								occurredAt: now,
							}),
						],
						next: null,
					},
				],
			},
		);
		client.setQueryData<unknown>(tediNamesQueryOptions().queryKey, {
			data: [{ id: "tedi-1", name: "scout", displayName: "Scout" }],
		});
		client.setQueryData<unknown>(
			canvasOutputsQueryOptions(workspaceId).queryKey,
			{ items: [{ id: "budget", title: "Budget 2027" }], truncated: false },
		);
		client.setQueryData<unknown>(
			workspacePresenceQueryOptions(workspaceId).queryKey,
			{ workspaceId, userId: "user-me", displayName: "Me", role: "owner" },
		);
		client.setQueryData<unknown>(
			workspaceCollaboratorsQueryOptions(workspaceId).queryKey,
			{
				collaborators: [
					{ userId: "user-luz", name: "Luz Ortega", email: "luz@example.com" },
				],
				links: [],
			},
		);
		const html = renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(WorkspaceActivity, { workspaceId }),
			),
		);
		expect(html).toContain("Today");
		expect(html).toContain("Luz Ortega changed");
		expect(html).toMatch(/href="\/outputs\/visible"[^>]*>Research notes</);
		expect(html).toContain("The agent archived");
		expect(html).toMatch(/href="\/outputs\/budget"[^>]*>Budget 2027</);
		expect(html).toContain("Scout looked at the tasks here");
		expect(html).toContain('data-activity-deed="archived"');
		expect(html).toContain("<time");
		expect(html).toContain("Some activity can be missing");
		expect(html).not.toContain("Hidden title");
		expect(html).not.toMatch(/agent-1|tedi-1|user-luz|record-|rev-5/);
		client.clear();
	});
});
