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

vi.mock("@/lib/api", () => ({
	osApi: {
		learningFeedback: { recordInteraction: vi.fn(), listInteractions: vi.fn() },
		userSettings: { getPreferences: vi.fn(), updatePreferences: vi.fn() },
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
		projectId: id,
	}: {
		projectId: string;
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

it("shows receipt-backed activity, explains it and persists a personal mute", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
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
							projects: [{ id: projectId, label: "Pine Studio" }],
						})}
					/>
				</QueryClientProvider>,
			),
		);
		expect(
			host.querySelector('a[href="/work/items/' + projectId + '"]'),
		).not.toBeNull();
		expect(host.textContent).toContain(row.sentence);
		const button = (label: string) =>
			[...host.querySelectorAll("button")].find(
				(b) => b.textContent === label,
			)!;
		await act(async () => button("Why?").click());
		expect(host.textContent).toContain("The attempt settled with its receipt.");
		await act(async () => button("Not for me").click());
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
						mutedClasses: [row.classId],
					}),
				}),
			}),
		);
		expect(host.querySelector("article")).toBeNull();
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
