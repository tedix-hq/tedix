import { lazyRouteComponent } from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { osToastManager } from "@/components/kumo/toast";
import { reloadOnceForStaleChunk } from "@/components/os-route-boundaries";
import { installOsVersionNotice } from "./os-version-notice";

vi.mock("@/components/os-route-boundaries", () => ({
	reloadOnceForStaleChunk: vi.fn(),
}));
let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	document.body.replaceChildren();
	window.sessionStorage.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("OS reload notices", () => {
	it.each(["clean", "draft", "guarded", "leaving"])(
		"keeps a failed Vite import rejected and respects recovery for a %s tab",
		async (state) => {
			const { reloadOnceForStaleChunk: recover, OS_CHUNK_RELOAD_GUARD_KEY } =
				await vi.importActual<typeof import("./os-route-boundaries")>(
					"./os-route-boundaries",
				);
			vi.mocked(reloadOnceForStaleChunk).mockImplementation(recover);
			const reload = vi
				.spyOn(window.location, "reload")
				.mockImplementation(() => {});
			const input = document.createElement("textarea");
			input.value = state === "draft" ? "unfinished draft" : "";
			document.body.append(input);
			cleanup = installOsVersionNotice();
			if (state === "guarded")
				window.sessionStorage.setItem(OS_CHUNK_RELOAD_GUARD_KEY, "1");
			if (state === "leaving") window.dispatchEvent(new Event("beforeunload"));
			const failure = new TypeError(
				"Failed to fetch dynamically imported module: /assets/old-route.js",
			);
			const component = lazyRouteComponent(async () => {
				// Vite's emitted handlePreloadError returns undefined when cancelled.
				const event = Object.assign(
					new Event("vite:preloadError", { cancelable: true }),
					{ payload: failure },
				);
				window.dispatchEvent(event);
				if (!event.defaultPrevented) throw failure;
				return undefined as unknown as Record<string, () => null>;
			}, "component");
			await component.preload?.();
			expect(() => renderToStaticMarkup(createElement(component))).toThrow(
				failure,
			);
			expect(reload).toHaveBeenCalledTimes(state === "clean" ? 1 : 0);
			expect(input.value).toBe(state === "draft" ? "unfinished draft" : "");
		},
	);

	it("handles preload failure and shows a persistent Kumo Reload action when recovery is blocked", () => {
		vi.mocked(reloadOnceForStaleChunk).mockReturnValue(false);
		const add = vi.spyOn(osToastManager, "add");
		const reload = vi
			.spyOn(window.location, "reload")
			.mockImplementation(() => {});
		const confirm = vi.fn();
		vi.stubGlobal("confirm", confirm);
		cleanup = installOsVersionNotice();
		const event = new Event("vite:preloadError", { cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(reloadOnceForStaleChunk).toHaveBeenCalledTimes(1);
		const options = add.mock.calls[0]?.[0];
		expect(options).toMatchObject({
			timeout: 0,
			title: "Reload Tedix OS to recover this view",
		});
		const action = options?.actions?.[0];
		expect(action?.children).toBe("Reload");
		const input = document.createElement("textarea");
		input.value = "draft";
		document.body.append(input);
		const event_ = {} as React.MouseEvent<HTMLButtonElement>;
		action?.onClick?.(event_);
		// The draft fence asks inside the toast, never with a blocking confirm().
		expect(confirm).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
		const ask = add.mock.calls[1]?.[0];
		expect(ask).toMatchObject({
			timeout: 0,
			title: "Reload Tedix OS anyway?",
		});
		const [reloadAnyway, cancel] = ask?.actions ?? [];
		expect(reloadAnyway?.children).toBe("Reload anyway");
		expect(cancel?.children).toBe("Cancel");
		cancel?.onClick?.(event_);
		expect(reload).not.toHaveBeenCalled();
		expect(add.mock.calls[2]?.[0]).toMatchObject({
			title: "Reload Tedix OS to recover this view",
		});
		reloadAnyway?.onClick?.(event_);
		expect(reload).toHaveBeenCalledOnce();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("reloads at once when nothing on the page is unsaved", () => {
		const add = vi.spyOn(osToastManager, "add");
		const reload = vi
			.spyOn(window.location, "reload")
			.mockImplementation(() => {});
		vi.mocked(reloadOnceForStaleChunk).mockReturnValue(false);
		cleanup = installOsVersionNotice();
		window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
		add.mock.calls[0]?.[0]?.actions?.[0]?.onClick?.(
			{} as React.MouseEvent<HTMLButtonElement>,
		);
		expect(reload).toHaveBeenCalledOnce();
		expect(add).toHaveBeenCalledOnce();
	});

	it("recovers a clean tab without a notice and removes the preload listener on cleanup", () => {
		vi.mocked(reloadOnceForStaleChunk).mockReturnValue(true);
		const add = vi.spyOn(osToastManager, "add");
		cleanup = installOsVersionNotice();
		window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
		expect(add).not.toHaveBeenCalled();
		cleanup();
		cleanup = undefined;
		vi.mocked(reloadOnceForStaleChunk).mockClear();
		window.dispatchEvent(new Event("vite:preloadError"));
		expect(reloadOnceForStaleChunk).not.toHaveBeenCalled();
	});
});
