import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { DocEditorUpgrade } from "./doc-editor-upgrade";
import { osQueryKeys } from "@/lib/os-query-options";

const install = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			gadgets: { installOutputEditor: install },
			blueprints: { get: vi.fn() },
		},
	},
}));
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLElement;
let client: QueryClient;
beforeEach(() => {
	install.mockReset();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
});
afterEach(() => {
	act(() => root.unmount());
	document.body.replaceChildren();
	client.clear();
});

const mount = () =>
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<DocEditorUpgrade
					workspaceId="workspace"
					outputId="output"
					gadgetId="gadget"
					revisionId="pinned-app-revision"
				/>
			</QueryClientProvider>,
		),
	);
const click = (text: string) =>
	act(async () => {
		const button = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find((node) => node.textContent?.trim() === text);
		expect(button).toBeDefined();
		button!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

describe("explicit Doc editor upgrade", () => {
	it("never upgrades on load and requires review of what happens to unsaved edits", async () => {
		mount();
		expect(install).not.toHaveBeenCalled();
		await click("Upgrade Doc editor");
		expect(document.body.textContent).toContain(
			"keeping the same document, app and revision history",
		);
		expect(document.body.textContent).toContain(
			"Unsaved edits in this view will be discarded",
		);
		expect(install).not.toHaveBeenCalled();
	});
	it("guards the app revision and refreshes generated gadget/code and blueprint keys", async () => {
		install.mockResolvedValue({ gadget: { id: "gadget" } });
		const invalidate = vi
			.spyOn(client, "invalidateQueries")
			.mockResolvedValue();
		mount();
		await click("Upgrade Doc editor");
		await click("Upgrade editor");
		await vi.waitFor(() =>
			expect(install).toHaveBeenCalledWith({
				workspaceId: "workspace",
				outputId: "output",
				kind: "document",
				upgradeFromRevisionId: "pinned-app-revision",
			}),
		);
		await vi.waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: osQueryKeys.gadgets(),
			}),
		);
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: osQueryKeys.blueprints(),
		});
	});
	it("keeps a revision conflict visible for review without claiming the editor upgraded", async () => {
		install.mockRejectedValue(new Error("App revision changed"));
		mount();
		await click("Upgrade Doc editor");
		await click("Upgrade editor");
		await vi.waitFor(() =>
			expect(document.body.textContent).toContain("App revision changed"),
		);
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	});
});
