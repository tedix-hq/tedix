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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("OS reload notices", () => {
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
		expect(event.defaultPrevented).toBe(true);
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
