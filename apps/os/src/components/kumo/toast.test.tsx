import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { osToastManager, toast, Toaster } from "./toast";

function flush() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OS Kumo toast adapter", () => {
	let container: HTMLDivElement | undefined;
	let root: ReturnType<typeof createRoot> | undefined;

	afterEach(() => {
		osToastManager.close();
		root?.unmount();
		container?.remove();
		root = undefined;
		container = undefined;
	});

	it("renders imperative success and error feedback through Kumo Toasty", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(<Toaster />);
			await flush();
		});

		await act(async () => {
			toast.success("Workspace created");
			toast.error("Workspace could not be created");
			await flush();
		});

		expect(document.querySelectorAll("[data-toast-title]")).toHaveLength(2);
		expect(document.body.textContent).toContain("Workspace created");
		expect(document.body.textContent).toContain(
			"Workspace could not be created",
		);
	});

	it("keeps loading feedback visible until callers dismiss it", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(<Toaster />);
			await flush();
		});

		const id = toast.loading("Creating workspace");
		await act(async () => {
			await flush();
		});
		expect(document.body.textContent).toContain("Creating workspace");

		act(() => toast.dismiss(id));
	});

	it("keeps loading feedback past the default timeout while success expires", async () => {
		vi.useFakeTimers();
		try {
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
			await act(async () => {
				root?.render(<Toaster />);
				await vi.advanceTimersByTimeAsync(0);
			});

			await act(async () => {
				toast.success("Workspace created");
				toast.loading("Creating workspace", { id: "loading-lifetime" });
				await vi.advanceTimersByTimeAsync(0);
			});
			expect(document.querySelectorAll("[data-toast-title]")).toHaveLength(2);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			expect(document.body.textContent).toContain("Creating workspace");
			expect(document.body.textContent).not.toContain("Workspace created");

			await act(async () => {
				toast.dismiss("loading-lifetime");
				await vi.advanceTimersByTimeAsync(1_000);
			});
			expect(document.body.textContent).not.toContain("Creating workspace");
		} finally {
			vi.useRealTimers();
		}
	});

	it("portals into its own body-level outlet that scopes the phone close target", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(<Toaster />);
			await flush();
		});
		await act(async () => {
			toast.error("Workspace could not be created");
			await flush();
		});

		const outlet = document.querySelector<HTMLElement>(
			"[data-os-toast-outlet]",
		);
		expect(outlet?.parentElement).toBe(document.body);
		expect(outlet?.className).toContain(
			"[&_[data-kumo-part=close]]:max-sm:size-11",
		);
		expect(
			outlet?.querySelector('[data-kumo-part="close"][aria-label="Close"]'),
		).not.toBeNull();
		expect(
			outlet?.querySelector('[role="region"]')?.getAttribute("aria-live"),
		).toBe("polite");

		act(() => root?.unmount());
		root = undefined;
		expect(document.querySelector("[data-os-toast-outlet]")).toBeNull();
	});
});
