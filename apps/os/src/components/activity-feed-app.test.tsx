import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import {
	ActivityFeedConfigSchema,
	ActivityFeedItemSchema,
} from "@tedix/api-contract/schemas/os-activity-feed";
import { osApi } from "@/lib/api";
import { osQuery, userPreferencesQueryOptions } from "@/lib/os-query-options";
import { ActivityFeedApp } from "./activity-feed-app";
import type { FeedSourceState } from "./activity-feed-sources";

vi.mock("@/lib/use-tedi-names", () => ({ useTediNames: () => ({}) }));
vi.mock("@/lib/use-decision-inbox", () => ({
	useDecisionInbox: () => ({
		requests: [],
		work: [],
		queuePending: false,
		queueFailed: false,
		inbox: { error: null, isFetching: false },
	}),
}));
vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ name: "Morgan" }),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		agentTurnTriage: {
			listLessons: vi.fn().mockResolvedValue({ lessons: [] }),
		},
		userProfile: {
			getMine: vi.fn().mockResolvedValue({ id: "fictional-acme-user" }),
		},
		workInteractions: { outbound: { profile: vi.fn() } },
		workItems: {
			listEvidence: vi.fn().mockResolvedValue({ data: [] }),
			previewEvidence: vi.fn(),
		},
		learningFeedback: {
			recordInteraction: vi.fn(),
			listInteractions: vi.fn(),
			model: vi.fn(),
			correct: vi.fn(),
		},
		userSettings: { getPreferences: vi.fn(), updatePreferences: vi.fn() },
		osWorkspaces: {
			workspaces: {
				list: vi.fn().mockResolvedValue({ items: [], truncated: false }),
			},
		},
		workAgentSessions: {
			list: vi.fn().mockResolvedValue({ sessions: [], truncated: false }),
		},
	},
}));
vi.mock("@/lib/webmcp/use-app-webmcp-tools", () => ({
	useAppWebMcpTools: vi.fn(),
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const row = ActivityFeedItemSchema.parse({
	id: "work:receipt",
	actor: "Cedar",
	sentence: "The supplier review finished.",
	source: `/work/items/${projectId}`,
	projectId,
	workItemId: projectId,
	tediId: null,
	kind: "result",
	classId: "supplier:result",
	importance: "high",
	at: "2026-10-17T12:00:00.000Z",
	dueAt: null,
	needsAction: false,
	stalled: false,
	done: true,
	explanation: "The attempt settled with its receipt.",
	reactions: ["more", "why", "mute", "comment", "work"],
});
let sourceState: FeedSourceState | undefined;
vi.mock("./activity-feed-sources", () => ({
	ActivityFeedSources: ({
		onUpdate,
		projectId: id = "organization",
	}: {
		projectId?: string;
		onUpdate: (id: string, state: FeedSourceState) => void;
	}) => {
		useEffect(
			() =>
				onUpdate(
					id,
					sourceState ?? {
						items: [row],
						loading: false,
						failed: false,
						more: false,
					},
				),
			[id, onUpdate],
		);
		return null;
	},
}));
afterEach(() => {
	sourceState = undefined;
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

it.each(["projects", "organization"] as const)(
	"shows receipt-backed %s activity, explains it and persists a personal mute",
	async (scope) => {
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity, retry: false } },
		});
		client.setQueryData(
			osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
			learnDecisions({
				organizationId: "fictional-acme",
				personId: "fictional-acme-user",
				events: [],
				config: DecisionLearningConfigSchema.parse({}),
				now: new Date(),
			}),
		);
		const initial = {
			preferences: DEFAULT_OS_USER_PREFERENCES,
			revision: 0,
			source: "default" as const,
			updatedAt: null,
		};
		client.setQueryData(userPreferencesQueryOptions().queryKey, initial);
		client.setQueryData(
			osQuery.learningFeedback.listInteractions.queryOptions({
				input: { scopeKind: "personal", eventKind: "edited", limit: 100 },
			}).queryKey,
			{ events: [] },
		);
		const record = vi
			.mocked(osApi.learningFeedback.recordInteraction)
			.mockResolvedValue({} as never);
		vi.mocked(osApi.learningFeedback.listInteractions).mockResolvedValue({
			events: [],
		});
		vi.mocked(osApi.userSettings.getPreferences).mockResolvedValue(initial);
		const save = vi
			.mocked(osApi.userSettings.updatePreferences)
			.mockImplementation(async (input) => ({
				...initial,
				revision: 1,
				source: "stored",
				preferences: input.preferences,
			}));
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<ActivityFeedApp
							config={ActivityFeedConfigSchema.parse({
								version: 1,
								scope,
								projects:
									scope === "organization"
										? []
										: [{ id: projectId, label: "Pine Studio" }],
							})}
						/>
					</QueryClientProvider>,
				),
			);
			await vi.waitFor(async () => {
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
				expect(host.textContent).toContain(row.sentence);
			});
			expect(host.querySelectorAll(".fd-preview")).toHaveLength(0);
			expect(host.textContent).not.toContain("Loading your activity");
			expect(host.textContent).toContain(row.sentence);
			expect(host.querySelector(".ft-post-link")?.getAttribute("href")).toBe(
				row.source,
			);
			expect(host.querySelector(".ft-byline")?.textContent).toMatch(
				scope === "organization" ? /^Cedar· / : /^Cedar· Pine Studio· /,
			);
			expect(host.querySelector(".ft-details")).toBeNull();
			const button = (label: string) =>
				[...host.querySelectorAll("button")].find(
					(b) =>
						b.getAttribute("aria-label") === label || b.textContent === label,
				)!;
			await act(async () => button("Receipt").click());
			expect(host.textContent).toContain(
				"The attempt settled with its receipt.",
			);
			await act(async () => button("Not important").click());
			expect(record).toHaveBeenCalledWith(
				expect.objectContaining({
					eventKind: "rejected",
					scope: { kind: "personal" },
					metadata: expect.objectContaining({ source: row.source }),
				}),
			);
			expect(save).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedRevision: 0,
					preferences: expect.objectContaining({
						activityFeed: expect.objectContaining({
							hiddenIds: [row.id],
						}),
					}),
				}),
			);
			expect(host.querySelector("article")).toBeNull();
			await act(async () => button("Everything").click());
			expect(host.querySelector("article")?.textContent).toContain(
				row.sentence,
			);
			const feed = host.querySelector<HTMLElement>(
				'[data-workspace-app-entry="activity-feed"]',
			)!;
			feed.focus();
			await act(async () =>
				feed.dispatchEvent(
					new KeyboardEvent("keydown", { key: "j", bubbles: true }),
				),
			);
			expect(document.activeElement).toBe(
				host.querySelector("[data-focus-row]"),
			);
		} finally {
			await act(async () => root.unmount());
			client.clear();
		}
	},
);

