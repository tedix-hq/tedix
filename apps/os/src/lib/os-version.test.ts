import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installOsVersionChecks, OS_VERSION_POLL_MS } from "./os-version";
import { hasUnsavedOsInput, trackOsInput } from "./reload-safety";

const dispose: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of dispose.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function setup() {
	const fetchVersion = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify({ sha: "b".repeat(40) })));
	const notify = vi.fn();
	dispose.push(
		installOsVersionChecks({ buildSha: "a".repeat(40), fetchVersion, notify }),
	);
	return { fetchVersion, notify };
}

describe("OS version checks", () => {
	it("offers the new version on focus and every ten minutes without duplicate notices", async () => {
		vi.useFakeTimers();
		const { fetchVersion, notify } = setup();
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(0);
		expect(notify).toHaveBeenCalledWith("b".repeat(40));
		await vi.advanceTimersByTimeAsync(OS_VERSION_POLL_MS);
		expect(fetchVersion).toHaveBeenCalledTimes(2);
		expect(fetchVersion).toHaveBeenCalledWith(
			"/version.json",
			expect.objectContaining({ cache: "no-store" }),
		);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("ignores unchanged versions, HTML fallbacks and network failures and tries again", async () => {
		vi.useFakeTimers();
		const { fetchVersion, notify } = setup();
		fetchVersion
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ sha: "a".repeat(40) })),
			)
			.mockResolvedValueOnce(new Response("<html>"))
			.mockRejectedValueOnce(new Error("offline"));
		for (let attempt = 0; attempt < 4; attempt++) {
			window.dispatchEvent(new Event("focus"));
			await vi.advanceTimersByTimeAsync(0);
		}
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("removes polling and focus listeners on cleanup", async () => {
		vi.useFakeTimers();
		const { fetchVersion } = setup();
		dispose.pop()?.();
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(OS_VERSION_POLL_MS);
		expect(fetchVersion).not.toHaveBeenCalled();
	});
});

describe("reload input safety", () => {
	it("protects restored drafts and edits even after their editor unmounts", () => {
		dispose.push(trackOsInput(document));
		expect(hasUnsavedOsInput(document)).toBe(false);
		const textarea = document.createElement("textarea");
		textarea.value = "restored draft";
		document.body.append(textarea);
		expect(hasUnsavedOsInput(document)).toBe(true);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		textarea.remove();
		expect(hasUnsavedOsInput(document)).toBe(true);
	});
});
