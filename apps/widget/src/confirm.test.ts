import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { confirmPortableWrite } from "./embed/confirm.mjs";

type Confirm = (
	root: unknown,
	tool: unknown,
	preview: unknown,
	signal?: AbortSignal,
) => Promise<boolean>;

/** The published module against a document that hands out this dialog. */
function withDialog(dialog: unknown): Confirm {
	vi.stubGlobal("document", { createElement: () => dialog });
	return confirmPortableWrite as unknown as Confirm;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("portable write confirmation", () => {
	it.each(["yes", "no", ""])(
		"names the dialog before opening and requires explicit acceptance (%s)",
		async (returnValue) => {
			const controller = new AbortController();
			const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
			const title = { textContent: "" };
			const summary = { textContent: "" };
			const cancel = { focus: vi.fn() };
			const confirm = { textContent: "" };
			const attributes = new Map<string, string>();
			let nameAtOpen: string | undefined;
			let close = () => {};
			const dialog = {
				dataset: {},
				innerHTML: "",
				returnValue,
				setAttribute: (name: string, value: string) =>
					attributes.set(name, value),
				querySelectorAll: () => [title, summary, cancel, confirm],
				addEventListener: (event: string, handler: () => void) => {
					expect(event).toBe("close");
					close = handler;
				},
				showModal: vi.fn(() => {
					nameAtOpen = attributes.get("aria-label");
				}),
				remove: vi.fn(),
			};
			const root = { querySelector: () => null, append: vi.fn() };
			const execute = withDialog(dialog);
			const result = execute(
				root,
				{
					action: {
						confirmationTitle: "Update this order?",
						confirmationLabel: "Update",
					},
				},
				{ id: "order-1" },
				controller.signal,
			);
			expect(dialog.showModal).toHaveBeenCalledOnce();
			expect(cancel.focus).toHaveBeenCalledOnce();
			expect(root.append).toHaveBeenCalledWith(dialog);
			close();
			await expect(result).resolves.toBe(returnValue === "yes");
			expect(nameAtOpen).toBe("Update this order?");
			expect(title.textContent).toBe("Update this order?");
			expect(dialog.remove).toHaveBeenCalledOnce();
			expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
			controller.abort();
			expect(dialog.remove).toHaveBeenCalledOnce();
		},
	);
	it.each([true, false])(
		"dismisses aborted confirmation (already aborted=%s)",
		async (alreadyAborted) => {
			const controller = new AbortController();
			if (alreadyAborted) controller.abort();
			const removeAbort = vi.spyOn(controller.signal, "removeEventListener");
			let close = () => {};
			const dialog = {
				dataset: {},
				innerHTML: "",
				returnValue: "yes",
				setAttribute: vi.fn(),
				querySelectorAll: () => [{}, {}, { focus: vi.fn() }, {}],
				addEventListener: (_event: string, handler: () => void) => {
					close = handler;
				},
				showModal: vi.fn(),
				remove: vi.fn(),
			};
			const root = { querySelector: () => null, append: vi.fn() };
			const execute = withDialog(dialog);
			const result = execute(
				root,
				{
					action: { confirmationTitle: "Update?", confirmationLabel: "Update" },
				},
				{},
				controller.signal,
			);
			if (alreadyAborted) {
				expect(dialog.showModal).not.toHaveBeenCalled();
				expect(root.append).not.toHaveBeenCalled();
			} else {
				expect(dialog.showModal).toHaveBeenCalledOnce();
				controller.abort();
				expect(dialog.remove).toHaveBeenCalledOnce();
				expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
				close(); // A queued close event must not turn abort into approval.
				expect(dialog.remove).toHaveBeenCalledOnce();
			}
			await expect(result).resolves.toBe(false);
		},
	);
});
