import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { subscribeDecisionSourceRefresh } from "./decision-source-refresh";

const api = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { workInteractions: { refreshDecisionSources: api.refresh } },
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		workInteractions: { listInbox: { key: () => ["inbox"] } },
		attention: { listDeckCards: { key: () => ["deck"] } },
	},
}));
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

it("shares one poll across four consumers, remounts and failures; stops after the last unmount", async () => {
	vi.useFakeTimers();
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	api.refresh
		.mockReset()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({ created: 0, superseded: 0 });
	const client = new QueryClient();
	const dispose = Array.from({ length: 4 }, () =>
		subscribeDecisionSourceRefresh(client),
	);
	await vi.advanceTimersByTimeAsync(0);
	expect(api.refresh).toHaveBeenCalledTimes(1);
	expect(api.refresh).toHaveBeenCalledWith({});
	dispose.pop()!();
	dispose.push(subscribeDecisionSourceRefresh(client));
	await vi.advanceTimersByTimeAsync(120_000);
	expect(api.refresh).toHaveBeenCalledTimes(2);
	dispose.forEach((stop) => stop());
	await vi.advanceTimersByTimeAsync(120_000);
	expect(api.refresh).toHaveBeenCalledTimes(2);
	client.clear();
});

it("does not overlap slow refreshes or poll a hidden document", async () => {
	vi.useFakeTimers();
	const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
	api.refresh.mockReset().mockImplementation(() => new Promise(() => {}));
	const client = new QueryClient();
	const stop = subscribeDecisionSourceRefresh(client);
	await vi.advanceTimersByTimeAsync(120_000);
	expect(api.refresh).not.toHaveBeenCalled();
	hidden.mockReturnValue(false);
	await vi.advanceTimersByTimeAsync(360_000);
	expect(api.refresh).toHaveBeenCalledTimes(1);
	stop();
	client.clear();
});
