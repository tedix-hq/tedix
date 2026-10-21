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
		const confirm = vi.fn().mockReturnValue(false);
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
		const click = () =>
			action?.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
		click();
		expect(confirm).toHaveBeenCalledOnce();
		expect(reload).not.toHaveBeenCalled();
		confirm.mockReturnValue(true);
		click();
		expect(reload).toHaveBeenCalledOnce();
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
