import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { deliveryFixture } from "./test-utils/publish-delivery";
import {
	deliveryId,
	deliveryRoutes,
	enqueueDelivery,
	ensureDeliverySchedule,
	processDeliveries,
	publication,
	type Publication,
} from "../templates/tedix/src/lib/publish-delivery";

const source: Publication = {
	site: "https://acme.example",
	collection: "posts",
	entry: "post-1",
	revision: "live-1",
	locale: "en",
};
afterEach(() => vi.useRealTimers());

describe("durable publish delivery", () => {
	it("deduplicates concurrent hooks and keeps site, locale, revision and recipient isolated", async () => {
		const f = deliveryFixture();
		await Promise.all([
			enqueueDelivery(f.ctx, source, "reader@example.com", {
				subject: "Original",
			}),
			enqueueDelivery(f.ctx, source, "reader@example.com", {
				subject: "Replayed",
			}),
		]);
		expect(f.rows.size).toBe(1);
		await enqueueDelivery(
			f.ctx,
			{ ...source, revision: "live-2" },
			"reader@example.com",
			{},
		);
		await enqueueDelivery(
			f.ctx,
			{ ...source, locale: "de" },
			"reader@example.com",
			{},
		);
		await enqueueDelivery(
			f.ctx,
			{ ...source, site: "https://other.example" },
			"reader@example.com",
			{},
		);
		await enqueueDelivery(f.ctx, source, "other@example.com", {});
		expect(f.rows.size).toBe(5);
		expect(
			publication(
				{
					collection: "posts",
					content: { id: "post-1", liveRevisionId: "live-1", locale: "en" },
				},
				f.ctx,
			),
		).toEqual(source);
		expect(() =>
			publication({ collection: "posts", content: { id: "post-1" } }, f.ctx),
		).toThrow("live revision");
	});
	it("persists independent failures and retries only due recipients, preserving provider receipts", async () => {
		vi.useFakeTimers();
		const f = deliveryFixture();
		await enqueueDelivery(f.ctx, source, "ok@example.com", {});
		await enqueueDelivery(f.ctx, source, "fail@example.com", {
			secret: "hidden",
		});
		const send = vi.fn(async (job) => {
			if (job.recipient === "fail@example.com")
				throw new Error("Bearer secret-provider-error");
			return { receipt: { messageId: "provider-1" } };
		});
		await processDeliveries(f.ctx, send);
		const response = await deliveryRoutes["deliveries/status"].handler(
			{},
			f.ctx,
		);
		const status = (await response.json()) as {
			receipts: Array<{ receipt?: { messageId?: string } }>;
		};
		expect(status).toMatchObject({ pending: 0, failed: 1, sent: 1 });
		expect(JSON.stringify(status)).not.toContain("hidden");
		expect(JSON.stringify(status)).not.toContain("secret-provider-error");
		expect(
			status.receipts.some(
				(r: { receipt?: { messageId?: string } }) =>
					r.receipt?.messageId === "provider-1",
			),
		).toBe(true);
		await processDeliveries(f.ctx, send);
		expect(send).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(60_000);
		const retry = vi.fn(async () => ({ receipt: { messageId: "provider-2" } }));
		await processDeliveries(f.ctx, retry);
		expect(retry).toHaveBeenCalledTimes(1);
		expect([...f.rows.values()].every((r) => r.value.status === "sent")).toBe(
			true,
		);
	});
	it("bounds batches, fences overlapping workers and recovers an interrupted lease", async () => {
		vi.useFakeTimers();
		const f = deliveryFixture();
		for (let n = 0; n < 7; n++)
			await enqueueDelivery(f.ctx, source, `reader${n}@example.com`, {});
		const send = vi.fn(async () => ({ receipt: { accepted: true } }));
		await processDeliveries(f.ctx, send);
		expect(send).toHaveBeenCalledTimes(5);
		await Promise.all([
			processDeliveries(f.ctx, send),
			processDeliveries(f.ctx, send),
		]);
		expect(send).toHaveBeenCalledTimes(7);
		const id = await deliveryId(source, "interrupted@example.com");
		await enqueueDelivery(f.ctx, source, "interrupted@example.com", {});
		const row = f.rows.get(id)!;
		row.value.status = "processing";
		row.value.due = Date.now() + 120_000;
		await processDeliveries(f.ctx, send);
		expect(send).toHaveBeenCalledTimes(7);
		vi.advanceTimersByTime(120_000);
		await processDeliveries(f.ctx, send);
		expect(send).toHaveBeenCalledTimes(8);
	});
	it("stops after eight failures and allows an authenticated route to queue a retry", async () => {
		vi.useFakeTimers();
		const f = deliveryFixture();
		await ensureDeliverySchedule(f.ctx);
		await ensureDeliverySchedule(f.ctx);
		expect(f.cron.schedule).toHaveBeenCalledTimes(1);
		await enqueueDelivery(f.ctx, source, "reader@example.com", {});
		const fail = vi.fn(async () => {
			throw new Error("unavailable");
		});
		for (let n = 0; n < 9; n++) {
			await processDeliveries(f.ctx, fail);
			vi.advanceTimersByTime(3_600_000);
		}
		expect(fail).toHaveBeenCalledTimes(8);
		const id = await deliveryId(source, "reader@example.com");
		expect(f.rows.get(id)?.value.status).toBe("failed");
		expect(deliveryRoutes["deliveries/status"].permission).toBe(
			"plugins:manage",
		);
		expect(deliveryRoutes["deliveries/retry"].permission).toBe(
			"plugins:manage",
		);
		const response = await deliveryRoutes["deliveries/retry"].handler(
			{ input: { id } },
			f.ctx,
		);
		expect(response.status).toBe(200);
		await processDeliveries(f.ctx, async () => ({
			receipt: { accepted: true },
		}));
		expect(f.rows.get(id)?.value.status).toBe("sent");
		expect(
			(
				await deliveryRoutes["deliveries/retry"].handler(
					{ input: { id } },
					f.ctx,
				)
			).status,
		).toBe(409);
	});
	it("does not let an expired worker overwrite a newer receipt", async () => {
		vi.useFakeTimers();
		const f = deliveryFixture();
		await enqueueDelivery(f.ctx, source, "reader@example.com", {});
		let resume!: () => void;
		const blocked = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let started!: () => void;
		const claimed = new Promise<void>((resolve) => {
			started = resolve;
		});
		const oldWorker = processDeliveries(f.ctx, async () => {
			started();
			await blocked;
			return { receipt: { messageId: "old" } };
		});
		await claimed;
		vi.advanceTimersByTime(120_000);
		await processDeliveries(f.ctx, async () => ({
			receipt: { messageId: "new" },
		}));
		resume();
		await oldWorker;
		expect([...f.rows.values()][0]?.value.receipt?.messageId).toBe("new");
	});
});
