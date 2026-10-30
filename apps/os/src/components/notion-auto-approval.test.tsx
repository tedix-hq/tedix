import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ role: "owner", enabled: false }));
const api = vi.hoisted(() => ({
	mcpGovernance: {
		listActionTypeOptIns: vi.fn(async () => ({
			data: state.enabled ? [{ actionType: "notion_page_update" }] : [],
		})),
		setActionTypeOptIn: vi.fn(async (input: { enabled: boolean }) => {
			state.enabled = input.enabled;
			return input;
		}),
	},
}));
vi.mock("@/lib/api", () => ({ osApi: api }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: { role: state.role } },
	}),
}));
import { NotionAutoApproval } from "./notion-auto-approval";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	state.role = "owner";
	state.enabled = false;
	vi.clearAllMocks();
});

async function render() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<NotionAutoApproval />
			</QueryClientProvider>,
		),
	);
	await vi.waitFor(() =>
		expect(api.mcpGovernance.listActionTypeOptIns).toHaveBeenCalled(),
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return container.querySelector<HTMLButtonElement>('[role="switch"]')!;
}

describe("Notion automatic approval setting", () => {
	it("enables and disables the bounded Notion edit setting", async () => {
		const toggle = await render();
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await act(async () => toggle.click());
		await vi.waitFor(() =>
			expect(api.mcpGovernance.setActionTypeOptIn).toHaveBeenCalledWith({
				actionType: "notion_page_update",
				enabled: true,
			}),
		);
		await vi.waitFor(() =>
			expect(toggle.getAttribute("aria-checked")).toBe("true"),
		);
		await act(async () => toggle.click());
		await vi.waitFor(() =>
			expect(api.mcpGovernance.setActionTypeOptIn).toHaveBeenCalledWith({
				actionType: "notion_page_update",
				enabled: false,
			}),
		);
	});
	it("does not let a member change the organization setting", async () => {
		state.role = "member";
		const toggle = await render();
		expect(toggle.disabled).toBe(true);
		await act(async () => toggle.click());
		expect(api.mcpGovernance.setActionTypeOptIn).not.toHaveBeenCalled();
	});
});
