import type {
	CatalogAppDetail,
	CatalogMcpToolWithMetrics,
} from "@tedix/api-contract/schemas/catalog";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vite-plus/test";
const installMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({
	osApi: {
		apps: { list: vi.fn() },
		catalog: { installFromCatalog: installMock },
	},
}));
import {
	InstallButton,
	CatalogAboutSection,
	CatalogAppMetadata,
	CatalogToolList,
} from "./app-store-detail-page";

describe("App Store tool inventory", () => {
	it("renders compact divided rows without nested cards", () => {
		const tool: CatalogMcpToolWithMetrics = {
			id: "tool-1",
			toolName: "search_catalog",
			description: "Searches the catalog.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
			detectedAt: "2026-08-23T00:00:00.000Z",
			lastSeenAt: "2026-08-23T00:00:00.000Z",
			removedAt: null,
			lastTestedAt: "2026-08-23T00:00:00.000Z",
			testSuccessRate: 0.95,
			avgLatencyMs: 120,
			testCount: 20,
			exampleInput: null,
			exampleOutput: null,
		};
		const html = renderToStaticMarkup(<CatalogToolList tools={[tool]} />);

		expect(html).toContain('aria-label="MCP tools"');
		expect(html).toContain('data-slot="collection"');
		expect(html).toContain("<ul");
		expect(html).toContain("<li");
		expect(html).toContain("search_catalog");
		expect(html).toContain("Read-only");
		expect(html).toContain("95% success");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("App Store metadata", () => {
	it("uses one bounded surface for details, listings, and links", () => {
		const app = {
			status: "public",
			connectorType: "MCP",
			developerType: "official",
			mcpToolCount: 23,
			mcpResourceCount: 2,
			healthUptimePercent: 99.9,
			healthConnectTimeMs: 140,
			mcpServerName: "Arabica",
			mcpServerVersion: "1.0.0",
			baseUrl: "https://arabica.example/mcp",
			installability: { installable: true, reason: "Installable" },
			storeListings: [
				{
					id: "listing-1",
					source: "openai",
					storeUrl: "https://example.com/store",
					regions: ["US"],
				},
			],
			website: "https://example.com",
			privacyPolicy: "https://example.com/privacy",
			termsOfService: "https://example.com/terms",
		} as unknown as CatalogAppDetail;
		const html = renderToStaticMarkup(<CatalogAppMetadata app={app} />);

		expect(html).toContain('aria-label="App metadata"');
		expect(html).toContain("Store listings (1)");
		expect(html).toContain('aria-label="Store listings"');
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain("Privacy policy");
		expect(html.match(/data-slot="card"/g)).toHaveLength(1);
		expect(html).toContain('rel="noopener noreferrer"');
	});
});

describe("App Store About section", () => {
	it("renders editorial copy without decorative card chrome", () => {
		const html = renderToStaticMarkup(
			<CatalogAboutSection content="A calm, readable product description." />,
		);

		expect(html).toContain('aria-labelledby="catalog-about-heading"');
		expect(html).toContain("A calm, readable product description.");
		expect(html).toContain("max-w-3xl");
		expect(html).not.toContain('data-slot="card"');
	});
});

describe("Organization installation review", () => {
	it("opens a scoped review and cancels without installing", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const client = new QueryClient();
		try {
			await act(async () => {
				root.render(
					<QueryClientProvider client={client}>
						<InstallButton
							appId="catalog-example"
							name="Example"
							disabled={false}
							reason=""
						/>
					</QueryClientProvider>,
				);
			});
			const review = container.querySelector("button")!;
			expect(review.textContent).toContain("Review installation");
			await act(async () => {
				review.click();
			});
			expect(document.body.textContent).toContain(
				"Install Example for this organization?",
			);
			expect(document.body.textContent).toContain(
				"does not connect a personal or shared account",
			);
			const cancel = Array.from(document.body.querySelectorAll("button")).find(
				(button) => button.textContent === "Cancel",
			)!;
			expect(cancel).toBeDefined();
			await act(async () => {
				cancel.click();
			});
			expect(container.textContent).toContain("Review installation");
			expect(installMock).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			container.remove();
			client.clear();
		}
	});
});

it("installs only after confirmation, with private visibility, and keeps failed review open", async () => {
	installMock.mockReset();
	installMock.mockRejectedValue(new Error("Permission denied"));
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	try {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<InstallButton
						appId="catalog-example"
						name="Example"
						disabled={false}
						reason=""
					/>
				</QueryClientProvider>,
			);
		});
		await act(async () => {
			container.querySelector("button")!.click();
		});
		expect(installMock).not.toHaveBeenCalled();
		const confirm = Array.from(document.body.querySelectorAll("button")).find(
			(button) => button.textContent === "Install for organization",
		)!;
		await act(async () => {
			confirm.click();
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(installMock).toHaveBeenCalledExactlyOnceWith({
			catalogAppId: "catalog-example",
			visibility: "private",
		});
		expect(document.body.textContent).toContain(
			"Installation failed. You can retry or cancel.",
		);
		expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
		client.clear();
		installMock.mockReset();
	}
});

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
