import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { CardContextFeedback } from "./card-context-feedback";

const { cardContext } = vi.hoisted(() => ({ cardContext: vi.fn() }));
vi.mock("@/lib/api", () => ({ osApi: { learningFeedback: { cardContext } } }));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const NEXT_CARD_ID = "22222222-2222-4222-8222-222222222222";
const SAVED = "Noted. Repeated feedback shapes this kind of card.";
const CHIPS = [
	["who", "Who"],
	["why_now", "Why now"],
	["cost", "Cost"],
	["risk", "Risk"],
	["draft", "The draft"],
	["too_long", "Too long"],
] as const;
const cleanups: Array<() => void> = [];

beforeEach(() => cardContext.mockReset().mockResolvedValue(undefined));
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	const render = async (cardId: string) => {
		await act(async () => {
			// DecisionDeckApp keys feedback by the selected card's id.
			root.render(<CardContextFeedback key={cardId} cardId={cardId} />);
		});
	};
	await render(CARD_ID);
	const button = (name: string) => {
		const found = [...host.querySelectorAll("button")].find(
			(element) =>
				(element.getAttribute("aria-label") ?? element.textContent) === name,
		);
		expect(found, `button named ${name}`).toBeDefined();
		return found!;
	};
	return { host, render, button };
}

async function click(button: HTMLButtonElement) {
	await act(async () => button.click());
}

function expectUnsaved(host: HTMLElement) {
	expect(host.textContent).not.toContain(SAVED);
	expect(host.querySelector("a")).toBeNull();
}

function expectSaved(host: HTMLElement) {
	expect(host.textContent).toContain(SAVED);
	expect(host.querySelector("[role=status]")).toBeNull();
	expect(host.querySelectorAll("button")).toHaveLength(0);
	const link = host.querySelector("a");
	expect(link?.textContent).toBe("Your learned rules");
	expect(link?.getAttribute("href")).toBe("/brain");
}

