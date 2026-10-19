import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { WorkActorDirectory } from "./work-actor-directory";
import { WorkActorAvatar } from "./work-actor-avatar";
import {
	membersListQueryOptions,
	operationalContextQueryOptions,
	tediRosterQueryOptions,
	userProfileQueryOptions,
	workExternalPrincipalsQueryOptions,
} from "@/lib/os-query-options";

it.each([
	{ metadata: {}, label: "Codex for Maple Owner" },
	{
		metadata: {
			personalAgent: {
				version: 1,
				representedUserId: "owner",
				imageUrl: "https://assets.example.test/juniper.png",
			},
		},
		label: "Renamed device for Maple Owner",
	},
	{
		metadata: { personalAgent: { version: 1, representedUserId: "absent" } },
		label: "Renamed device for User absent",
	},
])(
	"resolves governed identity and represented owner instead of the viewer ($label)",
	async ({ metadata, label }) => {
		const org = "11111111-1111-4111-8111-111111111111";
		const client = new QueryClient({
			defaultOptions: { queries: { staleTime: Infinity, retry: false } },
		});
		const seed = (key: readonly unknown[], data: unknown) =>
			client.setQueryData(key, data);
		seed(operationalContextQueryOptions().queryKey, {
			organization: { id: org },
		});
		seed(userProfileQueryOptions().queryKey, {
			id: "viewer",
			name: "Pine Viewer",
			email: "viewer@pine.example",
			avatarUrl: null,
		});
		seed(tediRosterQueryOptions(100).queryKey, { data: [] });
		seed(
			membersListQueryOptions({ organizationId: org, limit: 100, offset: 0 })
				.queryKey,
			{
				data: [
					{
						descopeUserId: "owner-provider-subject",
						userId: "owner",
						name: "Maple Owner",
						avatarUrl: null,
					},
				],
			},
		);
		seed(workExternalPrincipalsQueryOptions(org).queryKey, [
			{
				id: "laptop",
				displayName: "Renamed device",
				credentialBindingType: "api_key",
				createdByType: "user",
				createdById: "owner",
				metadata,
			},
		]);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<WorkActorDirectory>
							<WorkActorAvatar
								actor={{
									type: "external_agent",
									id: "laptop",
									harness: "codex",
								}}
							/>
						</WorkActorDirectory>
					</QueryClientProvider>,
				),
			);
			expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
				label,
			);
			expect(host.querySelector(".work-actor-badge")?.textContent).toBe(
				label.endsWith("User absent") ? "UA" : "MO",
			);
			expect(host.textContent).not.toContain("Pine Viewer");
		} finally {
			await act(async () => root.unmount());
			host.remove();
			client.clear();
		}
	},
);
