import { describe, expect, test, vi } from "vite-plus/test";

import {
	CmsRestoreFenceUnavailableError,
	cmsRestoreFenceResponse,
	withCmsRestorePermit,
	withCmsRestoreResponsePermit,
} from "./tenant-restore-fence";

const identity = { siteId: "site-1", slug: "tenant", restoreEpoch: 7 };
const db = {} as never;

function queries(enter = vi.fn().mockResolvedValue(true)) {
	return {
		enter,
		leave: vi.fn().mockResolvedValue(true),
	};
}

describe("CMS tenant restore permit", () => {
	test("holds the exact tenant permit through the whole invocation", async () => {
		const ledger = queries();
		let finish!: (value: string) => void;
		const run = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = withCmsRestorePermit(db, identity, run, ledger);
		await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
		expect(ledger.leave).not.toHaveBeenCalled();
		finish("served");
		expect(await pending).toEqual({ admitted: true, value: "served" });
		expect(ledger.enter).toHaveBeenCalledWith(
			db,
			expect.objectContaining({ ...identity, restoreEpoch: 7, kind: "nested" }),
		);
		expect(ledger.leave).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				...identity,
				restoreEpoch: 7,
				kind: "nested",
				permitId: ledger.enter.mock.calls[0]![1].permitId,
			}),
		);
	});

	test("does not invoke the tenant when the exact fence is closed", async () => {
		const ledger = queries(vi.fn().mockResolvedValue(false));
		const run = vi.fn();
		expect(await withCmsRestorePermit(db, identity, run, ledger)).toEqual({
			admitted: false,
		});
		expect(run).not.toHaveBeenCalled();
		expect(ledger.leave).not.toHaveBeenCalled();
		const response = cmsRestoreFenceResponse();
		expect(response.status).toBe(503);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	test("an old tenant identity cannot join the next restore epoch", async () => {
		let liveEpoch = 7;
		const ledger = queries(
			vi
				.fn()
				.mockImplementation((_db, permit) => permit.restoreEpoch === liveEpoch),
		);
		expect(
			await withCmsRestorePermit(db, identity, async () => "first", ledger),
		).toEqual({ admitted: true, value: "first" });
		liveEpoch = 8;
		const run = vi.fn(async () => "stale");
		expect(await withCmsRestorePermit(db, identity, run, ledger)).toEqual({
			admitted: false,
		});
		expect(run).not.toHaveBeenCalled();
		expect(ledger.enter.mock.calls[1]![1].restoreEpoch).toBe(7);
	});

	test("fails closed when permit acquisition cannot read or write D1", async () => {
		const ledger = queries(vi.fn().mockRejectedValue(new Error("D1 down")));
		const run = vi.fn();
		await expect(
			withCmsRestorePermit(db, identity, run, ledger),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
		expect(run).not.toHaveBeenCalled();
	});

	test("releases the permit when tenant execution throws", async () => {
		const ledger = queries();
		await expect(
			withCmsRestorePermit(
				db,
				identity,
				async () => {
					throw new Error("loader failure");
				},
				ledger,
			),
		).rejects.toThrow("loader failure");
		expect(ledger.leave).toHaveBeenCalledOnce();
	});

	test("reports a failed release as unavailable", async () => {
		const ledger = queries();
		ledger.leave.mockResolvedValue(false);
		await expect(
			withCmsRestorePermit(db, identity, async () => "served", ledger),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
	});
});

describe("CMS public response restore permit", () => {
	test("releases the initial permit before an unread body and admits each pull", async () => {
		const ledger = queries();
		let emit!: (value: Uint8Array) => void;
		let close!: () => void;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				emit = (value) => controller.enqueue(value);
				close = () => controller.close();
			},
		});
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(source),
			ledger,
		);
		expect(result.admitted).toBe(true);
		if (!result.admitted) return;
		expect(ledger.enter).toHaveBeenCalledOnce();
		expect(ledger.leave).toHaveBeenCalledOnce();
		const reader = result.value.body!.getReader();
		emit(new TextEncoder().encode("part"));
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("part");
		expect(ledger.enter).toHaveBeenCalledTimes(2);
		expect(ledger.leave).toHaveBeenCalledTimes(2);
		close();
		expect((await reader.read()).done).toBe(true);
		expect(ledger.enter).toHaveBeenCalledTimes(3);
		expect(ledger.leave).toHaveBeenCalledTimes(3);
		expect(ledger.leave).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				...identity,
				restoreEpoch: 7,
				kind: "outer",
				permitId: ledger.enter.mock.calls[2]![1].permitId,
			}),
		);
	});

	test("releases on reader cancellation, and only once", async () => {
		const ledger = queries();
		const cancel = vi.fn();
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(new ReadableStream({ cancel })),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		await result.value.body!.cancel("client disconnected");
		expect(cancel).toHaveBeenCalledWith("client disconnected");
		expect(ledger.leave).toHaveBeenCalledOnce();
		expect(ledger.enter).toHaveBeenCalledOnce();
	});

	test("denies a delayed pull after restore close or epoch rotation", async () => {
		let liveEpoch = 7;
		const ledger = queries(
			vi
				.fn()
				.mockImplementation((_db, permit) => permit.restoreEpoch === liveEpoch),
		);
		const read = vi
			.fn()
			.mockResolvedValue({ done: false, value: new Uint8Array([1]) });
		const source = new ReadableStream<Uint8Array>(
			{ pull: read },
			{ highWaterMark: 0 },
		);
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(source),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		liveEpoch = 8;
		await expect(result.value.body!.getReader().read()).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(ledger.enter).toHaveBeenCalledTimes(2);
		expect(ledger.enter.mock.calls[1]![1]).toEqual(
			expect.objectContaining({ restoreEpoch: 7, kind: "outer" }),
		);
		expect(ledger.leave).toHaveBeenCalledOnce();
		expect(read).not.toHaveBeenCalled();
	});

	test("does not expose a chunk until its outer permit is released", async () => {
		const ledger = queries();
		let finishRelease!: () => void;
		ledger.leave.mockResolvedValueOnce(true).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finishRelease = () => resolve(true);
				}),
		);
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(new Uint8Array([3])),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		const reader = result.value.body!.getReader();
		let settled = false;
		const read = reader.read().then((next) => {
			settled = true;
			return next;
		});
		await vi.waitFor(() => expect(ledger.leave).toHaveBeenCalledTimes(2));
		expect(settled).toBe(false);
		finishRelease();
		expect((await read).value).toEqual(new Uint8Array([3]));
		expect(ledger.leave).toHaveBeenCalledTimes(2);
		await reader.cancel();
		expect(ledger.leave).toHaveBeenCalledTimes(2);
	});

	test("errors the same read when its chunk release fails", async () => {
		const ledger = queries();
		ledger.leave.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		const cancelSource = vi.fn();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([3]));
			},
			cancel: cancelSource,
		});
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(source),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		const reader = result.value.body!.getReader();
		await expect(reader.read()).rejects.toBeInstanceOf(
			CmsRestoreFenceUnavailableError,
		);
		expect(ledger.leave).toHaveBeenCalledTimes(2);
		expect(cancelSource).toHaveBeenCalledOnce();
	});

	test("does not close a body until its EOF permit is released", async () => {
		const ledger = queries();
		let finishRelease!: () => void;
		ledger.leave.mockResolvedValueOnce(true).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finishRelease = () => resolve(true);
				}),
		);
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
				),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		const reader = result.value.body!.getReader();
		let settled = false;
		const read = reader.read().then((next) => {
			settled = true;
			return next;
		});
		await vi.waitFor(() => expect(ledger.leave).toHaveBeenCalledTimes(2));
		expect(settled).toBe(false);
		finishRelease();
		expect((await read).done).toBe(true);
		expect(ledger.leave).toHaveBeenCalledTimes(2);
	});

	test("holds a pull permit through its read and releases it on cancellation", async () => {
		const ledger = queries();
		const cancelSource = vi.fn();
		let beginRead!: (value: Uint8Array) => void;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				beginRead = (value) => controller.enqueue(value);
			},
			cancel: cancelSource,
		});
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(source),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		const reader = result.value.body!.getReader();
		const pending = reader.read();
		await vi.waitFor(() => expect(ledger.enter).toHaveBeenCalledTimes(2));
		expect(ledger.leave).toHaveBeenCalledOnce();
		beginRead(new Uint8Array([2]));
		expect((await pending).value).toEqual(new Uint8Array([2]));
		expect(ledger.leave).toHaveBeenCalledTimes(2);
		await reader.cancel("stop");
		expect(cancelSource).toHaveBeenCalledWith("stop");
		expect(ledger.leave).toHaveBeenCalledTimes(2);
	});

	test("cancellation waits for an in-flight pull permit to release", async () => {
		const ledger = queries();
		let finishRelease!: () => void;
		ledger.leave.mockResolvedValueOnce(true).mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					finishRelease = () => resolve(true);
				}),
		);
		const cancelSource = vi.fn();
		const result = await withCmsRestoreResponsePermit(
			db,
			identity,
			async () => new Response(new ReadableStream({ cancel: cancelSource })),
			ledger,
		);
		if (!result.admitted) throw new Error("expected public read admission");
		const reader = result.value.body!.getReader();
		const read = reader.read();
		await vi.waitFor(() => expect(ledger.enter).toHaveBeenCalledTimes(2));
		let cancelled = false;
		const cancel = reader.cancel("stop").then(() => {
			cancelled = true;
		});
		await vi.waitFor(() => expect(ledger.leave).toHaveBeenCalledTimes(2));
		expect(cancelled).toBe(false);
		finishRelease();
		await cancel;
		await read;
		expect(cancelSource).toHaveBeenCalledWith("stop");
		expect(cancelled).toBe(true);
	});

	test("does not run while closed, releases null bodies, and fails closed on D1 error", async () => {
		const closed = queries(vi.fn().mockResolvedValue(false));
		const run = vi.fn(async () => Response.redirect("https://example.com"));
		expect(
			await withCmsRestoreResponsePermit(db, identity, run, closed),
		).toEqual({
			admitted: false,
		});
		expect(run).not.toHaveBeenCalled();
		const ledger = queries();
		const redirect = await withCmsRestoreResponsePermit(
			db,
			identity,
			run,
			ledger,
		);
		expect(redirect.admitted).toBe(true);
		expect(ledger.leave).toHaveBeenCalledOnce();
		const failed = queries(
			vi.fn().mockRejectedValue(new Error("D1 unavailable")),
		);
		await expect(
			withCmsRestoreResponsePermit(db, identity, run, failed),
		).rejects.toBeInstanceOf(CmsRestoreFenceUnavailableError);
	});
});