describe("CardContextFeedback", () => {
	it("disables both named answers while saving enough context and ignores a repeat click", async () => {
		const request = deferred();
		cardContext.mockReturnValueOnce(request.promise);
		const { host, button } = await mount();
		expect(cardContext).not.toHaveBeenCalled();
		expect(host.textContent).toContain("Enough to decide?");
		const enough = button("Enough context");
		const notEnough = button("Not enough context");
		expect(enough.disabled).toBe(false);
		expect(notEnough.disabled).toBe(false);
		await click(enough);
		expect(enough.disabled).toBe(true);
		expect(notEnough.disabled).toBe(true);
		expectUnsaved(host);
		expect(host.querySelector("[role=status]")).toBeNull();
		await click(enough);
		await click(notEnough);
		expect(cardContext).toHaveBeenCalledExactlyOnceWith({
			cardId: CARD_ID,
			clientEventId: expect.any(String),
			enough: true,
			chip: undefined,
		});
		await act(async () => request.resolve());
		expectSaved(host);
	});

	it.each(CHIPS)(
		"saves not-enough context followed by the %s chip",
		async (chip, label) => {
			const request = deferred();
			cardContext.mockReturnValueOnce(request.promise);
			const { host, button } = await mount();
			await click(button("Not enough context"));
			expect(cardContext).toHaveBeenNthCalledWith(1, {
				cardId: CARD_ID,
				clientEventId: expect.any(String),
				enough: false,
				chip: undefined,
			});
			expect(host.querySelectorAll("button")).toHaveLength(2);
			expectUnsaved(host);
			await act(async () => request.resolve());
			expectUnsaved(host);
			for (const [, name] of CHIPS) expect(button(name).disabled).toBe(false);

			const chipRequest = deferred();
			cardContext.mockReturnValueOnce(chipRequest.promise);
			await click(button(label));
			for (const control of host.querySelectorAll("button")) {
				expect(control.disabled).toBe(true);
			}
			expectUnsaved(host);
			await click(button(label));
			expect(cardContext).toHaveBeenCalledTimes(2);
			expect(cardContext).toHaveBeenNthCalledWith(2, {
				cardId: CARD_ID,
				clientEventId: expect.any(String),
				enough: false,
				chip,
			});
			await act(async () => chipRequest.resolve());
			expectSaved(host);
		},
	);

	it("shows failure without success and waits for an explicit enough-context retry", async () => {
		const request = deferred();
		cardContext.mockReturnValueOnce(request.promise);
		const { host, button } = await mount();
		await click(button("Enough context"));
		await act(async () => request.reject(new Error("save unavailable")));
		expect(host.querySelector("[role=status]")?.textContent).toBe(
			"Could not save. Try again.",
		);
		expectUnsaved(host);
		expect(button("Enough context").disabled).toBe(false);
		expect(button("Not enough context").disabled).toBe(false);
		expect(cardContext).toHaveBeenCalledTimes(1);

		const retry = deferred();
		cardContext.mockReturnValueOnce(retry.promise);
		await click(button("Enough context"));
		expect(host.querySelector("[role=status]")).toBeNull();
		expectUnsaved(host);
		expect(button("Enough context").disabled).toBe(true);
		expect(cardContext).toHaveBeenCalledTimes(2);
		for (const [payload] of cardContext.mock.calls) {
			expect(payload).toEqual({
				cardId: CARD_ID,
				enough: true,
				chip: undefined,
				clientEventId: expect.any(String),
			});
		}
		await act(async () => retry.resolve());
		expectSaved(host);
	});

	it("keeps chips available after a failed chip save and retries the chosen payload", async () => {
		const { host, button } = await mount();
		await click(button("Not enough context"));
		cardContext.mockRejectedValueOnce(new Error("chip save unavailable"));
		await click(button("Why now"));
		expectUnsaved(host);
		expect(host.querySelector("[role=status]")?.textContent).toBe(
			"Could not save. Try again.",
		);
		for (const [, name] of CHIPS) expect(button(name).disabled).toBe(false);
		expect(cardContext).toHaveBeenCalledTimes(2);
		await click(button("Why now"));
		expect(cardContext).toHaveBeenCalledTimes(3);
		for (const call of [2, 3]) {
			expect(cardContext).toHaveBeenNthCalledWith(call, {
				cardId: CARD_ID,
				enough: false,
				chip: "why_now",
				clientEventId: expect.any(String),
			});
		}
		expectSaved(host);
	});

	it.each(["saved", "chips", "failed"] as const)(
		"starts a keyed replacement fresh after %s feedback",
		async (state) => {
			const { host, render, button } = await mount();
			if (state === "failed")
				cardContext.mockRejectedValueOnce(new Error("unavailable"));
			await click(
				button(state === "chips" ? "Not enough context" : "Enough context"),
			);
			await render(NEXT_CARD_ID);
			expectUnsaved(host);
			expect(host.querySelector("[role=status]")).toBeNull();
			expect(host.querySelectorAll("button")).toHaveLength(2);
			expect(button("Enough context").disabled).toBe(false);
			expect(button("Not enough context").disabled).toBe(false);
			expect(cardContext).toHaveBeenCalledTimes(1);
			await click(button("Enough context"));
			expect(cardContext).toHaveBeenNthCalledWith(2, {
				cardId: NEXT_CARD_ID,
				enough: true,
				chip: undefined,
				clientEventId: expect.any(String),
			});
			expectSaved(host);
		},
	);

	it("cannot mark the replacement saved when an unmounted card's request resolves", async () => {
		const oldRequest = deferred();
		cardContext.mockReturnValueOnce(oldRequest.promise);
		const { host, render, button } = await mount();
		await click(button("Enough context"));
		await render(NEXT_CARD_ID);
		expect(button("Enough context").disabled).toBe(false);
		expectUnsaved(host);
		await act(async () => oldRequest.resolve());
		expectUnsaved(host);
		expect(host.querySelectorAll("button")).toHaveLength(2);
		expect(host.querySelector("[role=status]")).toBeNull();
		expect(cardContext).toHaveBeenCalledTimes(1);
		await click(button("Not enough context"));
		expect(cardContext).toHaveBeenNthCalledWith(2, {
			cardId: NEXT_CARD_ID,
			enough: false,
			chip: undefined,
			clientEventId: expect.any(String),
		});
		expect(button("Who").disabled).toBe(false);
		expectUnsaved(host);
	});
});
