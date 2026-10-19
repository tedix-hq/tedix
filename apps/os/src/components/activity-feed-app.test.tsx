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
				onUpdate(id, {
					items: [row],
					loading: false,
					failed: false,
					more: false,
				}),
			[id, onUpdate],
		);
		return null;
	},
}));
afterEach(() => {
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
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
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
			await act(async () =>
				document.dispatchEvent(
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
