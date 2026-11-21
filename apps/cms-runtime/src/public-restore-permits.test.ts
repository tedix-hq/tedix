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
import { startRestorePermitLease } from "./restore-permit-lease";
import { CMS_RESTORE_LEASE_SECONDS } from "@tedix/db/queries/cms-restore-fences";

const db = {} as never;
const identity = { siteId: "site-one", slug: "one", restoreEpoch: 7 };
const permit = {
	...identity,
	permitId: "reservation-one",
	kind: "outer" as const,
};

function fixture(
	clock?: ConstructorParameters<typeof PublicRestorePermits>[1],
) {
	const queries = {
		enter: vi.fn().mockResolvedValue(true),
		leave: vi.fn().mockResolvedValue(true),
	};
	const pool = new PublicRestorePermits(queries, clock);
	const tasks: Promise<unknown>[] = [];
	const forRequest = (existingOnly = false) =>
		pool.forRequest((task) => tasks.push(task), existingOnly);
	return { queries, forRequest, tasks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("public restore reservations", () => {
	it("keeps a long-running holder renewable and stops renewing when it leaves", async () => {
		const tasks: Promise<unknown>[] = [];
		const context = {
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
			abort: vi.fn(),
		};
		const renew = vi.fn().mockResolvedValue(true);
		const lease = startRestorePermitLease(context, renew);
		await vi.advanceTimersByTimeAsync(CMS_RESTORE_LEASE_SECONDS * 3_000);
		lease.assertActive();
		expect(renew).toHaveBeenCalled();
		expect(context.abort).not.toHaveBeenCalled();
		lease.stop();
		const renewals = renew.mock.calls.length;
		await vi.advanceTimersByTimeAsync(CMS_RESTORE_LEASE_SECONDS * 1_000);
		await Promise.all(tasks);
		expect(renew).toHaveBeenCalledTimes(renewals);
	});

	it("aborts before D1 expiry when renewal hangs and never accepts its late response", async () => {
		const tasks: Promise<unknown>[] = [];
		const context = {
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
			abort: vi.fn(),
		};
		const pending = Promise.withResolvers<boolean>();
		const renew = vi.fn().mockReturnValue(pending.promise);
		const lease = startRestorePermitLease(context, renew);
		await vi.advanceTimersByTimeAsync(CMS_RESTORE_LEASE_SECONDS * 500);
		expect(context.abort).toHaveBeenCalledOnce();
		expect(() => lease.assertActive()).toThrow("lease lost");
		pending.resolve(true);
		await vi.advanceTimersByTimeAsync(CMS_RESTORE_LEASE_SECONDS * 1_000);
		await Promise.all(tasks);
		expect(renew).toHaveBeenCalledOnce();
		expect(() => lease.assertActive()).toThrow("lease lost");
	});

	it("does not abort a finished borrower when its pending renewal later fails", async () => {
		const context = {
			waitUntil: (_task: Promise<unknown>) => {},
			abort: vi.fn(),
		};
		const pending = Promise.withResolvers<boolean>();
		const renew = vi.fn().mockReturnValue(pending.promise);
		const lease = startRestorePermitLease(context, renew);
		await vi.advanceTimersByTimeAsync((CMS_RESTORE_LEASE_SECONDS * 1_000) / 6);
		expect(renew).toHaveBeenCalledOnce();
		lease.stop();
		pending.resolve(false);
		await vi.advanceTimersByTimeAsync(CMS_RESTORE_LEASE_SECONDS * 1_000);
		expect(context.abort).not.toHaveBeenCalled();
	});

	it("awaits cleanup of an uncertain cold INSERT without a replacement borrower", async () => {
		const { queries, forRequest, tasks } = fixture();
		queries.enter.mockRejectedValueOnce(new Error("INSERT response lost"));
		const deleted = Promise.withResolvers<boolean>();
		queries.leave.mockReturnValueOnce(deleted.promise);
		const pending = forRequest().enter(db, permit);
		const rejected = expect(pending).rejects.toThrow("INSERT response lost");
		await vi.waitFor(() => expect(queries.leave).toHaveBeenCalledOnce());
		expect(tasks).toHaveLength(0);
		deleted.resolve(true);
		await rejected;
		expect(queries.leave).toHaveBeenCalledWith(db, {
			...permit,
			kind: "nested",
		});
	});

	it("only borrows confirmed admission for the same epoch on the cache path", async () => {
		const { queries, forRequest, tasks } = fixture();
		const cacheRead = () => forRequest(true);
		expect(await cacheRead().enter(db, permit)).toBe(false);
		expect(queries.enter).not.toHaveBeenCalled();

		const admitted = forRequest();
		expect(await admitted.enter(db, permit)).toBe(true);
		await admitted.leave(db, permit);

		const hit = cacheRead();
		expect(await hit.enter(db, permit)).toBe(true);
		expect(await cacheRead().enter(db, { ...permit, restoreEpoch: 8 })).toBe(
			false,
		);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await cacheRead().enter(db, permit)).toBe(false);
		expect(queries.leave).not.toHaveBeenCalled();
		await hit.leave(db, permit);
		await Promise.all(tasks);
		expect(queries.enter).toHaveBeenCalledOnce();
		expect(queries.leave).toHaveBeenCalledOnce();
	});

	it("never shares an outer response reservation with a nested read", async () => {
		const { queries, forRequest, tasks } = fixture();
		const outer = forRequest();
		await outer.enter(db, permit);
		await outer.leave(db, permit);
		const nested = forRequest();
		await nested.enter(db, {
			...permit,
			kind: "nested",
			permitId: "nested-read",
		});
		await nested.leave(db, permit);
		expect(queries.enter).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
	});

	it("reads 100 stream chunks under one reservation without per-pull D1", async () => {
		const { queries, forRequest, tasks } = fixture();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let i = 0; i < 100; i++) controller.enqueue(new Uint8Array([i]));
				controller.close();
			},
		});
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () =>
				new Response(source, {
					headers: { "Content-Type": "text/event-stream" },
				}),
			queries,
			forRequest(),
			forRequest,
		);
		if (!result.admitted) throw new Error("expected admission");
		expect((await result.value.arrayBuffer()).byteLength).toBe(100);
		expect(queries.enter).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledOnce();
	});

	it("rejects a delayed stream pull after the shared reservation's admission closes", async () => {
		const { queries, forRequest, tasks } = fixture();
		const pull = vi.fn();
		const cancel = vi.fn();
		const source = new ReadableStream<Uint8Array>(
			{ pull, cancel },
			{ highWaterMark: 0 },
		);
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(source),
			queries,
			forRequest(),
			forRequest,
		);
		if (!result.admitted) throw new Error("expected admission");
		queries.enter.mockResolvedValue(false);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		await expect(result.value.body!.getReader().read()).rejects.toThrow(
			"fence unavailable",
		);
		expect(pull).not.toHaveBeenCalled();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("retains an active stream borrower through expiry and waits for cancellation", async () => {
		const { queries, forRequest, tasks } = fixture();
		const pull = vi.fn();
		const cancel = vi.fn();
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () =>
				new Response(
					new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
				),
			queries,
			forRequest(),
			forRequest,
		);
		if (!result.admitted) throw new Error("expected admission");
		const reader = result.value.body!.getReader();
		const pending = reader.read();
		await vi.waitFor(() => expect(pull).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(queries.leave).not.toHaveBeenCalled();
		await reader.cancel("stop");
		await pending;
		await Promise.all(tasks);
		expect(cancel).toHaveBeenCalledWith("stop");
		expect(queries.leave).toHaveBeenCalledOnce();
	});

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

	it("uses a concurrently confirmed reservation after a failed admission", async () => {
		const { queries, forRequest, tasks } = fixture();
		const admission = Promise.withResolvers<boolean>();
		queries.enter.mockReturnValueOnce(admission.promise);
		const first = forRequest();
		const second = forRequest();
		const pending = first.enter(db, permit);
		const secondPermit = { ...permit, permitId: "confirmed" };
		expect(await second.enter(db, secondPermit)).toBe(true);
		admission.reject(new Error("D1 unavailable"));
		expect(await pending).toBe(true);
		await second.leave(db, secondPermit);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(queries.leave).toHaveBeenCalledExactlyOnceWith(db, {
			...permit,
			kind: "nested",
		});
		await first.leave(db, permit);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenLastCalledWith(db, {
			...secondPermit,
			kind: "nested",
		});
	});

	it("admits 100 nested borrowers with one INSERT, no re-check and one DELETE", async () => {
		const { queries, forRequest, tasks } = fixture();
		const nested = { ...permit, kind: "nested" as const };
		for (let i = 0; i < 100; i++) {
			const request = forRequest();
			expect(await request.enter(db, { ...nested, permitId: `n-${i}` })).toBe(
				true,
			);
			await request.leave(db, nested);
			// The durable row admits later borrowers; the ledger is not consulted.
			queries.enter.mockResolvedValue(false);
		}
		expect(queries.enter).toHaveBeenCalledExactlyOnceWith(db, {
			...nested,
			permitId: "n-0",
		});
		expect(queries.leave).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledExactlyOnceWith(db, {
			...nested,
			permitId: "n-0",
		});
		expect(await forRequest().enter(db, { ...nested, permitId: "late" })).toBe(
			false,
		);
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
		expect(queries.leave).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledOnce();
	});

	it("awaits an expired reservation's deletion and surfaces release failure", async () => {
		const { queries, forRequest, tasks } = fixture();
		const render = Promise.withResolvers<Response>();
		const started = Promise.withResolvers<void>();
		const deletion = Promise.withResolvers<boolean>();
		queries.leave.mockReturnValueOnce(deletion.promise);
		const pending = withCmsRestoreResponsePermit(
			db,
			identity,
			() => {
				started.resolve();
				return render.promise;
			},
			queries,
			forRequest(),
		);

		await started.promise;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(queries.leave).not.toHaveBeenCalled();
		queries.enter.mockResolvedValueOnce(false);
		expect(await forRequest().enter(db, permit)).toBe(false);

		render.resolve(
			new Response("page", { headers: { "Content-Type": "text/html" } }),
		);
		let returned = false;
		void pending.then(
			() => {
				returned = true;
			},
			() => {
				returned = true;
			},
		);
		await vi.waitFor(() => expect(queries.leave).toHaveBeenCalledOnce());
		expect(returned).toBe(false);
		expect(queries.leave).toHaveBeenCalledExactlyOnceWith(db, {
			...queries.enter.mock.calls[0]?.[1],
			kind: "nested",
		});
		const failure = expect(pending).rejects.toThrow(
			"CMS restore fence unavailable",
		);
		deletion.reject(new Error("D1 unavailable"));
		await failure;
		await Promise.all(tasks);
	});

	it("does not let expiry clear an active render or admit a new borrower", async () => {
		let now = 0;
		const { queries, forRequest, tasks } = fixture({
			now: () => now,
			schedule: (task, delayMs) =>
				new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(task),
		});
		const first = forRequest();
		const second = forRequest();
		expect(await first.enter(db, permit)).toBe(true);
		expect(queries.enter).toHaveBeenCalledWith(db, {
			...permit,
			kind: "nested",
		});
		expect(await second.enter(db, { ...permit, permitId: "second" })).toBe(
			true,
		);
		await first.leave(db, permit);
		now = 9_999;
		const lastBorrower = forRequest();
		await lastBorrower.enter(db, { ...permit, permitId: "last-borrower" });
		expect(queries.enter).toHaveBeenCalledOnce();
		await lastBorrower.leave(db, permit);
		now = 10_000;
		const next = forRequest();
		await next.enter(db, { ...permit, permitId: "new-reservation" });
		expect(queries.enter).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).not.toHaveBeenCalled();
		await second.leave(db, permit);
		expect(queries.leave).toHaveBeenCalledWith(db, {
			...permit,
			kind: "nested",
		});
		await next.leave(db, permit);
		await vi.advanceTimersByTimeAsync(10_000);
		await Promise.all(tasks);
		expect(queries.leave).toHaveBeenCalledTimes(2);
	});

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
