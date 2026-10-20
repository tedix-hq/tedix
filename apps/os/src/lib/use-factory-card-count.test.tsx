import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vite-plus/test";
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import {
	activeWorkspacesQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "./os-query-options";
import { useFactoryCardCount } from "./use-factory-card-count";

it("keeps row identities across factory runs and reconciles a verdict through the canonical output cache", async () => {
	const workspaceId = "11111111-1111-4111-8111-111111111111";
	const sources = ["Inbox", "Social"].map((label) =>
		CardReviewSourceSchema.parse({
			label,
			workspaceId,
			cardSheetPrefix: `${label} cards `,
			columns: {
				source: "Source",
				type: "Type",
				why: "Why",
				useful: "Useful?",
				reason: "Reason",
				done: "Done?",
			},
			doIt: "approve",
		}),
	);
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false, staleTime: Infinity },
		},
	});
	client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
		items: [
			{
				id: workspaceId,
				organizationId: "org_pine",
				name: "Pine",
				description: null,
				status: "active",
				sourceBlueprintId: null,
				sourceBlueprintRevisionId: null,
				sourceBlueprintRevisionNumber: null,
				instantiationPreflight: null,
				rollbackReference: null,
				blueprintDecision: null,
				createdByKind: "user",
				createdById: "pine",
				createdAt: "2026-10-18T00:00:00Z",
				updatedAt: "2026-10-18T00:00:00Z",
				visibility: "org",
				ownerUserId: null,
			},
		],
		truncated: false,
	});
	const outputs = ["Inbox", "Inbox", "Social"].map((label, index) => ({
		id: `22222222-2222-4222-8222-00000000000${index}`,
		workspaceId,
		kind: "sheet" as const,
		status: "active" as const,
		organizationId: "org_pine",
		currentRevisionId: workspaceId,
		createdByKind: "user" as const,
		createdById: "pine",
		updatedAt: "2026-10-18T00:00:00Z",
		title: `${label} cards ${index}`,
		createdAt: `2026-10-18T0${index}:00:00.000Z`,
	}));
	client.setQueryData(canvasOutputsQueryOptions(workspaceId).queryKey, {
		items: outputs,
		truncated: false,
	});
	for (const output of outputs)
		client.setQueryData(outputDetailQueryOptions(output.id).queryKey, {
			output,
			authoringHomeRun: null,
			currentRevision: {
				id: workspaceId,
				organizationId: "org_pine",
				outputId: output.id,
				note: null,
				producedBy: null,
				accessEnvelope: { version: 1, sources: [] },
				createdByKind: "user",
				createdById: "pine",
				createdAt: output.createdAt,
				revision: 1,
				content: {
					kind: "sheet" as const,
					columns: [
						"Type",
						"Source",
						"Why",
						"Useful?",
						"Reason",
						"Done?",
						"Due at",
					],
					rows: [
						[
							"opportunity",
							"https://example.com/card",
							"Review this fictional opportunity.",
							"",
							"",
							"",
							"2099-10-22",
						],
					],
				},
			},
		});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Queue() {
		const queue = useFactoryCardCount(sources);
		return (
			<output>
				{JSON.stringify(
					queue.cards.map((card) => ({
						key: card.key,
						sourceIndex: card.sourceIndex,
					})),
				)}
			</output>
		);
	}
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Queue />
				</QueryClientProvider>,
			),
		);
		expect(JSON.parse(host.textContent!)).toEqual([
			{ key: `${outputs[1]!.id}:0`, sourceIndex: 0 },
			{ key: `${outputs[0]!.id}:0`, sourceIndex: 0 },
			{ key: `${outputs[2]!.id}:0`, sourceIndex: 1 },
		]);
		await act(async () => {
			const options = outputDetailQueryOptions(outputs[2]!.id);
			client.setQueryData(options.queryKey, (previous) =>
				previous
					? {
							...previous,
							currentRevision: {
								...previous.currentRevision,
								revision: 2,
								content: {
									kind: "sheet" as const,
									columns: [
										"Type",
										"Source",
										"Why",
										"Useful?",
										"Reason",
										"Done?",
									],
									rows: [
										[
											"opportunity",
											"https://example.com/card",
											"Review this fictional opportunity.",
											"yes",
											"",
											"",
										],
									],
								},
							},
						}
					: previous,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(JSON.parse(host.textContent!)).toHaveLength(2);
		expect(host.textContent).not.toContain(outputs[2]!.id);
	} finally {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	}
});
