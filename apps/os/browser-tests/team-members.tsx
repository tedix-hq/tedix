import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import type { Member } from "@tedix/api-contract/schemas/organization";
import { TeamMembersPanel } from "../src/components/team-members";
import {
	MEMBERS_PAGE_SIZE,
	membersListQueryOptions,
	operationalContextQueryOptions,
	userProfileQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, staleTime: Infinity, retry: false },
	},
});

const ORG_ID = "11111111-1111-4111-8111-000000000001";
const id = (n: number) =>
	`11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const now = new Date().toISOString();

const member = (n: number, overrides: Partial<Member>): Member =>
	({
		id: id(n),
		organizationId: ORG_ID,
		descopeUserId: `descope-${n}`,
		userId: `user-${n}`,
		name: null,
		avatarUrl: null,
		role: "member",
		kind: "human",
		representedUserId: null,
		representedUserName: null,
		tediId: null,
		customPermissions: null,
		status: "active",
		invitedAt: null,
		invitedBy: null,
		inviteAcceptedAt: null,
		lastActiveAt: null,
		createdAt: now,
		updatedAt: now,
		email: `member-${n}@fictional.example`,
		...overrides,
	}) as Member;

// Worst-case identities: unbroken emails with no wrap points, a long
// multi-part name, an external agent whose label adds "agent for …", and a
// pending invitation. Every non-self, non-owner row also renders the role
// select, the widest control a manage-authority viewer sees.
const members: Member[] = [
	member(1, {
		email: "owner@localhost.invalid",
		name: "Alejandra Maximiliana von und zu Lichtenberg-Hohenfels",
		role: "admin",
		lastActiveAt: now,
	}),
	member(2, {
		email:
			"alexandrina.konstantinopolous.vandermeer.mercedes@a-remarkably-long-fictional-domain-name.example.com",
		role: "member",
		lastActiveAt: now,
	}),
	member(3, {
		email:
			"christopher.alexander.winterbottom.the.third@an-equally-long-fictional-domain.example.com",
		name: "Christopher Alexander Winterbottom the Third",
		role: "admin",
		lastActiveAt: now,
	}),
	member(4, {
		email: "meridian.research.companion@agents.fictional.example",
		name: "Meridian Research Companion",
		kind: "external_agent",
		representedUserId: "user-1",
		representedUserName:
			"Alejandra Maximiliana von und zu Lichtenberg-Hohenfels",
		role: "member",
	}),
	member(5, {
		email:
			"pending.invitation.with.an.unreasonably.long.address@yet-another-fictional-domain.example.com",
		role: "member",
		status: "invited",
		invitedAt: now,
		invitedBy: "user-1",
	}),
	member(6, {
		email: "owner@fictional.example",
		name: "Workplace Owner",
		role: "owner",
		lastActiveAt: now,
	}),
];

client.setQueryData(operationalContextQueryOptions().queryKey, {
	authority: { role: "admin", permissions: ["team:read", "team:manage"] },
	organization: { id: ORG_ID, type: "team" },
});
client.setQueryData(
	membersListQueryOptions({
		organizationId: ORG_ID,
		limit: MEMBERS_PAGE_SIZE,
		offset: 0,
	}).queryKey,
	{
		data: members,
		pagination: {
			total: members.length,
			limit: MEMBERS_PAGE_SIZE,
			offset: 0,
		},
	},
);
// The local lane's identity is owner@localhost.invalid; seeding the profile to
// the same address keeps the "You" badge deterministic on either hook path.
client.setQueryData(userProfileQueryOptions().queryKey, {
	id: "user-1",
	name: "Alejandra Maximiliana von und zu Lichtenberg-Hohenfels",
	email: "owner@localhost.invalid",
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<div className="mx-auto max-w-5xl p-3 md:p-8">
			<p className="mb-4 text-sm text-kumo-subtle">
				Fictional members · long identities · isolated verification
			</p>
			<TeamMembersPanel page={1} onPageChange={() => {}} />
		</div>
	</QueryClientProvider>,
);
