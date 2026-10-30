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
		expect(markup).toContain("Review tool");
		expect(markup).toContain("A saved rule can apply to matching calls");
		expect(markup).toContain("Permissions and other safeguards still apply");
		expect(markup).not.toContain("not yet active in tool execution");
	});
	it("does not expose rule controls to a read-only viewer", () => {
		const markup = renderToStaticMarkup(
			<TenantToolPolicies canChange={false} />,
		);
		expect(markup).not.toContain("Review tool");
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
		expect(markup).toContain("Research agent");
		expect(markup).toContain("Refresh machine sessions");
	});
});
