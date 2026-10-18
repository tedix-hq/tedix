import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { ActivityFeedFactorySource } from "./activity-feed-factory-source";

it("projects an existing fictional factory sheet with its revision and the same reactions", async () => {
	const workspaceId = "11111111-1111-4111-8111-111111111111";
	const outputId = "22222222-2222-4222-8222-222222222222";
	const binding = ActivityFeedConfigSchema.parse({
		version: 1,
		projects: [{ id: workspaceId, label: "Pine Studio" }],
		factorySources: [
			{
				projectId: workspaceId,
				source: {
					label: "Suppliers",
					workspaceId,
					cardSheetPrefix: "Supplier cards ",
					columns: {
						source: "Source",
						why: "Why",
						useful: "Useful",
						reason: "Reason",
						done: "Done",
					},
					doIt: "approve",
				},
			},
		],
	}).factorySources[0]!;
	const output = {
		id: outputId,
		organizationId: "org_pine",
		workspaceId,
		kind: "sheet" as const,
		title: "Supplier cards today",
		status: "active" as const,
		currentRevisionId: outputId,
		createdByKind: "user" as const,
		createdById: "pine-user",
		createdAt: "2026-10-17T12:00:00.000Z",
		updatedAt: "2026-10-17T12:00:00.000Z",
	};
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(canvasOutputsQueryOptions(workspaceId).queryKey, {
		items: [output],
		truncated: false,
	});
	client.setQueryData(outputDetailQueryOptions(outputId).queryKey, {
		output,
		currentRevision: {
			id: outputId,
			organizationId: "org_pine",
			outputId,
			revision: 3,
			content: {
				kind: "sheet",
				columns: ["Source", "Why", "Useful", "Reason", "Done"],
				rows: [
					[
						"https://supplier.example/receipt",
						"The delivery date changed.",
						"",
						"",
						"yes",
					],
				],
			},
			note: null,
			producedBy: null,
			accessEnvelope: { version: 1, sources: [] },
			createdByKind: "user",
			createdById: "pine-user",
			createdAt: output.createdAt,
		},
		authoringHomeRun: null,
	});
	const onUpdate = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<ActivityFeedFactorySource
						binding={binding}
						sourceKey="suppliers"
						onUpdate={onUpdate}
					/>
				</QueryClientProvider>,
			),
		);
		expect(onUpdate).toHaveBeenLastCalledWith(
			"suppliers",
			expect.objectContaining({
				loading: false,
				failed: false,
				items: [
					expect.objectContaining({
						sentence: "The delivery date changed.",
						needsAction: true,
						done: false,
						reactions: ["more", "why", "mute", "comment", "work"],
						explanation: expect.stringContaining("revision 3, row 1"),
						source: expect.stringContaining(outputId),
					}),
				],
			}),
		);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	}
});
