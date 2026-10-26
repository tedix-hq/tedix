import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ snooze: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { workInteractions: { snooze: mocks.snooze } },
}));
import { CardSnooze, tomorrowMorning } from "./card-snooze";
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	vi.resetAllMocks();
});
it("uses tomorrow's local morning rather than a fixed 24-hour delay", () => {
	const now = new Date(2026, 9, 25, 23, 30);
	const tomorrow = new Date(tomorrowMorning(now));
	expect([
		tomorrow.getFullYear(),
		tomorrow.getMonth(),
		tomorrow.getDate(),
		tomorrow.getHours(),
	]).toEqual([2026, 9, 26, 9]);
});
it("waits for the server snooze before refreshing and leaves a failed card visible", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onSnoozed = vi.fn(async () => {});
	mocks.snooze.mockRejectedValueOnce(new Error("changed"));
	await act(async () =>
		root.render(
			<CardSnooze request={{ id: "card", version: 3 }} onSnoozed={onSnoozed} />,
		),
	);
	const click = async (text: string) => {
		const button = [...document.querySelectorAll("button")].find(
			(node) => node.textContent === text,
		);
		expect(button).toBeDefined();
		await act(async () => button!.click());
	};
	await click("Snooze…");
	await click("Until tomorrow");
	expect(onSnoozed).not.toHaveBeenCalled();
	expect(document.querySelector('[role="alert"]')?.textContent).toContain(
		"Could not snooze",
	);
	mocks.snooze.mockResolvedValue({});
	await click("Until tomorrow");
	expect(mocks.snooze).toHaveBeenLastCalledWith({
		requestId: "card",
		expectedVersion: 3,
		until: tomorrowMorning(),
	});
	expect(onSnoozed).toHaveBeenCalledTimes(1);
});
