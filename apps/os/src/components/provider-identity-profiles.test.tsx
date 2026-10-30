import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/lib/use-media-query", async (importOriginal) => importOriginal());
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
	useQuery: () => ({ data: { items: [], data: [] }, isError: false }),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		mcpGovernance: {
			prepareProviderIdentityProfile: vi.fn(),
			createProviderIdentityProfile: vi.fn(),
			revokeProviderIdentityProfile: vi.fn(),
		},
	},
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		mcpServer: { previewToolScopes: { queryOptions: () => ({}) } },
		mcpGovernance: {
			listProviderIdentityProfiles: { queryOptions: () => ({}), key: () => [] },
		},
	},
	appListQueryOptions: () => ({}),
}));
import { ProviderIdentityProfiles } from "./provider-identity-profiles";

describe("provider identity profiles", () => {
	it.each([
		[false, "right"],
		[true, "bottom"],
	] as const)(
		"opens and closes the %s viewport sheet",
		async (mobile, side) => {
			const matchMedia = vi
				.spyOn(window, "matchMedia")
				.mockImplementation((query) => ({
					matches: query === "(max-width: 639px)" && mobile,
					media: query,
					onchange: null,
					addListener: () => {},
					removeListener: () => {},
					addEventListener: () => {},
					removeEventListener: () => {},
					dispatchEvent: () => true,
				}));
			const host = document.createElement("div");
			document.body.append(host);
			const root = createRoot(host);
			try {
				await act(async () =>
					root.render(<ProviderIdentityProfiles canChange />),
				);
				expect(document.querySelector('[role="dialog"]')).toBeNull();
				await act(async () => host.querySelector("button")!.click());
				const dialog = document.querySelector('[role="dialog"]');
				expect(dialog?.getAttribute("data-side")).toBe(side);
				expect(dialog?.textContent).toContain("Review account check");
				expect(
					dialog?.querySelector('input[aria-label="Account check action"]'),
				).not.toBeNull();
				expect(
					dialog?.querySelector('label[for="identity-paths"]')?.textContent,
				).toContain("Fields that identify the account");
				expect(dialog?.textContent).toContain("workspace.id");
				expect(dialog?.querySelector("button:disabled")?.textContent).toContain(
					"Review account check",
				);
				await act(async () =>
					document.dispatchEvent(
						new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
					),
				);
				expect(document.querySelector('[role="dialog"]')).toBeNull();
			} finally {
				await act(async () => root.unmount());
				host.remove();
				matchMedia.mockRestore();
			}
		},
	);
	it("explains that a profile alone does not run a check or enable approval", () => {
		const markup = renderToStaticMarkup(<ProviderIdentityProfiles canChange />);
		expect(markup).toContain("Add account check");
		expect(markup).toContain("does not run it or enable automatic approval");
	});
	it("hides review controls from a read-only viewer", () => {
		const markup = renderToStaticMarkup(
			<ProviderIdentityProfiles canChange={false} />,
		);
		expect(markup).not.toContain("Add account check");
	});
});
