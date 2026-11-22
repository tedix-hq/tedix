import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { osApi } from "./api";
import { userProfileQueryOptions } from "./os-query-options";
import { useDeckRoutingAudit } from "./use-deck-routing-audit";

type Routing = Parameters<typeof useDeckRoutingAudit>[0][number];
const recordDeckRoutings = vi.hoisted(() =>
	vi.fn<typeof osApi.learningFeedback.recordDeckRoutings>(),
);
vi.mock("./api", async (original) => {
	const actual = await original<typeof import("./api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "learningFeedback"
					? new Proxy(target.learningFeedback, {
							get: (learning, procedure) =>
								procedure === "recordDeckRoutings"
									? recordDeckRoutings
									: Reflect.get(learning, procedure),
						})
					: Reflect.get(target, key),
		}),
	};
});
const admitted: Routing = {
	id: "candidate-opportunity",
	destination: "deck",
	reason: "valuable_opportunity",
	policyVersion: 1,
	classId: "opportunity",
};
const withheld: Routing = {
	...admitted,
	id: "candidate-filing",
	destination: "feed",
	reason: "routine_filing",
	classId: "routine",
};
const mounts: {
	root: ReturnType<typeof createRoot>;
	host: HTMLDivElement;
	client: QueryClient;
}[] = [];
function Reader({ rows }: { rows: readonly Routing[] }) {
	useDeckRoutingAudit(rows);
	return null;
}
function mount(userId = "person-one", readers = 2) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false, staleTime: Infinity },
		},
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: userId,
		email: "person@example.test",
		name: null,
		avatarUrl: null,
		welcomeCompleted: true,
		revision: 1,
		updatedAt: null,
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounts.push({ root, host, client });
	return async (rows: readonly Routing[]) => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<Reader rows={rows} />
					{readers > 1 && <Reader rows={rows} />}
				</QueryClientProvider>,
			),
		);
	};
}
beforeEach(() => {
	localStorage.clear();
	recordDeckRoutings.mockReset().mockResolvedValue({ recorded: 1 });
	// Separate QueryClients model separate tabs; their lock queue shares persistent storage.
	const queues = new Map<string, Promise<unknown>>();
	vi.stubGlobal("navigator", {
		locks: {
			request: (key: string, work: () => Promise<void>) => {
				const result = (queues.get(key) ?? Promise.resolve()).then(work);
				queues.set(key, result);
				return result;
			},
		},
	});
});
afterEach(async () => {
	for (const { root, host, client } of mounts.splice(0)) {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
it("batches new cards and skips reloads, simultaneous tabs and changed routing metadata", async () => {
	let finish!: () => void;
	const write = new Promise<{ recorded: number }>((resolve) => {
		finish = () => resolve({ recorded: 2 });
	});
	recordDeckRoutings.mockReturnValueOnce(write);
	const view = mount();
	await view([admitted, withheld]);
	await mount()([admitted, withheld]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(1));
	expect(recordDeckRoutings).toHaveBeenCalledWith({
		routes: [admitted, withheld],
	});
	await act(async () => {
		finish();
		await write;
	});
	await view([{ ...admitted, reason: "critical", policyVersion: 2 }]);
	await mount()([admitted, withheld]);
	expect(recordDeckRoutings).toHaveBeenCalledTimes(1);
	const added = { ...admitted, id: "new-card" };
	await view([admitted, withheld, added]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(2));
	expect(recordDeckRoutings).toHaveBeenLastCalledWith({ routes: [added] });
});
it("does not suppress another person's receipts on a shared browser", async () => {
	await mount()([admitted]);
	await mount("person-two")([admitted]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(2));
});
it("retries failed batches without marking them as delivered", async () => {
	recordDeckRoutings.mockRejectedValueOnce(new Error("unavailable"));
	const view = mount("person-one", 1);
	await view([admitted]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(1));
	expect(localStorage.length).toBe(0);
	await view([admitted, withheld]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(2));
	expect(recordDeckRoutings).toHaveBeenLastCalledWith({
		routes: [admitted, withheld],
	});
});
it("splits a backlog at the server's batch bound", async () => {
	await mount()(
		Array.from({ length: 201 }, (_, i) => ({ ...admitted, id: `card-${i}` })),
	);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(3));
	expect(
		recordDeckRoutings.mock.calls.map(([input]) => input.routes.length),
	).toEqual([100, 100, 1]);
});
it("retains in-memory deduplication when persistent storage is denied", async () => {
	vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
		throw new Error("denied");
	});
	vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
		throw new Error("denied");
	});
	const view = mount();
	await view([admitted]);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(1));
	await view([]);
	await view([admitted]);
	expect(recordDeckRoutings).toHaveBeenCalledTimes(1);
});

it("stops the remaining backlog when its reader is disabled during a pending batch", async () => {
	let finish!: () => void;
	const write = new Promise<{ recorded: number }>((resolve) => {
		finish = () => resolve({ recorded: 100 });
	});
	recordDeckRoutings.mockReturnValueOnce(write);
	const view = mount("person-one", 1);
	const rows = Array.from({ length: 101 }, (_, i) => ({
		...admitted,
		id: `card-${i}`,
	}));
	await view(rows);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(1));
	await view([]);
	await act(async () => {
		finish();
		await write;
	});
	expect(recordDeckRoutings).toHaveBeenCalledTimes(1);
	await mount()(rows);
	await vi.waitFor(() => expect(recordDeckRoutings).toHaveBeenCalledTimes(2));
	expect(recordDeckRoutings).toHaveBeenLastCalledWith({ routes: [rows[100]] });
});
