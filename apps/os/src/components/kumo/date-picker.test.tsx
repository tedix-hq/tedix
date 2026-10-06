import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { DateTimePicker } from "./date-picker";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ host: HTMLElement; root: Root }> = [];

afterEach(() => {
	while (mounted.length > 0) {
		const entry = mounted.pop();
		if (!entry) break;
		act(() => entry.root.unmount());
		entry.host.remove();
	}
});

function render(element: React.ReactElement): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	act(() => root.render(element));
	return host;
}

function click(node: Element | null | undefined) {
	if (!node) throw new Error("missing node");
	act(() => {
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

function byLabel<T extends Element>(label: string): T | null {
	return document.querySelector<T>(`[aria-label="${label}"]`);
}

function timeField(): HTMLInputElement {
	const field = byLabel<HTMLInputElement>("Link expiry time");
	if (!field) throw new Error("time field missing");
	return field;
}

function setTime(value: string) {
	const field = timeField();
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function dayCell(day: string): HTMLButtonElement | null {
	return document.querySelector<HTMLButtonElement>(
		`td[data-day="${day}"] button`,
	);
}

describe("DateTimePicker", () => {
	it("renders an empty, clearless control for a null value", () => {
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={null}
				onChange={() => {}}
				placeholder="No expiry"
			/>,
		);

		const trigger = byLabel<HTMLButtonElement>("Link expiry");
		expect(trigger).not.toBeNull();
		expect(trigger?.textContent).toContain("No expiry");
		// "No expiry" is a legitimate state, so nothing to clear yet.
		expect(byLabel("Clear Link expiry")).toBeNull();
		expect(timeField().value).toBe("23:59");
	});

	it("shows the selected instant with its time of day and clears to null", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 2, 3, 4)}
				onChange={onChange}
			/>,
		);

		expect(timeField().value).toBe("03:04");
		const trigger = byLabel<HTMLButtonElement>("Link expiry");
		expect(trigger?.textContent).toContain("2099");

		click(byLabel("Clear Link expiry"));
		expect(onChange).toHaveBeenCalledWith(null);
	});

	it("preserves the chosen time of day when the day changes", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 2, 3, 4)}
				onChange={onChange}
			/>,
		);

		click(byLabel("Link expiry"));
		click(dayCell("2099-01-09"));

		const next = onChange.mock.calls[0]?.[0] as Date;
		expect(next.getFullYear()).toBe(2099);
		expect(next.getMonth()).toBe(0);
		expect(next.getDate()).toBe(9);
		expect(next.getHours()).toBe(3);
		expect(next.getMinutes()).toBe(4);
	});

	it("defaults a fresh day selection to the end of that day", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={null}
				onChange={onChange}
				min={new Date(2099, 0, 1, 10, 0)}
			/>,
		);

		click(byLabel("Link expiry"));
		click(dayCell("2099-01-15"));

		const next = onChange.mock.calls[0]?.[0] as Date;
		expect(next.getDate()).toBe(15);
		expect(next.getHours()).toBe(23);
		expect(next.getMinutes()).toBe(59);
	});

	it("writes a new instant when only the time of day changes", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 2, 3, 4)}
				onChange={onChange}
			/>,
		);

		setTime("08:30");

		const next = onChange.mock.calls[0]?.[0] as Date;
		expect(next.getDate()).toBe(2);
		expect(next.getHours()).toBe(8);
		expect(next.getMinutes()).toBe(30);
	});

	it("keeps the instant when the time field is emptied", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 2, 3, 4)}
				onChange={onChange}
			/>,
		);

		setTime("");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("floors selection at min: earlier days are disabled and the floor day carries a time min", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 10, 14, 0)}
				onChange={onChange}
				min={new Date(2099, 0, 10, 9, 30)}
			/>,
		);

		// Same day as the floor, so the time field advertises the floor's clock.
		expect(timeField().getAttribute("min")).toBe("09:30");

		click(byLabel("Link expiry"));
		expect(dayCell("2099-01-09")?.disabled).toBe(true);
		expect(dayCell("2099-01-11")?.disabled).toBe(false);
	});

	it("clamps a selection that would land below the floor", () => {
		const onChange = vi.fn();
		render(
			<DateTimePicker
				aria-label="Link expiry"
				// 06:00 carried onto the floor day would be in the past.
				value={new Date(2099, 0, 20, 6, 0)}
				onChange={onChange}
				min={new Date(2099, 0, 10, 9, 30, 45)}
			/>,
		);

		click(byLabel("Link expiry"));
		click(dayCell("2099-01-10"));

		const next = onChange.mock.calls[0]?.[0] as Date;
		expect(next.getDate()).toBe(10);
		// 09:30:45 is not expressible in an HH:MM field, so the floor rounds up.
		expect(next.getHours()).toBe(9);
		expect(next.getMinutes()).toBe(31);
	});

	it("disables every affordance together", () => {
		render(
			<DateTimePicker
				aria-label="Link expiry"
				value={new Date(2099, 0, 2, 3, 4)}
				onChange={vi.fn()}
				disabled
			/>,
		);

		expect(byLabel<HTMLButtonElement>("Link expiry")?.disabled).toBe(true);
		expect(timeField().disabled).toBe(true);
		expect(byLabel<HTMLButtonElement>("Clear Link expiry")?.disabled).toBe(
			true,
		);
	});
});
