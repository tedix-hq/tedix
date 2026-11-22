import {
	focusManager,
	QueryClient,
	QueryObserver,
} from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";
import { pollingBackoff } from "@/lib/polling-backoff";
import {
	TRANSCRIPT_TRANSIENT_RETRIES,
	transientTranscriptRetryMs,
} from "./chat-polling";

describe("transientTranscriptRetryMs", () => {
	const unavailable = {
		status: 503,
		code: "SERVICE_UNAVAILABLE",
		message: "Organization identity is temporarily unavailable",
	};

	it("re-reads a transcript after a transient failure with bounded backoff", () => {
		expect(transientTranscriptRetryMs(unavailable, 1)).toBe(2_000);
		expect(transientTranscriptRetryMs(unavailable, 2)).toBe(4_000);
		expect(transientTranscriptRetryMs({ code: "SERVICE_UNAVAILABLE" }, 3)).toBe(
			8_000,
		);
		expect(transientTranscriptRetryMs(unavailable, 6)).toBe(30_000);
		expect(
			transientTranscriptRetryMs(unavailable, TRANSCRIPT_TRANSIENT_RETRIES + 1),
		).toBe(false);
	});

	it("leaves other failures to the explicit error state", () => {
		expect(
			transientTranscriptRetryMs({ status: 403, code: "FORBIDDEN" }, 1),
		).toBe(false);
		expect(transientTranscriptRetryMs(new Error("boom"), 1)).toBe(false);
		expect(transientTranscriptRetryMs(null, 1)).toBe(false);
	});
});

it("bounds unchanged active-run reads, pauses in the background and resets on change", async () => {
	vi.useFakeTimers();
	focusManager.setFocused(true);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	let status = "running";
	const read = vi.fn(async () => ({ status }));
	const options = {
		queryKey: ["polling-budget"],
		queryFn: read,
		refetchInterval: (query: Parameters<typeof pollingBackoff>[0]) =>
			pollingBackoff(query, 5_000, 30_000),
		refetchIntervalInBackground: false,
	};
	const observer = new QueryObserver(client, options);
	const unsubscribe = observer.subscribe(() => {});
	try {
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(4);
		focusManager.setFocused(false);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(read).toHaveBeenCalledTimes(4);
		focusManager.setFocused(true);
		status = "completed";
		await observer.refetch();
		expect(
			pollingBackoff(client.getQueryCache().getAll()[0]!, 5_000, 30_000),
		).toBe(5_000);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(read).toHaveBeenCalledTimes(6);
	} finally {
		unsubscribe();
		client.clear();
		focusManager.setFocused(undefined);
		vi.useRealTimers();
	}
});
