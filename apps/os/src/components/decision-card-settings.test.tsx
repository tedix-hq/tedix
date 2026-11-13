import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionCardSettings } from "./decision-card-settings";

const mocks = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsPreferences: () => ({
		query: {
			data: {
				preferences: {
					...DEFAULT_OS_USER_PREFERENCES,
					decisionCards: {
						language: "es",
						writingStyle: "Use short sentences.",
					},
				},
			},
		},
		save: { mutate: mocks.save, isPending: false, isError: false },
	}),
}));
vi.mock("@/lib/use-media-query", () => ({ useMediaQuery: () => false }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	vi.clearAllMocks();
});

it("saves only the person's writing choice while preserving their other settings", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<DecisionCardSettings open onOpenChange={() => {}} cardType="question" />,
		),
	);
	const input = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label="Writing style"]',
	)!;
	expect(input.value).toBe("Use short sentences.");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(input, "Explain the people affected.");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const save = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Save writing style",
	)!;
	await act(async () => save.click());
	expect(mocks.save).toHaveBeenCalledWith({
		...DEFAULT_OS_USER_PREFERENCES,
		decisionCards: {
			language: "es",
			writingStyle: "Explain the people affected.",
		},
	});
});
