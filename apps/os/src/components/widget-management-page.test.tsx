import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("@/components/widget-contacts", () => ({
	WidgetContacts: ({ onAudience }: { onAudience: (id: string) => void }) => (
		<>
			<button onClick={() => onAudience("business-a")}>Edit A</button>
			<button onClick={() => onAudience("business-b")}>Edit B</button>
		</>
	),
}));
vi.mock("@/components/widget-access-settings", () => ({
	WidgetAccessSettings: ({
		initialBusinessId,
	}: {
		initialBusinessId?: string;
	}) => {
		// Match the real editor's mount-time initialization to detect stale targeting.
		const [business] = useState(initialBusinessId);
		return <p>Editing {business ?? "all businesses"}</p>;
	},
}));
vi.mock("@/components/portable-webmcp-builder", () => ({
	PortableWebMcpBuilder: () => <p>Route configuration</p>,
}));
import { WidgetManagementPage } from "./widget-management-page";
import {
	osQuery,
	operationalContextQueryOptions,
	organizationDetailQueryOptions,
	providerCapacitySponsorshipsQueryOptions,
	widgetLifecycleHealthQueryOptions,
	appAnalyticsRange,
} from "@/lib/os-query-options";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});
it("targets the selected customer after returning from another audience editor", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	// Seed only fields this page reads; editor internals have their own tests.
	const seed = (key: QueryKey, value: unknown) =>
		client.setQueryData(key, value);
	seed(operationalContextQueryOptions().queryKey, {
		organization: { id: "provider" },
	});
	seed(organizationDetailQueryOptions("provider").queryKey, {
		id: "provider",
		name: "Acme",
		metadata: {},
	});
	seed(providerCapacitySponsorshipsQueryOptions().queryKey, {
		data: ["staging", "production"].map((installationId) => ({
			installationId,
			externalTenantId: "8042",
			policy: null,
			readiness: { status: "disabled" },
		})),
	});
	seed(
		osQuery.tedis.listWidgetAccessConfigurations.queryOptions({ input: {} })
			.queryKey,
		{
			data: [
				{
					installationId: "staging",
					businessName: "Demo garage",
					allowedOrigin: "https://staging.example.com",
				},
				{
					installationId: "production",
					businessName: "Live garage",
					allowedOrigin: "https://example.com",
				},
			],
		},
	);
	seed(widgetLifecycleHealthQueryOptions(appAnalyticsRange()).queryKey, {
		status: "no_data",
	});
	seed(
		widgetLifecycleHealthQueryOptions({
			...appAnalyticsRange(),
			installationId: "staging",
		}).queryKey,
		{ status: "no_data" },
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
		client.clear();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<WidgetManagementPage />
			</QueryClientProvider>,
		);
	});
	const click = async (label: string) => {
		const button = Array.from(
			container.querySelectorAll<HTMLButtonElement>("button"),
		).find((entry) => entry.textContent === label);
		expect(button, label).toBeDefined();
		await act(async () => {
			button!.click();
		});
	};
	expect(
		Array.from(container.querySelectorAll('[role="tab"]')).map(
			(tab) => tab.textContent,
		),
	).toEqual(["Customize", "Customers", "Funding", "Performance"]);
	expect(
		container.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
	).toBe("Customize");
	await act(async () => {
		const field = container.querySelector<HTMLInputElement>(
			'[aria-label="Assistant name"]',
		)!;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(field, "Unsaved assistant");
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await click("Customers");
	await click("Edit A");
	expect(container.textContent).toContain("Editing business-a");
	await click("Back to customers");
	await click("Edit B");
	expect(container.textContent).toContain("Editing business-b");
	expect(container.textContent).not.toContain("Editing business-a");
	await click("Back to customers");
	await click("Manage audience");
	expect(container.textContent).toContain("Editing all businesses");
	await click("Performance");
	expect(container.textContent).toContain("Assistant performance");
	expect(container.textContent).toContain("Performance analytics");
	const customerFilter = container.querySelector<HTMLButtonElement>(
		'[aria-label="Customer app"]',
	)!;
	expect(customerFilter.textContent).toContain("All customer apps");
	await act(async () => {
		customerFilter.click();
	});
	const demoOption = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]'),
	).find((option) => option.textContent?.includes("Demo garage"));
	expect(demoOption).toBeDefined();
	await act(async () => {
		demoOption!.click();
	});
	expect(customerFilter.textContent).toContain(
		"Demo garage · staging.example.com",
	);
	expect(customerFilter.textContent).not.toBe("staging");

	await click("Funding");
	expect(container.textContent).not.toContain("Performance analytics");
	expect(container.textContent).toContain("Demo garage");
	expect(container.textContent).toContain("https://staging.example.com");
	expect(container.textContent).toContain("Live garage");
	expect(container.textContent).not.toContain("Tenant 8042");
	expect(container.textContent).not.toContain("Route configuration");
	await click("Customize");
	const advanced = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Advanced",
	);
	expect(advanced?.getAttribute("aria-expanded")).toBe("false");
	await click("Advanced");
	expect(advanced?.getAttribute("aria-expanded")).toBe("true");
	expect(container.textContent).toContain("Route configuration");
	await click("Customize");
	expect(
		(
			container.querySelector(
				'[aria-label="Assistant name"]',
			) as HTMLInputElement
		).value,
	).toBe("Unsaved assistant");
});
