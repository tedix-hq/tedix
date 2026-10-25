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

	it("treats a composer emptied by a send as clean", () => {
		dispose.push(trackOsInput(document));
		const composer = document.createElement("textarea");
		document.body.append(composer);
		composer.value = "Summarise the week";
		composer.dispatchEvent(new Event("input", { bubbles: true }));
		expect(hasUnsavedOsInput(document)).toBe(true);
		// The send clears the still-mounted composer.
		composer.value = "";
		expect(hasUnsavedOsInput(document)).toBe(false);
	});

	it("ignores reload-safe widget frames unless they report dirty", () => {
		dispose.push(trackOsInput(document));
		const widget = document.createElement("iframe");
		widget.setAttribute("data-os-reload-safe", "");
		document.body.append(widget);
		expect(hasUnsavedOsInput(document)).toBe(false);
		widget.setAttribute("data-os-dirty", "true");
		expect(hasUnsavedOsInput(document)).toBe(true);
		widget.remove();
		// Any other embedded frame may hold its own state and still counts.
		document.body.append(document.createElement("iframe"));
		expect(hasUnsavedOsInput(document)).toBe(true);
	});
});
