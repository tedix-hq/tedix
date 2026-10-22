import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it } from "vite-plus/test";
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import {
	activeWorkspacesQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
	userProfileQueryOptions,
	osQuery,
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
	let auditSampleRate = 0;
	function Queue() {
		const queue = useFactoryCardCount(sources, undefined, undefined, {
			"factory:Inbox:opportunity": {
				autoApprove: true,
				unchangedThreshold: 5,
				auditSampleRate,
			},
		});
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
		const rerender = async () => {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<Queue />
					</QueryClientProvider>,
				),
			);
		};
		sources[0]!.scoring = CardReviewSourceSchema.parse({
			...sources[0],
			scoring: { agentDecidableClasses: ["opportunity"] },
		}).scoring;
		client.setQueryData(userProfileQueryOptions().queryKey, {
			id: "pine",
			email: "pine@example.test",
			name: null,
			avatarUrl: null,
			revision: 1,
			updatedAt: null,
		});
		client.setQueryData(
			osQuery.learningFeedback.listInteractions.queryOptions({
				input: {
					scopeKind: "personal",
					limit: 200,
					surfaces: ["decision_deck", "decision_learning"],
				},
			}).queryKey,
			{
				events: Array.from({ length: 5 }, (_, i): LearningInteractionEvent => ({
					id: `event-${i}`,
					organizationId: "org_pine",
					tediId: null,
					signalClass: "quality",
					scopeKind: "personal",
					scopeId: "pine",
					issueKey: null,
					targetType: "output",
					threadId: null,
					runId: null,
					createdAt: "2026-10-20T10:00:00Z",
					clientEventId: `client-${i}`,
					actorType: "user",
					actorId: "pine",
					targetId: `earlier-${i}`,
					eventKind: "accepted",
					surface: "decision_deck",
					occurredAt: `2026-10-20T10:0${i}:00Z`,
					metadata: {
						decisionClass: "factory:Inbox:opportunity",
						decisionChoice: "do_it",
					},
				})),
			},
		);
		await rerender();
		expect(JSON.parse(host.textContent!)).toEqual([
			{ key: `${outputs[2]!.id}:0`, sourceIndex: 1 },
		]);
		auditSampleRate = 1;
		await rerender();
		expect(JSON.parse(host.textContent!)).toHaveLength(2);
		auditSampleRate = 0;
		sources[0]!.protectedEffects = ["message"];
		await rerender();
		expect(JSON.parse(host.textContent!)).toHaveLength(2);
		// Scoring collapses the repeated Inbox card; restore the unscored fixture.
		sources[0]!.scoring = undefined;
		await rerender();
		expect(JSON.parse(host.textContent!)).toHaveLength(3);
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
