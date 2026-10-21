import { createHash, webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { osApi } from "./api";
import { useDeckRoutingAudit } from "./use-deck-routing-audit";

type Interaction = Parameters<
	typeof osApi.learningFeedback.recordInteraction
>[0];
type Routing = Parameters<typeof useDeckRoutingAudit>[0][number];
const recordInteraction = vi.hoisted(() =>
	vi.fn<(input: Interaction) => Promise<void>>(),
);
vi.mock("./api", () => ({
	osApi: { learningFeedback: { recordInteraction } },
}));

const admitted: Routing = {
	id: "candidate-opportunity",
	destination: "deck",
	reason: "valuable_opportunity",
	policyVersion: 1,
	classId: "opportunity",
};
const withheld: Routing = {
	id: "candidate-filing",
	destination: "feed",
	reason: "routine_filing",
	policyVersion: 1,
	classId: "routine",
};
const expectedEventId = `deck-routing:${createHash("sha256")
	.update(
		'{"id":"candidate-opportunity","destination":"deck","reason":"valuable_opportunity","policyVersion":1,"classId":"opportunity"}',
	)
	.digest("hex")}`;

const mounts: {
	root: ReturnType<typeof createRoot>;
	host: HTMLDivElement;
	client: QueryClient;
	unmounted: boolean;
}[] = [];

function Reader({ rows }: { rows: readonly Routing[] }) {
	const callbacks = useDeckRoutingAudit(rows);
	expect(callbacks).toBeUndefined();
	return null;
}

function mount(client = new QueryClient()) {
	const host = document.createElement("div");
	document.body.append(host);
	const entry = { root: createRoot(host), host, client, unmounted: false };
	mounts.push(entry);
	return {
		async render(rows: readonly Routing[], readers = 1) {
			await act(async () => {
				entry.root.render(
					<QueryClientProvider client={client}>
						{Array.from({ length: readers }, (_, index) => (
							<Reader key={index} rows={rows} />
						))}
					</QueryClientProvider>,
				);
			});
		},
		async unmount() {
			await act(async () => entry.root.unmount());
			entry.unmounted = true;
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto);
	recordInteraction.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
	for (const entry of mounts.splice(0)) {
		if (!entry.unmounted) await act(async () => entry.root.unmount());
		entry.client.clear();
		entry.host.remove();
	}
	vi.unstubAllGlobals();
});

it("deduplicates simultaneous readers while a receipt is pending and after it succeeds", async () => {
	const write = deferred();
	recordInteraction.mockReturnValue(write.promise);
	const view = mount();
	await view.render([admitted], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
	expect(recordInteraction.mock.calls[0]?.[0].clientEventId).toBe(
		expectedEventId,
	);
	await view.render([{ ...admitted }], 2);
	expect(recordInteraction).toHaveBeenCalledTimes(1);
	await act(async () => {
		write.resolve();
		await write.promise;
	});
	await view.render([], 2);
	await view.render([admitted], 2);
	expect(recordInteraction).toHaveBeenCalledTimes(1);
});

it("records admitted and withheld routing as personal delivery telemetry without decision callbacks", async () => {
	await mount().render([admitted, withheld], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(2));
	for (const row of [admitted, withheld]) {
		expect(recordInteraction).toHaveBeenCalledWith({
			clientEventId: expect.stringMatching(/^deck-routing:[a-f0-9]{64}$/),
			scope: { kind: "personal" },
			surface: "decision_deck_routing",
			eventKind: "delivered",
			issueKey: `deck:${row.classId}`,
			targetType: "deck_candidate",
			targetId: row.id,
			metadata: {
				destination: row.destination,
				routingReason: row.reason,
				policyVersion: row.policyVersion,
				decisionClass: row.classId,
				classId: row.classId,
			},
		});
	}
});

it("creates distinct receipts when the reason or policy changes", async () => {
	const view = mount();
	await view.render([admitted], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
	const changedReason = { ...admitted, reason: "critical_boundary" };
	await view.render([changedReason], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(2));
	const changedPolicy = { ...changedReason, policyVersion: 2 };
	await view.render([changedPolicy], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(3));
	const receipts = recordInteraction.mock.calls.map(([input]) => input);
	expect(new Set(receipts.map((input) => input.clientEventId)).size).toBe(3);
	expect(receipts.map((input) => input.metadata)).toEqual([
		expect.objectContaining({
			routingReason: admitted.reason,
			policyVersion: 1,
		}),
		expect.objectContaining({
			routingReason: changedReason.reason,
			policyVersion: 1,
		}),
		expect.objectContaining({
			routingReason: changedReason.reason,
			policyVersion: 2,
		}),
	]);
	await view.render([admitted], 2);
	expect(recordInteraction).toHaveBeenCalledTimes(3);
});

it("keeps deduplication local to each QueryClient while preserving the event ID", async () => {
	await mount().render([admitted], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
	await mount().render([admitted], 2);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(2));
	expect(
		recordInteraction.mock.calls.map(([input]) => input.clientEventId),
	).toEqual([expectedEventId, expectedEventId]);
});

it("retries a rejected receipt with the same event ID when routing rows change", async () => {
	recordInteraction.mockRejectedValueOnce(new Error("local write rejected"));
	const view = mount();
	await view.render([admitted]);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
	await act(async () => {
		await expect(recordInteraction.mock.results[0]?.value).rejects.toThrow(
			"local write rejected",
		);
	});
	await view.render([admitted, withheld]);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(3));
	const retries = recordInteraction.mock.calls
		.map(([input]) => input)
		.filter((input) => input.targetId === admitted.id);
	expect(retries).toHaveLength(2);
	expect(retries[0]).toEqual(retries[1]);
	expect(retries[1]?.clientEventId).toBe(expectedEventId);
	await view.render([admitted]);
	expect(recordInteraction).toHaveBeenCalledTimes(3);
});

it("does not start later rows after unmount during a deferred first write", async () => {
	const write = deferred();
	recordInteraction.mockReturnValueOnce(write.promise);
	const client = new QueryClient();
	const view = mount(client);
	await view.render([admitted, withheld]);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
	await view.unmount();
	await act(async () => {
		write.resolve();
		await write.promise;
	});
	expect(recordInteraction).toHaveBeenCalledTimes(1);
	expect(recordInteraction.mock.calls[0]?.[0].targetId).toBe(admitted.id);
	await mount(client).render([admitted, withheld]);
	await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(2));
	expect(recordInteraction.mock.calls[1]?.[0].targetId).toBe(withheld.id);
});
