// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { waitForFixtureBrowser } from "./fixture-server-readiness";

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launch } }));
beforeEach(() => vi.clearAllMocks());

describe("fixture browser bootstrap", () => {
	it("waits for module loading and the shell within the remaining startup budget", async () => {
		const load = Promise.withResolvers<void>();
		const shell = Promise.withResolvers<void>();
		const waitFor = vi.fn((_options: { timeout: number }) => shell.promise);
		const locator = vi.fn((_selector: string) => ({ waitFor }));
		const goto = vi.fn(
			(_url: string, _options: { timeout: number }) => load.promise,
		);
		const close = vi.fn();
		launch.mockResolvedValue({
			newPage: async () => ({ on() {}, goto, locator }),
			close,
		});
		let ready = false;
		let budget = 80_000;
		const starting = waitForFixtureBrowser(
			"http://fixture.test",
			() => (budget -= 100),
		).then(() => {
			ready = true;
		});
		await vi.waitFor(() => expect(goto).toHaveBeenCalledOnce());
		expect(ready).toBe(false);
		expect(launch.mock.calls[0]![0].timeout).toBe(79_900);
		expect(goto.mock.calls[0]![1].timeout).toBe(79_800);
		load.resolve();
		await vi.waitFor(() => expect(waitFor).toHaveBeenCalledOnce());
		expect(locator).toHaveBeenCalledWith(".os-shell");
		expect(waitFor.mock.calls[0]![0].timeout).toBe(79_700);
		expect(ready).toBe(false);
		expect(close).not.toHaveBeenCalled();
		shell.resolve();
		await starting;
		expect(close).toHaveBeenCalledOnce();
	});

	it("closes the browser when bootstrap JavaScript fails", async () => {
		const close = vi.fn();
		launch.mockResolvedValue({
			newPage: async () => ({
				on(_event: string, callback: (error: Error) => void) {
					callback(new Error("Module failed"));
				},
				goto: async () => {},
			}),
			close,
		});
		await expect(
			waitForFixtureBrowser("http://fixture.test", () => 1000),
		).rejects.toThrow("Fixture bootstrap failed: Module failed");
		expect(close).toHaveBeenCalledOnce();
	});

	it("preserves navigation failure and closes the browser", async () => {
		const close = vi.fn();
		launch.mockResolvedValue({
			newPage: async () => ({
				on() {},
				goto: async () => {
					throw new Error("Module load timed out");
				},
			}),
			close,
		});
		await expect(
			waitForFixtureBrowser("http://fixture.test", () => 1000),
		).rejects.toThrow("Module load timed out");
		expect(close).toHaveBeenCalledOnce();
	});
});
