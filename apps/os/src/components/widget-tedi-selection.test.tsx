import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps } from "react";
import { WidgetTediSelection } from "./widget-tedi-selection";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
function render(props: ComponentProps<typeof WidgetTediSelection>) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => root.render(<WidgetTediSelection {...props} />));
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}
function clickChoice(container: HTMLElement, name: string) {
	const label = [...container.querySelectorAll("label")].find(
		(label) => label.textContent === name,
	);
	const checkbox = label?.querySelector<HTMLElement>(
		'[role="checkbox"],input[type="checkbox"]',
	);
	expect(checkbox).toBeTruthy();
	act(() => checkbox!.click());
}
describe("widget worker configuration", () => {
	it("lets an administrator remove an unavailable configured worker", () => {
		const onChange = vi.fn();
		const container = render({
			value: { defaultTediId: "old", allowedTediIds: ["old", "new"] },
			tedis: [{ id: "new", name: "Current worker" }],
			onChange,
		});
		expect(container.querySelector('[role="combobox"]')?.textContent).toContain(
			"Unavailable tedi (old)",
		);
		clickChoice(container, "Unavailable tedi (old)");
		expect(onChange).toHaveBeenCalledWith({
			defaultTediId: "new",
			allowedTediIds: ["new"],
		});
	});
	it("makes an administrator's first choice the default", () => {
		const onChange = vi.fn();
		const container = render({
			tedis: [{ id: "new", name: "Current worker" }],
			onChange,
		});
		clickChoice(container, "Current worker");
		expect(onChange).toHaveBeenCalledWith({
			defaultTediId: "new",
			allowedTediIds: ["new"],
		});
	});
});
