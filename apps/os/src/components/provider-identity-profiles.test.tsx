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
	it("explains that a profile alone does not run a check or enable approval", () => {
		const markup = renderToStaticMarkup(<ProviderIdentityProfiles canChange />);
		expect(markup).toContain("Review identity profile");
		expect(markup).toContain(
			"do not yet enable automatic approval or run an identity check",
		);
	});
	it("hides review controls from a read-only viewer", () => {
		const markup = renderToStaticMarkup(
			<ProviderIdentityProfiles canChange={false} />,
		);
		expect(markup).not.toContain("Review identity profile");
	});
});
