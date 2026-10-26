import { act, useRef } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useFocusFeedShortcuts } from "./use-focus-feed-shortcuts";

vi.mock("@/lib/webmcp/use-app-webmcp-tools", () => ({
	useAppWebMcpTools: vi.fn(),
}));

it("keeps shortcuts with their focused interaction and invokes each owned action once", async () => {
	const action = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	function Fixture() {
		const feed = useRef<HTMLDivElement>(null);
		useFocusFeedShortcuts(feed);
		return (
			<>
				<button data-shell>Shell</button>
				<div ref={feed} tabIndex={0} data-feed>
					<button>Feed filter</button>
					{["first", "second"].map((id) => (
						<div key={id} data-focus-row={id} tabIndex={-1}>
							<a
								href="#source"
								onClick={(e) => {
									e.preventDefault();
									action(id, "open");
								}}
							>
								Source
							</a>
							{["Pin", "Hide", "Not important"].map((name) => (
								<button
									key={name}
									aria-label={name}
									onClick={() => action(id, name)}
								>
									{name}
								</button>
							))}
							<input aria-label="Edit" />
							<div contentEditable suppressContentEditableWarning tabIndex={0}>
								Draft
							</div>
							<div role="listbox" tabIndex={0}>
								<div role="option" aria-selected={false}>
									Option
								</div>
							</div>
						</div>
					))}
					{createPortal(
						<div role="dialog" tabIndex={-1}>
							<button>Dialog control</button>
						</div>,
						document.body,
					)}
					{createPortal(
						<div role="menu">
							<div role="menuitem" tabIndex={0}>
								Pin
							</div>
						</div>,
						document.body,
					)}
				</div>
			</>
		);
	}
	const press = async (key: string, init: KeyboardEventInit = {}) => {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
			...init,
		});
		await act(async () => {
			document.activeElement!.dispatchEvent(event);
		});
		return event.defaultPrevented;
	};
	try {
		await act(async () => root.render(<Fixture />));
		const feed = host.querySelector<HTMLElement>("[data-feed]")!;
		const rows = [...host.querySelectorAll<HTMLElement>("[data-focus-row]")];
		const foreign = [
			host.querySelector<HTMLElement>("[data-shell]")!,
			feed.querySelector<HTMLElement>("button")!,
			...rows[0]!.querySelectorAll<HTMLElement>(
				"a,button,input,[contenteditable],[role=listbox]",
			),
			document.querySelector<HTMLElement>("[role=dialog]")!,
			document.querySelector<HTMLElement>("[role=dialog] button")!,
			document.querySelector<HTMLElement>("[role=menuitem]")!,
		];
		for (const control of foreign) {
			control.focus();
			for (const key of ["j", "k", "o", "p", "h", "n"]) {
				expect(await press(key)).toBe(false);
				expect(document.activeElement).toBe(control);
			}
		}
		expect(action).not.toHaveBeenCalled();
		feed.focus();
		for (const key of ["o", "p", "h", "n"])
			expect(await press(key)).toBe(false);
		expect(action).not.toHaveBeenCalled();
		expect(await press("j")).toBe(true);
		expect(document.activeElement).toBe(rows[0]);
		await press("j");
		expect(document.activeElement).toBe(rows[1]);
		await press("k");
		expect(document.activeElement).toBe(rows[0]);
		for (const [key, name] of [
			["o", "open"],
			["p", "Pin"],
			["h", "Hide"],
			["n", "Not important"],
		]) {
			action.mockClear();
			expect(await press(key!)).toBe(true);
			expect(action.mock.calls).toEqual([["first", name]]);
			await press(key!, { repeat: true });
			expect(action).toHaveBeenCalledTimes(1);
		}
		for (const init of [
			{ ctrlKey: true },
			{ altKey: true },
			{ metaKey: true },
			{ shiftKey: true },
			{ isComposing: true },
		]) {
			expect(await press("p", init)).toBe(false);
		}
		const consumed = (event: KeyboardEvent) => event.preventDefault();
		rows[0]!.addEventListener("keydown", consumed);
		action.mockClear();
		await press("p");
		expect(action).not.toHaveBeenCalled();
		rows[0]!.removeEventListener("keydown", consumed);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
