import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({ list: vi.fn(), move: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			outputs: { move: api.move },
			gadgets: {},
			workspaces: { list: api.list },
		},
	},
}));

import { MoveOutputDialog } from "./output-move-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const outputId = "22222222-2222-4222-8222-222222222222";
const here = "11111111-1111-4111-8111-111111111111";
const there = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
	document.body.replaceChildren();
	vi.clearAllMocks();
});

const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** Let queries and effects settle until `ready` holds, so a busy machine cannot race the test. */
async function until(ready: () => boolean) {
	for (let turn = 0; turn < 200 && !ready(); turn++) await settle();
}

async function setup() {
	api.list.mockResolvedValue({
		items: [
			{ id: here, name: "Drafts" },
			{ id: there, name: "Launch" },
		],
		truncated: false,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockResolvedValue(undefined);
	const onClose = vi.fn();
	const onMoved = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	act(() =>
		createRoot(host).render(
			<QueryClientProvider client={client}>
				<MoveOutputDialog
					outputId={outputId}
					title="Plan"
					workspaceId={here}
					onClose={onClose}
					onMoved={onMoved}
				/>
			</QueryClientProvider>,
		),
	);
	const choices = () => [
		...document.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
	];
	await until(() => choices().length > 0);
	const button = (label: string) =>
		[...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent === label,
		)!;
	const click = async (node: HTMLElement) => {
		await act(async () => node.click());
		await settle();
	};
	/** Confirm the picked workspace and wait for the server's answer. */
	const move = async (label: string) => {
		await click(button(label));
		await until(
			() =>
				onMoved.mock.calls.length > 0 ||
				document.querySelector("[data-move-error]") !== null,
		);
	};
	return { choices, button, click, move, invalidate, onClose, onMoved };
}

describe("MoveOutputDialog", () => {
	it("offers the other active workspaces and moves the file to the chosen one", async () => {
		api.move.mockResolvedValue({});
		const view = await setup();
		expect(api.list.mock.calls[0]![0]).toEqual({
			status: "active",
			limit: 100,
		});
		// The workspace the file is already in is not a choice.
		expect(view.choices().map((node) => node.textContent)).toEqual(["Launch"]);
		expect(view.button("Move").disabled).toBe(true);
		await view.click(view.choices()[0]!);
		expect(view.choices()[0]!.getAttribute("aria-checked")).toBe("true");
		await view.move("Move to Launch");
		expect(api.move).toHaveBeenCalledWith({ outputId, workspaceId: there });
		expect(view.onMoved).toHaveBeenCalledWith({ id: there, name: "Launch" });
		expect(view.onClose).toHaveBeenCalledTimes(1);
		expect(view.invalidate).toHaveBeenCalledTimes(2);
	});

	it("shows the server's reason when the move is refused and keeps the picker open", async () => {
		api.move.mockRejectedValue(
			Object.assign(new Error("Output transfer already in progress"), {
				code: "CONFLICT",
			}),
		);
		const view = await setup();
		await view.click(view.choices()[0]!);
		await view.move("Move to Launch");
		expect(document.querySelector("[data-move-error]")?.textContent).toBe(
			"Output transfer already in progress",
		);
		expect(view.onMoved).not.toHaveBeenCalled();
		expect(view.onClose).not.toHaveBeenCalled();
	});

	it("tells a view-only person they may not move the file", async () => {
		api.move.mockRejectedValue(
			Object.assign(new Error("Missing permission"), { code: "FORBIDDEN" }),
		);
		const view = await setup();
		await view.click(view.choices()[0]!);
		await view.move("Move to Launch");
		expect(document.querySelector("[data-move-error]")?.textContent).toContain(
			"You are not allowed to move this file",
		);
	});
});
