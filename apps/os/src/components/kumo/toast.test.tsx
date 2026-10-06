import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
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
});
