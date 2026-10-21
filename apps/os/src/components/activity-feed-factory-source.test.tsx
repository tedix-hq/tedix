import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import type {
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import type { FeedSourceState } from "./activity-feed-sources";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
	userPreferencesQueryOptions,
} from "@/lib/os-query-options";
import { ActivityFeedFactorySource } from "./activity-feed-factory-source";

it("projects an existing fictional factory sheet with its revision and the same reactions", async () => {
	const harness = factoryHarness();
	const { client, onUpdate } = harness;
	const outputId = siblingId;
	client.setQueryData(canvasOutputsQueryOptions(workspaceId).queryKey, {
		items: [output(outputId)],
		truncated: false,
	});
	client.setQueryData(
		outputDetailQueryOptions(outputId).queryKey,
		detail(outputId, 3, {
			kind: "sheet",
			columns: [
				"Source",
				"Why",
				"Useful",
				"Reason",
				"Done",
				"Result",
				"Due at",
			],
			rows: [
				[
					"https://supplier.example/receipt",
					"The delivery date changed.",
					"",
					"",
					"yes",
					"",
				],
				[
					"https://supplier.example/draft",
					"A reply is ready for review.",
					"",
					"",
					"",
					"Review the supplier reply.",
					"2099-10-22",
				],
				[
					"https://supplier.example/question",
					"Choose the fictional delivery date.",
					"",
					"",
					"",
					"",
				],
			],
		}),
	);
	try {
		await harness.mount();
		expect(onUpdate).toHaveBeenLastCalledWith(
			"suppliers",
			expect.objectContaining({
				loading: false,
				failed: false,
				items: [
					expect.objectContaining({
						sentence: "The delivery date changed.",
						needsAction: false,
						done: true,
						reactions: ["more", "why", "mute", "comment", "work"],
						explanation: expect.stringContaining("revision 3, row 1"),
						source: expect.stringContaining(outputId),
					}),
					expect.objectContaining({
						sentence: "Review the supplier reply.",
						needsAction: true,
						done: false,
					}),
					expect.objectContaining({
						sentence: "Choose the fictional delivery date.",
						kind: "decision",
						needsAction: true,
						done: false,
					}),
				],
			}),
		);
	} finally {
		await harness.close();
	}
});

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siblingId = "22222222-2222-4222-8222-222222222222";
const recoveringId = "33333333-3333-4333-8333-333333333333";
const columns = ["Source", "Why", "Useful", "Reason", "Done", "Result"];

function sheet(why: string): OsOutputContent {
	return {
		kind: "sheet",
		columns,
		rows: [["https://supplier.example/receipt", why, "", "", "yes", ""]],
	};
}

function output(id: string) {
	return {
		id,
		organizationId: "org_pine",
		workspaceId,
		kind: "sheet" as const,
		title: `Supplier cards ${id === siblingId ? "yesterday" : "today"}`,
		status: "active" as const,
		currentRevisionId: id,
		createdByKind: "user" as const,
		createdById: "pine-user",
		createdAt: "2026-10-17T12:00:00.000Z",
		updatedAt: "2026-10-17T12:00:00.000Z",
	};
}

function detail(
	id: string,
	revision: number,
	content: OsOutputContent,
): {
	output: OsOutput;
	currentRevision: OsOutputRevision;
	authoringHomeRun: null;
} {
	const revisionId =
		id === siblingId
			? "44444444-4444-4444-8444-444444444444"
			: `55555555-5555-4555-8555-${String(revision).padStart(12, "0")}`;
	return {
		output: { ...output(id), currentRevisionId: revisionId },
		currentRevision: {
			id: revisionId,
			organizationId: "org_pine",
			outputId: id,
			revision,
			content,
			note: null,
			producedBy: null,
			accessEnvelope: { version: 1, sources: [] },
			createdByKind: "user",
			createdById: "pine-user",
			createdAt: "2026-10-17T12:00:00.000Z",
		},
		authoringHomeRun: null,
	};
}

function factoryHarness() {
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
						result: "Result",
					},
					doIt: "approve",
				},
			},
		],
	}).factorySources[0]!;
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(userPreferencesQueryOptions().queryKey, {
		preferences: { ...DEFAULT_OS_USER_PREFERENCES, timezone: "Europe/Berlin" },
		source: "stored",
		revision: 1,
		updatedAt: null,
	});
	client.setQueryData(canvasOutputsQueryOptions(workspaceId).queryKey, {
		items: [output(siblingId), output(recoveringId)],
		truncated: false,
	});
	client.setQueryData(
		outputDetailQueryOptions(siblingId).queryKey,
		detail(siblingId, 3, sheet("The sibling delivery date changed.")),
	);
	const onUpdate = vi.fn<(key: string, state: FeedSourceState) => void>();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	return {
		client,
		onUpdate,
		async mount() {
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
		},
		async close() {
			await act(async () => root.unmount());
			client.clear();
			host.remove();
		},
	};
}

const siblingItem = {
	id: `factory:${siblingId}:0`,
	sentence: "The sibling delivery date changed.",
	source: `/workspace/${workspaceId}?workpiece=output:${siblingId}&pane=workpiece`,
	projectId: workspaceId,
	explanation: `The sibling delivery date changed.\nhttps://supplier.example/receipt\nOutput ${siblingId}, revision 3, row 1`,
};

