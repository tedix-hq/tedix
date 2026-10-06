import { afterEach, describe, expect, it } from "vite-plus/test";
import { installViewportMetrics } from "./viewport-metrics";

type FakeViewport = {
	height: number;
	offsetTop: number;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
	emit: (type: string) => void;
	listenerCount: () => number;
};

function createFakeViewport(height: number, offsetTop = 0): FakeViewport {
	const listeners = new Map<string, Set<() => void>>();
	return {
		height,
		offsetTop,
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emit(type) {
			for (const listener of listeners.get(type) ?? []) listener();
		},
		listenerCount() {
			let total = 0;
			for (const set of listeners.values()) total += set.size;
			return total;
		},
	};
}

function installFakeViewport(viewport: FakeViewport | undefined) {
	Object.defineProperty(window, "visualViewport", {
		configurable: true,
		value: viewport,
	});
}

/**
 * The module coalesces its writes into `requestAnimationFrame`, so tests drive
 * the frame themselves instead of waiting on a timer.
 */
function runFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

const read = (property: string) =>
	document.documentElement.style.getPropertyValue(property);

afterEach(() => {
	installFakeViewport(undefined);
	document.documentElement.removeAttribute("style");
});

describe("installViewportMetrics", () => {
	it("publishes the visible rectangle on install", () => {
		window.innerHeight = 800;
		installFakeViewport(createFakeViewport(800));

		const teardown = installViewportMetrics();

		expect(read("--viewport-tedix-height")).toBe("800px");
		expect(read("--viewport-tedix-top")).toBe("0px");
		expect(read("--viewport-tedix-bottom")).toBe("0px");
		teardown();
	});

	it("reports the region a software keyboard covers", async () => {
		window.innerHeight = 800;
		const viewport = createFakeViewport(800);
		installFakeViewport(viewport);
		const teardown = installViewportMetrics();

		viewport.height = 460;
		viewport.emit("resize");
		await runFrame();

		expect(read("--viewport-tedix-height")).toBe("460px");
		expect(read("--viewport-tedix-bottom")).toBe("340px");
		teardown();
	});

	it("tracks a viewport scrolled away from the layout origin", async () => {
		window.innerHeight = 800;
		const viewport = createFakeViewport(500, 120);
		installFakeViewport(viewport);
		const teardown = installViewportMetrics();

		viewport.emit("scroll");
		await runFrame();

		expect(read("--viewport-tedix-top")).toBe("120px");
		expect(read("--viewport-tedix-bottom")).toBe("180px");
		teardown();
	});

	it("never publishes a negative bottom inset", async () => {
		// Some browsers report a visual viewport taller than `innerHeight` while
		// URL-bar chrome retracts; the covered region is still zero.
		window.innerHeight = 800;
		const viewport = createFakeViewport(860);
		installFakeViewport(viewport);
		const teardown = installViewportMetrics();

		viewport.emit("resize");
		await runFrame();

		expect(read("--viewport-tedix-bottom")).toBe("0px");
		teardown();
	});

	it("removes its listeners and properties on teardown", () => {
		window.innerHeight = 800;
		const viewport = createFakeViewport(800);
		installFakeViewport(viewport);

		const teardown = installViewportMetrics();
		expect(viewport.listenerCount()).toBe(2);
		teardown();

		expect(viewport.listenerCount()).toBe(0);
		expect(read("--viewport-tedix-height")).toBe("");
		expect(read("--viewport-tedix-bottom")).toBe("");
	});

	it("is inert where the visual viewport is unavailable", () => {
		installFakeViewport(undefined);

		const teardown = installViewportMetrics();

		expect(read("--viewport-tedix-height")).toBe("");
		expect(() => teardown()).not.toThrow();
	});
});
