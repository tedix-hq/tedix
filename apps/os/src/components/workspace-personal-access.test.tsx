import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspaceResource } from "@tedix/api-contract/schemas/os-workspaces";
import type { PersonalResourceDelegationSchema } from "@tedix/api-contract/schemas/personal-resource-delegations";
import type { z } from "zod";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { WorkspacePersonalAccess } from "./workspace-personal-access";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const resource: OsWorkspaceResource = {
	id: "22222222-2222-4222-8222-222222222222",
	organizationId: "fictional-org",
	workspaceId: WORKSPACE_ID,
	slot: "mail",
	providerId: "sample-mail",
	connectionScope: "user",
	personalOwnerUserId: "fictional-owner",
	connectionInstanceId: "33333333-3333-4333-8333-333333333333",
	providerAccess: null,
	requiredScopes: [],
	resourceType: "mailbox",
	providerResourceId: "sample-mailbox",
	name: "Sample mailbox",
	metadata: {},
	status: "active",
	createdByKind: "user",
	createdById: "fictional-owner",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	removedAt: null,
};
const grant: z.infer<typeof PersonalResourceDelegationSchema> = {
	id: "66666666-6666-4666-8666-666666666666",
	organizationId: resource.organizationId,
	tediId: "77777777-7777-4777-8777-777777777777",
	skillId: "88888888-8888-4888-8888-888888888888",
	skillRevision: 1,
	connectionInstanceId: resource.connectionInstanceId!,
	ownerUserId: "fictional-owner",
	providerId: resource.providerId,
	resourceType: resource.resourceType,
	providerResourceId: resource.providerResourceId,
	requiredScopes: [],
	toolIds: ["read_mail"],
	createdAt: resource.createdAt,
	workspaceId: WORKSPACE_ID,
	resourceId: resource.id,
	operations: ["read"],
	revokedAt: null,
	expiresAt: "2099-01-01T00:00:00.000Z",
};
function render(grants: (typeof grant)[]) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(
		osQuery.personalResourceDelegations.list.queryOptions({
			input: { limit: 100 },
		}).queryKey,
		grants,
	);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<WorkspacePersonalAccess workspaceId={WORKSPACE_ID} resource={resource} />
		</QueryClientProvider>,
	);
	client.clear();
	const container = document.createElement("div");
	container.innerHTML = html;
	return container.querySelector("button")?.textContent;
}

describe("WorkspacePersonalAccess", () => {
	it("shows no access without a grant", () => {
		expect(render([])).toBe("No access");
	});
	it("shows read access for an active grant on this resource", () => {
		expect(render([grant])).toBe("Read");
	});
	it.each([
		{ revokedAt: "2026-01-01T00:00:00.000Z" },
		{ expiresAt: "2000-01-01T00:00:00.000Z" },
		{ workspaceId: "44444444-4444-4444-8444-444444444444" },
		{ resourceId: "55555555-5555-4555-8555-555555555555" },
	])("ignores an inactive or unrelated grant: %j", (override) => {
		expect(render([{ ...grant, ...override }])).toBe("No access");
	});
	it("shows the strongest active grant and explains its limits", () => {
		expect(render([grant, { ...grant, operations: ["read", "modify"] }])).toBe(
			"Read + organise (archive, label, unsubscribe; never sends or deletes)",
		);
	});
});
