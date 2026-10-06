// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runLoader } from "./loader-harness";

afterEach(() => {
	vi.restoreAllMocks();
});

const TENANT = { tedixTenant: "acme" };

describe("Tedix embed loader", () => {
	it("allows a new account to initialize after shutdown before runtime readiness", async () => {
		const first = (await runLoader()).Tedix;
		first.shutdown();
		expect((window as { Tedix?: unknown }).Tedix).toBeUndefined();
		const second = (await runLoader({ keepPage: true })).Tedix;
		expect(second).not.toBe(first);
		expect(second.loaderInvoked).toBe(true);
		expect(second.q).toEqual([]);
	});

	it("keeps calls a host queued before the loader arrived", async () => {
		const early = ["context", { pathname: "/orders" }];
		const { Tedix } = await runLoader({
			before: () =>
				((window as unknown as { Tedix: unknown }).Tedix = { q: [early] }),
		});
		expect(Tedix.q[0]).toBe(early);
	});

	it("installs a configured launcher without eagerly loading the runtime", async () => {
		const loader = await runLoader();
		// Nothing is painted before the host configures the widget.
		expect(loader.shell()).toBeNull();
		loader.Tedix.init({ tenant: "acme" });
		expect(loader.shell()).not.toBeNull();
		expect(loader.shell()!.style.visibility).toBe("hidden");
		expect(loader.shell()!.style.opacity).toBe("0");
		expect(loader.runtime()).toBeNull();
		loader.launcher()!.click();
		expect(loader.launcher()!.disabled).toBe(true);
		expect(loader.launcher()!.getAttribute("aria-busy")).toBe("true");
		const runtime = loader.runtime()!;
		expect(runtime.async).toBe(true);
		expect(runtime.crossOrigin).toBe("anonymous");
		expect(runtime.src).toBe("https://widget.tedix.dev/embed.js");
		expect(loader.script.nextElementSibling).toBe(runtime);
		expect(loader.Tedix.q).toContainEqual(["open"]);
		expect(loader.Tedix.status()).toMatchObject({
			state: "loading",
			mounted: false,
		});
	});

	it("honours an explicit runtime URL", async () => {
		const loader = await runLoader({
			dataset: {
				...TENANT,
				tedixPreload: "open",
				tedixRuntime: "https://cdn.example/r.js",
			},
		});
		expect(loader.runtime()?.src).toBe("https://cdn.example/r.js");
	});

	it("boots static data-tenant embeds immediately", async () => {
		const loader = await runLoader({ dataset: TENANT });
		expect(loader.Tedix.q[0]).toEqual(["boot", { script: loader.script }]);
		expect(loader.shell()).not.toBeNull();
	});

	it("preserves an early open intent until configuration is queued", async () => {
		const loader = await runLoader();
		loader.Tedix.open();
		expect(loader.runtime()).toBeNull();
		expect(loader.Tedix.q).toEqual([]);
		loader.Tedix.init({ tenant: "acme" });
		expect(loader.Tedix.q.map((entry: unknown[]) => entry[0])).toEqual([
			"init",
			"open",
		]);
		expect(loader.runtime()).not.toBeNull();
	});

	it.each(["open", "idle", "eager"])(
		"loads the runtime for the documented %s preload mode",
		async (preload) => {
			const loader = await runLoader({
				dataset: { ...TENANT, tedixPreload: preload },
			});
			expect(loader.runtime()).not.toBeNull();
		},
	);

	it("waits for interaction without a preload mode", async () => {
		const loader = await runLoader({ dataset: TENANT });
		expect(loader.runtime()).toBeNull();
	});

	it("queues the complete public lifecycle before runtime readiness", async () => {
		const loader = await runLoader();
		const { Tedix } = loader;
		for (const method of [
			"boot",
			"init",
			"update",
			"context",
			"consent",
			"track",
			"close",
			"off",
		])
			expect(Tedix[method]({ method })).toBe(Tedix);
		expect(Tedix.q.map((entry: unknown[]) => entry[0])).toEqual([
			"boot",
			"init",
			"update",
			"context",
			"consent",
			"track",
			"close",
			"off",
		]);
		const callback = () => {};
		const off = Tedix.on("ready", callback);
		expect(Tedix.q.at(-1)).toEqual(["on", "ready", callback]);
		off();
		expect(Tedix.q.at(-1)).toEqual(["off", "ready", callback]);
		for (const method of [
			"identify",
			"ask",
			"deleteConversation",
			"capabilities",
			"attachCapability",
			"detachCapability",
			"artifactPins",
			"pinArtifactRevision",
			"detachArtifactPin",
		]) {
			const pending = Tedix[method]("argument");
			expect(pending).toBeInstanceOf(Promise);
			expect(Tedix.q.at(-1)).toMatchObject({ method, args: ["argument"] });
			pending.catch(() => {});
		}
		expect(loader.runtime()).not.toBeNull();
	});

	it("rejects a duplicate loader", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const first = await runLoader();
		const second = await runLoader({ keepPage: true });
		expect(second.Tedix).toBe(first.Tedix);
		expect(warn).toHaveBeenCalledWith("Tedix loader already loaded.");
	});

	it("hands a static embed straight to a runtime that is already loaded", async () => {
		const boot = vi.fn();
		const loader = await runLoader({
			dataset: TENANT,
			before: () =>
				((window as unknown as { Tedix: unknown }).Tedix = {
					runtimeLoaded: true,
					boot,
				}),
		});
		expect(boot).toHaveBeenCalledWith({ script: loader.script });
		expect(loader.shell()).toBeNull();
	});

	it("emits a typed load failure, rejects waiting calls, and lets the visitor retry", async () => {
		const loader = await runLoader({ dataset: TENANT });
		const failures: Array<Record<string, unknown>> = [];
		window.addEventListener("tedix:error", (event) =>
			failures.push((event as CustomEvent).detail),
		);
		const answer = loader.Tedix.ask("Hello");
		loader.runtime()!.dispatchEvent(new Event("error"));
		await expect(answer).rejects.toMatchObject({ code: "runtime_load_failed" });
		expect(failures).toEqual([
			{
				code: "runtime_load_failed",
				phase: "runtime",
				durationMs: expect.any(Number),
			},
		]);
		expect(failures[0]!.durationMs).toBeGreaterThanOrEqual(0);
		// Replayable calls survive for the retry; the launcher works again.
		expect(loader.Tedix.q[0]).toEqual(["boot", { script: loader.script }]);
		expect(loader.launcher()!.disabled).toBe(false);
		expect(loader.launcher()!.hasAttribute("aria-busy")).toBe(false);
		loader.runtime()!.remove();
		loader.launcher()!.click();
		expect(loader.runtime()).not.toBeNull();
	});

	it("cancels an in-flight runtime and every queued call on shutdown", async () => {
		const loader = await runLoader({ dataset: TENANT });
		const answer = loader.Tedix.ask("Hello");
		expect(loader.runtime()).not.toBeNull();
		loader.Tedix.shutdown();
		await expect(answer).rejects.toMatchObject({ code: "widget_shutdown" });
		expect(loader.runtime()).toBeNull();
		expect(loader.shell()).toBeNull();
		expect(loader.Tedix.q).toEqual([]);
		// Unconfigured again: an open waits for the next account's configuration.
		loader.Tedix.open();
		expect(loader.runtime()).toBeNull();
	});

	it("hands the runtime a monotonic loader start for end-to-end timings", async () => {
		const before = performance.now();
		const { Tedix } = await runLoader();
		expect(Tedix.startedAt).toBeGreaterThanOrEqual(before);
		expect(Tedix.startedAt).toBeLessThanOrEqual(performance.now());
	});

	it("gives way to the runtime once it is ready", async () => {
		const loader = await runLoader({ dataset: TENANT });
		window.dispatchEvent(new Event("tedix:ready"));
		expect(loader.shell()).toBeNull();
	});
});
