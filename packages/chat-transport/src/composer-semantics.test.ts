import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	isImeComposingKey,
	isNearBottom,
	observeScrollResize,
	STICKY_SCROLL_THRESHOLD_PX,
} from "./composer-semantics";

describe("observeScrollResize", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("follows nonzero resized geometry only while pinned and stops after cleanup", () => {
		let resize = () => {};
		const observe = vi.fn();
		const disconnect = vi.fn();
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resize = callback;
				}
				observe = observe;
				disconnect = disconnect;
			},
		);
		const element = {
			scrollHeight: 1000,
			clientHeight: 400,
			scrollTop: 600,
		} as HTMLElement;
		let following = true;
		const dispose = observeScrollResize(element, () => following);
		expect(observe).toHaveBeenCalledWith(element);
		Object.assign(element, { scrollHeight: 1600, clientHeight: 300 });
		resize();
		expect(element.scrollTop).toBe(1600);
		following = false;
		element.scrollTop = 100;
		Object.assign(element, { scrollHeight: 1800 });
		resize();
		expect(element.scrollTop).toBe(100);
		following = true;
		dispose();
		resize();
		expect(element.scrollTop).toBe(100);
		expect(disconnect).toHaveBeenCalledOnce();
	});

	it("is inert without browser resize observation", () => {
		vi.stubGlobal("ResizeObserver", undefined);
		const element = { scrollHeight: 1000, scrollTop: 100 } as HTMLElement;
		observeScrollResize(element, () => true)();
		expect(element.scrollTop).toBe(100);
	});
});

describe("isImeComposingKey", () => {
	it("holds Enter while an IME reports composition", () => {
		expect(isImeComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
	});

	/**
	 * The regression this module exists for. The embedded widget checked only
	 * `isComposing`, so on a browser that reports composition solely through
	 * keyCode 229 — older Safari, several Android IMEs — Enter submitted a
	 * half-composed word instead of choosing the candidate.
	 */
	it("holds Enter when keyCode 229 is the only composition signal", () => {
		expect(isImeComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
		expect(isImeComposingKey({ keyCode: 229 })).toBe(true);
	});

	it("lets an ordinary Enter through", () => {
		expect(isImeComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
		expect(isImeComposingKey({})).toBe(false);
	});
});

describe("isNearBottom", () => {
	const at = (scrollTop: number) => ({
		scrollHeight: 1000,
		clientHeight: 400,
		scrollTop,
	});

	it("counts the exact bottom and the threshold edge as pinned", () => {
		expect(isNearBottom(at(600))).toBe(true);
		expect(isNearBottom(at(600 - STICKY_SCROLL_THRESHOLD_PX))).toBe(true);
	});

	it("detaches one pixel past the threshold", () => {
		expect(isNearBottom(at(600 - STICKY_SCROLL_THRESHOLD_PX - 1))).toBe(false);
	});

	it("treats a container shorter than its viewport as pinned", () => {
		expect(
			isNearBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 }),
		).toBe(true);
	});

	it("honors a caller-supplied threshold", () => {
		expect(isNearBottom(at(500), 100)).toBe(true);
		expect(isNearBottom(at(500), 10)).toBe(false);
	});
});
