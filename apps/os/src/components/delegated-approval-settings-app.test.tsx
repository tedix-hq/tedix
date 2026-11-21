import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { DelegatedApprovalSettingsApp } from "./delegated-approval-settings-app";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ role: "owner" }));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { organization: { id: "org" }, authority: { role: state.role } },
	}),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		organizations: { get: vi.fn(), update: vi.fn() },
		externalAgentIdentity: { listPrincipals: vi.fn() },
		members: { listMembers: vi.fn() },
	},
}));

it("restricts controls to owners and saves opt-in, lead changes and opt-out without losing other leads", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	let policy = {
		enabled: false,
		leadAgents: { other: "00000000-0000-4000-8000-000000000001" } as Record<
			string,
			string
		>,
	};
	vi.mocked(osApi.organizations.get).mockImplementation(
		async () =>
			({ id: "org", metadata: { delegatedApprovals: policy } }) as Awaited<
				ReturnType<typeof osApi.organizations.get>
			>,
	);
	vi.mocked(osApi.organizations.update).mockImplementation(async (input) => {
		const next = input.metadata!.delegatedApprovals!;
		policy = { enabled: next.enabled, leadAgents: next.leadAgents ?? {} };
		return { id: "org", metadata: { delegatedApprovals: policy } } as Awaited<
			ReturnType<typeof osApi.organizations.update>
		>;
	});
	const agentDefaults = {
		organizationId: "org",
		key: "agent",
		createdByType: "user" as const,
		createdById: "person",
		metadata: {},
		createdAt: "2026-11-21T00:00:00Z",
		updatedAt: "2026-11-21T00:00:00Z",
		platform: null,
		representedUserId: null,
		allowedScopes: null,
		expiresAt: null,
		lastSeenAt: null,
	};
	client.setQueryData(
		osQuery.externalAgentIdentity.listPrincipals.queryOptions({
			input: { organizationId: "org", limit: 500 },
		}).queryKey,
		[
			{
				...agentDefaults,
				id: "00000000-0000-4000-8000-000000000002",
				displayName: "Independent lead",
				status: "active",
				credentialBindingType: "api_key",
				credentialBindingId: "key",
			},
			{
				...agentDefaults,
				id: "same-login",
				displayName: "Same login",
				status: "active",
				credentialBindingType: "owner_user",
				credentialBindingId: "person",
			},
		],
	);
	client.setQueryData(
		osQuery.members.listMembers.queryOptions({
			input: { organizationId: "org", status: "active", limit: 100, offset: 0 },
		}).queryKey,
		{
			data: [
				{
					id: "member",
					organizationId: "org",
					descopeUserId: "person-sub",
					avatarUrl: null,
					role: "owner",
					customPermissions: null,
					status: "active",
					invitedAt: null,
					invitedBy: null,
					inviteAcceptedAt: null,
					lastActiveAt: null,
					createdAt: null,
					updatedAt: null,
					userId: "person",
					kind: "human",
					name: "Person",
					email: "person@acme.test",
				},
			],
			pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
		},
	);
	const render = () =>
		root.render(
			<QueryClientProvider client={client}>
				<DelegatedApprovalSettingsApp organizationId="org" />
			</QueryClientProvider>,
		);
	const flush = async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	};
	try {
		state.role = "admin";
		await act(async () => render());
		expect(host.textContent).toContain("Only the organization owner");
		expect(host.querySelector("button")).toBeNull();
		state.role = "owner";
		await act(async () => render());
		await flush();
		const toggle = host.querySelector<HTMLElement>('[role="switch"]')!;
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		await act(async () => toggle.click());
		const select = host.querySelector("select")!;
		expect(select.textContent).toContain("Independent lead");
		expect(select.textContent).not.toContain("Same login");
		await act(async () => {
			select.value = "00000000-0000-4000-8000-000000000002";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		const save = () =>
			Array.from(host.querySelectorAll("button")).find(
				(button) => button.textContent === "Save approval settings",
			)!;
		await act(async () => save().click());
		await flush();
		expect(policy).toEqual({
			enabled: true,
			leadAgents: {
				other: "00000000-0000-4000-8000-000000000001",
				person: "00000000-0000-4000-8000-000000000002",
			},
		});
		expect(host.textContent).toContain("Approval settings saved.");
		await act(async () => toggle.click());
		await act(async () => save().click());
		await flush();
		expect(policy).toEqual({
			enabled: false,
			leadAgents: {
				other: "00000000-0000-4000-8000-000000000001",
				person: "00000000-0000-4000-8000-000000000002",
			},
		});
		expect(toggle.getAttribute("aria-checked")).toBe("false");
	} finally {
		state.role = "owner";
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});
