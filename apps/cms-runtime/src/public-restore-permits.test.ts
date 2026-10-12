import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	PublicRestorePermits,
	publicRestorePermitEligible,
} from "./public-restore-permits";
import { withCmsRestoreResponsePermit } from "./tenant-restore-fence";

const db = {} as never;
const identity = { siteId: "site-one", slug: "one", restoreEpoch: 7 };
const permit = {
	...identity,
	permitId: "reservation-one",
	kind: "outer" as const,
};

function fixture() {
	const queries = {
		enter: vi.fn().mockResolvedValue(true),
		leave: vi.fn().mockResolvedValue(true),
		reuse: vi.fn().mockResolvedValue(true),
	};
	const pool = new PublicRestorePermits(queries);
	const tasks: Promise<unknown>[] = [];
	const forRequest = () => pool.forRequest((task) => tasks.push(task));
	return { queries, forRequest, tasks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("public restore reservations", () => {
	it("runs authentication and creates the response separately for each borrower", async () => {
		const { queries, forRequest, tasks } = fixture();
		const authenticate = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		for (const expected of [
			{ status: 200, body: "private page" },
			{ status: 401, body: "Unauthorized" },
		]) {
			const result = await withCmsRestoreResponsePermit(
				db,
				identity,
				async () => {
					const allowed = authenticate();
					return new Response(allowed ? "private page" : "Unauthorized", {
						status: allowed ? 200 : 401,
						headers: { "Content-Type": "text/html" },
					});
				},
				queries,
				forRequest(),
			);
			if (!result.admitted) throw new Error("expected site admission");
			expect(result.value.status).toBe(expected.status);
			expect(await result.value.text()).toBe(expected.body);
		}
		expect(authenticate).toHaveBeenCalledTimes(2);
		expect(queries.enter).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
	});

	it("keeps concurrent cold admissions independent", async () => {
		const { queries, forRequest, tasks } = fixture();
		let admitFirst!: (allowed: boolean) => void;
		queries.enter.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					admitFirst = resolve;
				}),
		);
		const first = forRequest();
		const pending = first.enter(db, permit);
		const second = forRequest();
		expect(await second.enter(db, { ...permit, permitId: "second" })).toBe(
			true,
		);
		expect(queries.enter).toHaveBeenCalledTimes(2);
		admitFirst(true);
		expect(await pending).toBe(true);
		await first.leave(db, permit);
		await second.leave(db, permit);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledTimes(2);
	});

	it("reports an idle cleanup failure and removes the reservation from reuse", async () => {
		const { queries, forRequest, tasks } = fixture();
		const request = forRequest();
		await request.enter(db, permit);
		await request.leave(db, permit);
		queries.leave.mockResolvedValue(false);
		const cleanup = expect(tasks[0]).rejects.toThrow(
			"reservation release failed",
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await cleanup;
		await forRequest().enter(db, { ...permit, permitId: "replacement" });
		expect(queries.enter).toHaveBeenCalledTimes(2);
	});

	it("serves 100 buffered pages with one INSERT and one DELETE", async () => {
		const { queries, forRequest, tasks } = fixture();
		for (let i = 0; i < 100; i++) {
			const result = await withCmsRestoreResponsePermit(
				db,
				identity,
				async () =>
					new Response("page", { headers: { "Content-Type": "text/html" } }),
				queries,
				forRequest(),
			);
			expect(result.admitted).toBe(true);
			if (result.admitted) expect(await result.value.text()).toBe("page");
		}
		expect(queries.enter).toHaveBeenCalledOnce();
		expect(queries.reuse).toHaveBeenCalledTimes(99);
		expect(queries.leave).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledOnce();
	});

	it("does not let expiry clear an active render or admit a new borrower", async () => {
		const { queries, forRequest, tasks } = fixture();
		const first = forRequest();
		const second = forRequest();
		expect(await first.enter(db, permit)).toBe(true);
		expect(await second.enter(db, { ...permit, permitId: "second" })).toBe(
			true,
		);
		await first.leave(db, permit);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).not.toHaveBeenCalled();
		const next = forRequest();
		await next.enter(db, { ...permit, permitId: "new-reservation" });
		expect(queries.enter).toHaveBeenCalledTimes(2);
		await second.leave(db, permit);
		expect(queries.leave).toHaveBeenCalledWith(db, permit);
		await next.leave(db, permit);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledTimes(2);
	});

	it.each([false, new Error("D1 unavailable")])(
		"fails closed on a reuse check returning %s",
		async (failure) => {
			const { queries, forRequest, tasks } = fixture();
			const first = forRequest();
			await first.enter(db, permit);
			await first.leave(db, permit);
			if (failure instanceof Error) queries.reuse.mockRejectedValue(failure);
			else queries.reuse.mockResolvedValue(failure);
			const run = vi.fn(async () => new Response("should not serve"));
			const result = withCmsRestoreResponsePermit(
				db,
				identity,
				run,
				queries,
				forRequest(),
			);
			if (failure instanceof Error)
				await expect(result).rejects.toThrow("fence unavailable");
			else expect(await result).toEqual({ admitted: false });
			expect(run).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(10_000);
			await Promise.all(tasks);
			expect(queries.leave).toHaveBeenCalledOnce();
		},
	);

	it("does not share reservations across sites, slugs or epochs", async () => {
		const { queries, forRequest, tasks } = fixture();
		for (const override of [
			{},
			{ siteId: "site-two" },
			{ slug: "two" },
			{ restoreEpoch: 8 },
		]) {
			const request = forRequest();
			await request.enter(db, { ...permit, ...override });
			await request.leave(db, permit);
		}
		expect(queries.enter).toHaveBeenCalledTimes(4);
		expect(queries.reuse).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
	});

	it("keeps exact per-pull admission for unbounded responses", async () => {
		const { queries, forRequest, tasks } = fixture();
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array([1]));
							controller.close();
						},
					}),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
			queries,
			forRequest(),
		);
		if (!result.admitted) throw new Error("expected admission");
		await result.value.arrayBuffer();
		expect(queries.enter.mock.calls.length).toBeGreaterThan(1);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave.mock.calls.length).toBe(
			queries.enter.mock.calls.length,
		);
	});

	it.each([
		["GET", "/", {}, true],
		["HEAD", "/", {}, true],
		["POST", "/", {}, false],
		["PUT", "/", {}, false],
		["PATCH", "/", {}, false],
		["DELETE", "/", {}, false],
		["GET", "/api/read", {}, true],
		["GET", "/_emdash/admin", {}, true],
		["GET", "/_tedix/private", {}, true],
		["GET", "/_astro/site.js", {}, true],
		["GET", "/?_preview=1", {}, true],
		["GET", "/", { cookie: "session=one" }, true],
		["GET", "/", { authorization: "Bearer fictional" }, true],
	] as const)(
		"selects %s %s with headers %j",
		(method, path, headers, eligible) => {
			expect(
				publicRestorePermitEligible(
					new Request(`https://one.example${path}`, { method, headers }),
				),
			).toBe(eligible);
		},
	);
});
