import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	images: {
		requestUpload: vi.fn(),
		confirmUpload: vi.fn(),
		delete: vi.fn(),
	},
	organizations: {
		update: vi.fn(),
	},
}));

vi.mock("@/lib/api", () => ({ osApi: api }));

import { OrganizationProfileForm } from "./organization-profile-form";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots) {
		await act(async () => root.unmount());
	}
	roots.length = 0;
});

describe("OrganizationProfileForm", () => {
	it("announces invalid logo uploads to assistive technology", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});

		await act(async () => {
			root.render(
				<QueryClientProvider client={queryClient}>
					<OrganizationProfileForm
						organizationId="org-fictional"
						defaultValues={{ name: "Example", slug: "example" }}
					/>
				</QueryClientProvider>,
			);
		});

		const input =
			container.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error("Logo file input was not rendered");
		const file = new File(["not an image"], "notes.txt", {
			type: "text/plain",
		});
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [file],
		});

		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});

		expect(
			container.querySelector('[aria-live="assertive"]')?.textContent,
		).toContain("Please upload a PNG, JPEG, WebP, SVG, or GIF image");
	});
});