it("applies navigation filters before the attention budget, preserves scope, and updates without remounting", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	const model = learnDecisions({
		organizationId: "fictional-acme",
		personId: "fictional-person",
		events: [],
		now: new Date(),
	});
	client.setQueryData(
		osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
		model,
	);
	client.setQueryData(userPreferencesQueryOptions().queryKey, {
		preferences: DEFAULT_OS_USER_PREFERENCES,
		revision: 0,
		source: "default",
		updatedAt: null,
	});
	vi.mocked(osApi.learningFeedback.listInteractions).mockResolvedValue({
		events: [],
	});
	vi.mocked(osApi.userSettings.updatePreferences).mockClear();
	const stalled = {
		...row,
		id: "work:stalled",
		sentence: "The supplier review stalled.",
		done: false,
		stalled: true,
	};
	const pending = {
		...row,
		id: "work:pending",
		sentence: "The supplier review is running.",
		done: false,
	};
	sourceState = {
		items: [
			row,
			stalled,
			pending,
			{
				...row,
				id: "other-project",
				projectId: "22222222-2222-4222-8222-222222222222",
			},
		],
		loading: false,
		failed: false,
		more: false,
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const change = vi.fn();
	const render = async (
		filter: "history" | "stalled" | "queue",
		day?: string,
	) => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<ActivityFeedApp
						config={ActivityFeedConfigSchema.parse({
							version: 1,
							scope: "organization",
							projects: [],
						})}
						navigation={{ filter, projectId, day, onFilterChange: change }}
					/>
				</QueryClientProvider>,
			),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	};
	try {
		await render("history");
		expect(osApi.userSettings.updatePreferences).not.toHaveBeenCalled();
		expect(
			host.querySelector('[role="feed"]')?.getAttribute("aria-label"),
		).toBe("Finished work");
		expect(
			[...host.querySelectorAll("article")].map((n) =>
				n.getAttribute("aria-label"),
			),
		).toEqual([row.sentence]);
		expect(host.textContent).not.toContain("Needs you");
		await render("stalled");
		expect(
			[...host.querySelectorAll("article")].map((n) =>
				n.getAttribute("aria-label"),
			),
		).toEqual([stalled.sentence]);
		await render("queue");
		expect(
			[...host.querySelectorAll("article")].map((n) =>
				n.getAttribute("aria-label"),
			),
		).toEqual([pending.sentence]);
		await render("history", "2026-10-16");
		expect(host.querySelectorAll("article")).toHaveLength(0);
		expect(host.textContent).toContain(
			"No finished work matches these filters.",
		);
		const clear = [...host.querySelectorAll("button")].find(
			(b) => b.textContent === "Show For you",
		)!;
		await act(async () => clear.click());
		expect(change).toHaveBeenCalledWith("all");
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
