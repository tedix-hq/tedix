import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const outputsApi = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { outputs: outputsApi } },
}));

import { CanvasOutputTitle } from "./canvas-output-title";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function mount() {
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<CanvasOutputTitle outputId={OUTPUT_ID} title="Weekly report" />
			</QueryClientProvider>,
		),
	);
	const input = container.querySelector<HTMLInputElement>(
		'input[aria-label="Document title"]',
	)!;
	const type = async (value: string) =>
		act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			setter.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	const key = async (name: string) =>
		act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: name, bubbles: true }),
			);
			await Promise.resolve();
		});
	return {
		input,
		type,
		key,
		invalidate,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("CanvasOutputTitle", () => {
	it("renames the open output on Enter and refreshes output reads", async () => {
		outputsApi.rename.mockResolvedValue({
			output: { id: OUTPUT_ID, title: "Q4 report" },
		});
		const view = await mount();
		expect(view.input.value).toBe("Weekly report");
		view.input.focus();
		await view.type("  Q4 report ");
		await view.key("Enter");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
		expect(outputsApi.rename).toHaveBeenCalledWith(
			{ outputId: OUTPUT_ID, title: "Q4 report" },
			expect.anything(),
		);
		expect(view.invalidate).toHaveBeenCalled();
		view.unmount();
	});

	it("keeps the name on Escape or when cleared", async () => {
		outputsApi.rename.mockClear();
		const view = await mount();
		view.input.focus();
		await view.type("Something else");
		await view.key("Escape");
		expect(view.input.value).toBe("Weekly report");
		view.input.focus();
		await view.type("   ");
		await view.key("Enter");
		expect(view.input.value).toBe("Weekly report");
		expect(outputsApi.rename).not.toHaveBeenCalled();
		view.unmount();
	});
});