it("retains the valid sibling through a pending detail, a query error and a later revision", async () => {
	const harness = factoryHarness();
	const { client, onUpdate } = harness;
	const key = outputDetailQueryOptions(recoveringId).queryKey;
	let rejectRead!: (error: Error) => void;
	const pending = client
		.fetchQuery({
			queryKey: key,
			queryFn: () =>
				new Promise<never>((_resolve, reject) => {
					rejectRead = reject;
				}),
			retry: false,
		})
		.catch(() => undefined);
	try {
		await harness.mount();
		expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
			items: [expect.objectContaining(siblingItem)],
			loading: true,
			failed: false,
			more: false,
		});
		await act(async () => {
			rejectRead(
				Object.assign(new Error("Fictional sheet unavailable"), {
					code: "NOT_FOUND",
				}),
			);
			await pending;
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
			items: [expect.objectContaining(siblingItem)],
			loading: false,
			failed: true,
			more: false,
		});
		const callsBeforeRecovery = onUpdate.mock.calls.length;
		await act(async () => {
			client.setQueryData(
				key,
				detail(recoveringId, 8, sheet("The second delivery recovered.")),
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(onUpdate.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);
		expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
			items: [
				expect.objectContaining(siblingItem),
				expect.objectContaining({
					id: `factory:${recoveringId}:0`,
					sentence: "The second delivery recovered.",
					source: `/workspace/${workspaceId}?workpiece=output:${recoveringId}&pane=workpiece`,
					explanation: expect.stringContaining(
						`Output ${recoveringId}, revision 8, row 1`,
					),
				}),
			],
			loading: false,
			failed: false,
			more: false,
		});
	} finally {
		await harness.close();
	}
});

it.each([
	["a non-sheet revision", { kind: "document", blocks: [] }],
	[
		"missing required columns",
		{
			kind: "sheet",
			columns: ["Source"],
			rows: [["https://supplier.example/broken"]],
		},
	],
] satisfies [string, OsOutputContent][])(
	"preserves sibling provenance with %s and recovers on a new revision",
	async (_label, content) => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
		const harness = factoryHarness();
		const { client, onUpdate } = harness;
		const key = outputDetailQueryOptions(recoveringId).queryKey;
		client.setQueryData(key, detail(recoveringId, 4, content));
		try {
			await harness.mount();
			expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
				items: [expect.objectContaining(siblingItem)],
				loading: false,
				failed: true,
				more: false,
			});
			const callsBeforeRecovery = onUpdate.mock.calls.length;
			await act(async () => {
				vi.setSystemTime(new Date("2026-10-21T12:00:01Z"));
				client.setQueryData(
					key,
					detail(recoveringId, 9, sheet("The corrected sheet arrived.")),
				);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(onUpdate.mock.calls.length).toBeGreaterThan(callsBeforeRecovery);
			expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
				items: [
					expect.objectContaining(siblingItem),
					expect.objectContaining({
						id: `factory:${recoveringId}:0`,
						sentence: "The corrected sheet arrived.",
						explanation: expect.stringContaining(
							`Output ${recoveringId}, revision 9, row 1`,
						),
					}),
				],
				loading: false,
				failed: false,
				more: false,
			});
		} finally {
			await harness.close();
			vi.useRealTimers();
		}
	},
);

it("keeps future deadlines visible and releases scheduled rows on the viewer's calendar day", async () => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(new Date("2026-10-21T21:59:59Z"));
	const harness = factoryHarness();
	const { client, onUpdate } = harness;
	client.setQueryData(
		outputDetailQueryOptions(recoveringId).queryKey,
		detail(recoveringId, 6, {
			kind: "sheet",
			columns: [...columns, "Due at", "Show from"],
			rows: [
				[
					"deadline",
					"A future deadline stays visible.",
					"",
					"",
					"",
					"",
					"2099-10-22",
					"",
				],
				["today", "Today's scheduled card.", "", "", "", "", "", "2026-10-21"],
				[
					"tomorrow",
					"Tomorrow's scheduled card.",
					"",
					"",
					"",
					"",
					"",
					"2026-10-22",
				],
				[
					"timestamp",
					"A timestamp on tomorrow's local day.",
					"",
					"",
					"",
					"",
					"",
					"2026-10-21T22:00:00Z",
				],
			],
		}),
	);
	try {
		await harness.mount();
		const visible = [
			expect.objectContaining(siblingItem),
			...[0, 1].map((row) =>
				expect.objectContaining({
					id: `factory:${recoveringId}:${row}`,
					explanation: expect.stringContaining(
						`Output ${recoveringId}, revision 6, row ${row + 1}`,
					),
				}),
			),
		];
		expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
			items: visible,
			loading: false,
			failed: false,
			more: false,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(onUpdate).toHaveBeenLastCalledWith("suppliers", {
			items: [
				...visible,
				...[2, 3].map((row) =>
					expect.objectContaining({
						id: `factory:${recoveringId}:${row}`,
						explanation: expect.stringContaining(
							`Output ${recoveringId}, revision 6, row ${row + 1}`,
						),
					}),
				),
			],
			loading: false,
			failed: false,
			more: false,
		});
	} finally {
		await harness.close();
		vi.useRealTimers();
	}
});
