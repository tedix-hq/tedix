import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createLink,
	createORPCClient,
	D1BookmarkSession,
	withRequestTimeout,
} from "./client";

afterEach(() => {
	vi.useRealTimers();
});

describe("D1 bookmarks", () => {
	it("chains writes and reads across links without consuming response bodies", async () => {
		const seen: (string | null)[] = [];
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				seen.push(new Headers(init?.headers).get("x-d1-bookmark"));
				return Response.json(
					{ json: "ok" },
					{ headers: { "x-d1-bookmark": `bookmark-${seen.length}` } },
				);
			},
		);
		const bookmarkSession = new D1BookmarkSession();
		const client = () =>
			createORPCClient<{ run: () => Promise<string> }>(
				createLink({
					url: "https://api.example/rpc",
					fetch: fetchImpl,
					bookmarkSession,
				}),
			);
		await expect(client().run()).resolves.toBe("ok");
		await expect(client().run()).resolves.toBe("ok");
		expect(seen).toEqual([null, "bookmark-1"]);
	});

	it("retains progress from errors and responses without a bookmark", async () => {
		const session = new D1BookmarkSession();
		const fetchImpl = vi.fn(
			async () =>
				new Response("error", {
					status: 409,
					headers: { "x-d1-bookmark": "after-write" },
				}),
		);
		await session.wrap(fetchImpl)("https://api.example/rpc");
		const next = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("x-d1-bookmark")).toBe(
					"after-write",
				);
				return new Response("unchanged");
			},
		);
		await session.wrap(next)("https://api.example/rpc");
		await session.wrap(next)("https://api.example/rpc");
	});

	it.each([true, false])(
		"rejoins concurrent read/write branches on primary (write first: %s)",
		async (writeFirst) => {
			const session = new D1BookmarkSession();
			const replies: ((response: Response) => void)[] = [];
			const transport = session.wrap(
				async () => new Promise<Response>((resolve) => replies.push(resolve)),
			);
			const read = transport("https://api.example/rpc/read");
			const write = transport("https://api.example/rpc/write");
			const order = writeFirst ? [1, 0] : [0, 1];
			for (const index of order) {
				replies[index]!(
					new Response("ok", {
						headers: { "x-d1-bookmark": index === 1 ? "write" : "read" },
					}),
				);
				await (index === 1 ? write : read);
			}
			await session.wrap(async (_input, init) => {
				expect(new Headers(init?.headers).get("x-d1-bookmark")).toBe(
					"first-primary",
				);
				return new Response("ok");
			})("https://api.example/rpc/read-after-write");
		},
	);

	it("isolates default links", async () => {
		const seen: (string | null)[] = [];
		const client = () =>
			createORPCClient<{ run: () => Promise<string> }>(
				createLink({
					url: "https://api.example/rpc",
					fetch: async (_input, init) => {
						seen.push(new Headers(init?.headers).get("x-d1-bookmark"));
						return Response.json(
							{ json: "ok" },
							{ headers: { "x-d1-bookmark": "private" } },
						);
					},
				}),
			);
		await client().run();
		await client().run();
		expect(seen).toEqual([null, null]);
	});
});

describe("withRequestTimeout", () => {
	it("aborts a transport that exceeds its deadline", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		const request = withRequestTimeout(
			fetchImpl,
			500,
		)("https://api.tedix.dev/rpc/slow");
		const rejection = expect(request).rejects.toThrow(
			"API request timed out after 500ms",
		);
		await vi.advanceTimersByTimeAsync(500);

		await rejection;
	});

	it("preserves an earlier caller abort reason", async () => {
		const caller = new AbortController();
		caller.abort(new Error("caller stopped"));
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.signal?.aborted) throw init.signal.reason;
				return Response.json({ ok: true });
			},
		);

		await expect(
			withRequestTimeout(fetchImpl, 10_000)(
				"https://api.tedix.dev/rpc/stopped",
				{ signal: caller.signal },
			),
		).rejects.toThrow("caller stopped");
	});
});
