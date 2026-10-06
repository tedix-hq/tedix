import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	userConnectionsQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import {
	WorkspaceResourcesPanel,
	availabilityLabel,
	resourceReferenceSchema,
} from "./workspace-resources-panel";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("WorkspaceResourcesPanel", () => {
	it("reserves reconnect language for an actually expired connection", () => {
		expect(availabilityLabel("missing_connection")).toBe("Connect app");
		expect(availabilityLabel("expired_connection")).toBe("Reconnect app");
		expect(availabilityLabel("check_failed")).toBe(
			"Could not check connection",
		);
		expect(availabilityLabel("not_executable")).toBe("Unavailable");
	});

	it("keeps repository setup paired and ignores it for other resources", () => {
		const base = {
			providerKey: "github:tenant",
			resourceType: "repository",
			providerResourceId: "12345",
			name: "Source code",
			githubFullName: "owner/repo",
			githubInstallationId: "",
		};
		expect(resourceReferenceSchema.safeParse(base).success).toBe(false);
		expect(
			resourceReferenceSchema.safeParse({
				...base,
				githubInstallationId: "98765",
			}).success,
		).toBe(true);
		expect(
			resourceReferenceSchema.safeParse({
				...base,
				githubFullName: "",
				githubInstallationId: "",
			}).success,
		).toBe(true);
		expect(
			resourceReferenceSchema.safeParse({
				...base,
				providerKey: "firecrawl:tenant",
				resourceType: "research_account",
			}).success,
		).toBe(true);
	});

	it("separates concrete Workspace references from MCP gateway credentials", () => {
		const client = new QueryClient();
		client.setQueryData(userConnectionsQueryOptions().queryKey, {
			data: [
				{
					appId: "github",
					providerName: "GitHub",
					tokenScope: "user",
					status: "connected",
					connectedAt: null,
					tokenExpiresAt: null,
					scopes: [],
				},
			],
		});
		client.setQueryData(workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey, {
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					organizationId: "org-1",
					workspaceId: WORKSPACE_ID,
					slot: "customer_repo",
					providerId: "github",
					connectionScope: "tenant",
					personalOwnerUserId: null,
					connectionInstanceId: null,
					requiredScopes: ["repo:read"],
					resourceType: "repository",
					providerResourceId: "tedix-hq/tedix",
					name: "Tedix repository",
					metadata: {},
					status: "active",
					availability: {
						status: "available",
						reason: null,
						checkedAt: "2026-08-20T12:00:00.000Z",
					},
					createdByKind: "user",
					createdById: "user-1",
					createdAt: "2026-08-20T12:00:00.000Z",
					updatedAt: "2026-08-20T12:00:00.000Z",
					removedAt: null,
				},
			],
			truncated: false,
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkspaceResourcesPanel workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Attached resources");
		expect(html).toContain("Choose calendar");
		expect(html).not.toContain("Calendar blocking");
		expect(html).toContain("Tedix repository");
		expect(html).toContain("GitHub · Repository · Shared account");
		expect(html).not.toContain("MCP gateway");
		expect(html).toContain("Technical details</summary>");
		expect(html).toContain("App connected");
		expect(html).toContain(
			"access to this resource is checked when it is used",
		);
		expect(html).toContain("Use your connection");
		expect(html).not.toContain("repo:read");
		expect(html).not.toContain("Start repository work");
	});

	it("shows calendar setup after a calendar has been attached", () => {
		const client = new QueryClient();
		client.setQueryData(workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey, {
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					workspaceId: WORKSPACE_ID,
					providerId: "google_calendar",
					connectionScope: "user",
					resourceType: "calendar",
					providerResourceId: "primary",
					name: "Agency meetings",
					metadata: {},
					status: "active",
					requiredScopes: [],
					availability: {
						status: "available",
						reason: null,
						checkedAt: "2026-10-06T00:00:00Z",
					},
					organizationId: "org-1",
					slot: null,
					personalOwnerUserId: "owner",
					connectionInstanceId: "33333333-3333-4333-8333-333333333333",
					createdByKind: "user",
					createdById: "owner",
					createdAt: "2026-10-06T00:00:00Z",
					updatedAt: "2026-10-06T00:00:00Z",
					removedAt: null,
				},
			],
			truncated: false,
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkspaceResourcesPanel workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Calendar blocking");
		expect(html).toContain("Choose the calendar skill");
		expect(html).toContain("Enable blocker changes");
	});

	it("offers governed work only for an immutable GitHub repository reference", () => {
		const client = new QueryClient();
		client.setQueryData(workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey, {
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					organizationId: "org-1",
					workspaceId: WORKSPACE_ID,
					slot: "customer_repo",
					providerId: "github",
					connectionScope: "tenant",
					personalOwnerUserId: null,
					connectionInstanceId: null,
					requiredScopes: ["contents:write"],
					resourceType: "repository",
					providerResourceId: "12345",
					name: "Tedix repository",
					metadata: {
						githubFullName: "tedix-hq/tedix",
						githubInstallationId: 98765,
					},
					status: "active",
					availability: {
						status: "available",
						reason: null,
						checkedAt: "2026-10-01T12:00:00.000Z",
					},
					createdByKind: "user",
					createdById: "user-1",
					createdAt: "2026-10-01T12:00:00.000Z",
					updatedAt: "2026-10-01T12:00:00.000Z",
					removedAt: null,
				},
			],
			truncated: false,
		});

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkspaceResourcesPanel workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		);

		expect(html).toContain("GitHub · Repository · Shared account");
		expect(html).toContain("Start repository work");
	});

	it("renders the server explanation for a blocked resource", () => {
		const client = new QueryClient();
		client.setQueryData(workspaceResourcesQueryOptions(WORKSPACE_ID).queryKey, {
			items: [
				{
					id: "22222222-2222-4222-8222-222222222222",
					organizationId: "org-1",
					workspaceId: WORKSPACE_ID,
					slot: null,
					providerId: "acme_official_tedix",
					connectionScope: "tenant",
					personalOwnerUserId: null,
					connectionInstanceId: null,
					requiredScopes: [],
					resourceType: "product_listing",
					providerResourceId: "product-1",
					name: "Approved product",
					metadata: {},
					status: "active",
					availability: {
						status: "missing_connection",
						reason: "No canonical provider connection matches this reference.",
						checkedAt: "2026-08-22T12:00:00.000Z",
					},
					createdByKind: "user",
					createdById: "user-1",
					createdAt: "2026-08-20T12:00:00.000Z",
					updatedAt: "2026-08-20T12:00:00.000Z",
					removedAt: null,
				},
			],
			truncated: false,
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkspaceResourcesPanel workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Connect app");
		expect(html).toContain(
			"No canonical provider connection matches this reference.",
		);

		/**
		 * The explanatory note and each resource row are bounded regions inside
		 * the workpiece panel, not peers of a `Card`, so both take the `Surface`
		 * well tier and keep the 8px control radius. Neither restates a
		 * `bg-kumo-*` at the call site — the adapter owns background, border,
		 * and radius.
		 */
		const surfaces = html.split('data-slot="surface"').length - 1;
		expect(surfaces).toBe(1);
		expect(html).toContain('data-tier="well"');
		expect(html).not.toContain('data-tier="panel"');
		expect(html).not.toContain("bg-kumo-tint px-3 py-2");
		const resourceRow = html.slice(html.indexOf("<ul"));
		expect(resourceRow).not.toContain("rounded-xl");
	});
});
