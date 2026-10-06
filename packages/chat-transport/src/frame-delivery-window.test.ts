import { describe, expect, it } from "vite-plus/test";
import { createFrameDeliveryWindow } from "./frame-delivery-window";

describe("bounded frame delivery", () => {
	it("stops reading at eight outstanding acknowledgments and drains them", async () => {
		const release: Array<() => void> = [];
		let active = 0;
		let maximum = 0;
		const window = createFrameDeliveryWindow<number>(() => {
			maximum = Math.max(maximum, ++active);
			return new Promise<void>((resolve) =>
				release.push(() => {
					active--;
					resolve();
				}),
			);
		});
		for (let i = 0; i < 7; i++) await window.send(i);
		let admitted = false;
		const eighth = window.send(7).then(() => {
			admitted = true;
		});
		await Promise.resolve();
		expect(active).toBe(8);
		expect(admitted).toBe(false);
		release.shift()!();
		await eighth;
		const ninth = window.send(8);
		await Promise.resolve();
		expect(maximum).toBe(8);
		for (const resolve of release) resolve();
		await ninth;
		await window.drain();
		expect(active).toBe(0);
	});
	it("stops admitting frames after rejection and settles outstanding calls before returning failure", async () => {
		let fail!: (error: Error) => void;
		let release!: () => void;
		const window = createFrameDeliveryWindow<number>((value) =>
			value === 0
				? new Promise<void>((_resolve, reject) => {
						fail = reject;
					})
				: new Promise<void>((resolve) => {
						release = resolve;
					}),
		);
		await window.send(0);
		await window.send(1);
		fail(new Error("subscriber failed"));
		await Promise.resolve();
		await Promise.resolve();
		await expect(window.send(2)).rejects.toThrow("subscriber failed");
		let drained = false;
		const drain = window.drain().finally(() => {
			drained = true;
		});
		void drain.catch(() => {});
		await Promise.resolve();
		expect(drained).toBe(false);
		release();
		await expect(drain).rejects.toThrow("subscriber failed");
	});
});
