import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
	useQuery: () => ({ data: { items: [], data: [] }, isError: false }),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		mcpGovernance: {
			prepareTenantToolPolicy: vi.fn(),
			createTenantToolPolicy: vi.fn(),
			revokeTenantToolPolicy: vi.fn(),
		},
	},
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		mcpServer: { previewToolScopes: { queryOptions: () => ({}) } },
		mcpGovernance: {
			listTenantToolPolicies: { queryOptions: () => ({}), key: () => [] },
			listDeletedTenantPolicyFences: {
				queryOptions: () => ({}),
				key: () => [],
			},
			listProviderIdentityProfiles: { queryOptions: () => ({}) },
			listMachineProviderProbes: { queryOptions: () => ({}) },
			listMachinePolicyInventory: { queryOptions: () => ({}) },
		},
	},
	appListQueryOptions: () => ({}),
}));
import {
	MachineInventoryPicker,
	TenantToolPolicies,
} from "./tenant-tool-policies";

describe("tenant tool policies", () => {
	it("explains when saved rules can apply and retains other safeguards", () => {
		const markup = renderToStaticMarkup(<TenantToolPolicies canChange />);
		expect(markup).toContain("Add rule");
		expect(markup).toContain("Rules for connected apps");
		expect(markup).toContain("Permissions and other safeguards still apply");
		expect(markup).not.toContain("not yet active in tool execution");
	});
	it("does not expose rule controls to a read-only viewer", () => {
		const markup = renderToStaticMarkup(
			<TenantToolPolicies canChange={false} />,
		);
		expect(markup).not.toContain("Add rule");
	});
	it("labels machine choices and reports loading, empty and error states", () => {
		const base = {
			items: [],
			value: "",
			onChange: vi.fn(),
			onRefresh: vi.fn(),
		};
		expect(
			renderToStaticMarkup(
				<MachineInventoryPicker {...base} loading error={false} />,
			),
		).toContain("Loading active machines");
		expect(
			renderToStaticMarkup(
				<MachineInventoryPicker {...base} loading={false} error />,
			),
		).toContain("Could not load machine sessions");
		expect(
			renderToStaticMarkup(
				<MachineInventoryPicker {...base} loading={false} error={false} />,
			),
		).toContain("No active machine sessions");
		const markup = renderToStaticMarkup(
			<MachineInventoryPicker
				{...base}
				value={JSON.stringify(["p", "s", "c", "server"])}
				loading={false}
				error={false}
				items={[
					{
						principalId: "p",
						principalName: "Research agent",
						sessionId: "s",
						clientRecordId: "c",
						mcpServerId: "server",
					},
				]}
			/>,
		);
		expect(markup).toContain('for="native-machine-session"');
		expect(markup).toContain('id="native-machine-session"');
		expect(markup).toContain('role="combobox"');
		expect(markup).toContain("Research agent");
		expect(markup).toContain("Refresh machine sessions");
	});
	it("selects the exact machine registration and disables selection while unavailable", async () => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		const props = {
			items: [
				{
					principalId: "p",
					principalName: "Research agent",
					sessionId: "s",
					clientRecordId: "c",
					mcpServerId: "server",
				},
			],
			value: "",
			onChange,
			onRefresh: vi.fn(),
		};
		try {
			await act(async () =>
				root.render(
					<MachineInventoryPicker {...props} loading={false} error={false} />,
				),
			);
			const trigger =
				container.querySelector<HTMLButtonElement>("[role=combobox]")!;
			expect(trigger.disabled).toBe(false);
			await act(async () => trigger.click());
			const option = [
				...document.querySelectorAll<HTMLElement>("[role=option]"),
			].find((item) => item.textContent?.includes("Research agent"));
			expect(option).toBeTruthy();
			await act(async () => option!.click());
			expect(onChange).toHaveBeenCalledWith(
				JSON.stringify(["p", "s", "c", "server"]),
			);
			for (const state of [
				{ loading: true, error: false },
				{ loading: false, error: true },
			]) {
				await act(async () =>
					root.render(<MachineInventoryPicker {...props} {...state} />),
				);
				expect(
					container.querySelector<HTMLButtonElement>("[role=combobox]")!
						.disabled,
				).toBe(true);
			}
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
