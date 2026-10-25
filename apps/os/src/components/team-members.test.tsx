import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ASSIGNABLE_ROLES } from "@tedix/auth/rbac";
import type { Member } from "@tedix/api-contract/schemas/organization";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const membersApi = vi.hoisted(() => ({
	inviteMember: vi.fn(),
	removeMember: vi.fn(),
	updateMemberRole: vi.fn(),
	setMemberPermissions: vi.fn(),
	setMemberIdentity: vi.fn(),
	listMembers: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		members: membersApi,
		userSettings: { getContext: vi.fn() },
	},
}));
vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ email: "me@example.com" }),
}));

import {
	MANAGEABLE_ROLES,
	MAX_INVITE_RECIPIENTS,
	InviteMemberDialog,
	inviteRecipientsSequentially,
	memberActivityLabel,
	MemberActivityCell,
	MemberAvatar,
	MemberIdentityCell,
	MemberStatusBadge,
	parseInviteRecipients,
	roleLabel,
	TeamMembersPanel,
} from "./team-members";
import { TeamRolesPanel } from "./team-roles";
import { Card, CardContent } from "@/components/kumo/card";
import { Collection } from "@/components/kumo/page";
import {
	MEMBERS_PAGE_SIZE,
	membersListQueryOptions,
	operationalContextQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { normalizeD1Timestamp } from "@/lib/time";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.resetAllMocks();
});

describe("members pure helpers", () => {
	it("normalizes, deduplicates, and separates pasted invitation recipients", () => {
		expect(
			parseInviteRecipients(
				" ADA@example.com, grace@example.com\ninvalid;ada@example.com ",
				["existing@example.com"],
			),
		).toEqual({
			recipients: [
				"existing@example.com",
				"ada@example.com",
				"grace@example.com",
			],
			invalid: ["invalid"],
			overflow: 0,
			unresolved: ["invalid"],
		});
	});

	it("bounds an invitation batch without silently accepting extra recipients", () => {
		const recipients = Array.from(
			{ length: MAX_INVITE_RECIPIENTS },
			(_, index) => `person-${index}@example.com`,
		);
		expect(
			parseInviteRecipients(
				"extra@example.com another@example.com",
				recipients,
			),
		).toEqual({
			recipients,
			invalid: [],
			overflow: 2,
			unresolved: ["extra@example.com", "another@example.com"],
		});
	});

	it("invites sequentially and retains an honest per-recipient failure", async () => {
		const calls: string[] = [];
		let active = 0;
		let peak = 0;
		const result = await inviteRecipientsSequentially(
			["first@example.com", "failed@example.com", "last@example.com"],
			async (email) => {
				calls.push(email);
				active += 1;
				peak = Math.max(peak, active);
				await Promise.resolve();
				active -= 1;
				if (email === "failed@example.com") throw new Error("connection lost");
				return { email } as Member;
			},
		);

		expect(calls).toEqual([
			"first@example.com",
			"failed@example.com",
			"last@example.com",
		]);
		expect(peak).toBe(1);
		expect(result.invited.map((member) => member.email)).toEqual([
			"first@example.com",
			"last@example.com",
		]);
		expect(result.errors).toEqual({
			"failed@example.com":
				"Unable to confirm this invitation. connection lost Check the refreshed member list before retrying.",
		});
	});

	it("keeps owner out of the assignable menu without restating the role list", () => {
		expect(MANAGEABLE_ROLES).not.toContain("owner");
		expect(MANAGEABLE_ROLES).toEqual(
			ASSIGNABLE_ROLES.filter((role) => role !== "owner"),
		);
		for (const role of ASSIGNABLE_ROLES) {
			expect(roleLabel(role)).toBeTruthy();
		}
	});

	it("draws a member with the Tedis tab avatar, named after the member", () => {
		const tediBacked = renderToStaticMarkup(
			<MemberAvatar
				member={{
					id: "member-cmo",
					name: "CMO",
					email: "cmo@fictional.example",
					avatarUrl: "https://images.fictional.example/cmo.png",
					tediId: "tedi-cmo",
				}}
			/>,
		);
		expect(tediBacked).toContain('data-entity-kind="tedi"');
		expect(tediBacked).toContain('aria-label="CMO"');
		expect(tediBacked).toContain(
			'src="https://images.fictional.example/cmo.png"',
		);
		expect(tediBacked).toContain('data-image-fit="cover"');
		const agent = renderToStaticMarkup(
			<MemberAvatar
				member={{
					id: "member-agent",
					name: "Juniper",
					email: "juniper@agent.example",
					kind: "external_agent",
					avatarUrl: "https://images.fictional.example/juniper.png",
					tediId: null,
				}}
			/>,
		);
		expect(agent).toContain('data-entity-kind="person"');
		expect(agent).toContain('aria-label="Juniper"');
		expect(agent).toContain(
			'src="https://images.fictional.example/juniper.png"',
		);
		// A brand mark is contained on a light tile, never stretched to cover.
		expect(agent).toContain('data-image-fit="contain"');
		expect(agent).toContain("object-contain");
		expect(agent).toContain("bg-white");
		// The tile keeps the standard avatar outline; photos stay outline-free.
		expect(agent).toMatch(/class="[^"]*\bring\b(?!-)/);
		expect(tediBacked).not.toMatch(/class="[^"]*\bring\b(?!-)/);
		expect(tediBacked).toContain("ring-0");
		const initials = renderToStaticMarkup(
			<MemberAvatar
				member={{
					id: "member-ada",
					name: "Ada Lovelace",
					email: "ada@fictional.example",
					avatarUrl: null,
					tediId: null,
				}}
			/>,
		);
		expect(initials).not.toContain("<img");
		expect(initials).toContain(">AL<");
		expect(
			renderToStaticMarkup(
				<MemberAvatar
					member={{
						id: "member-grace",
						name: "  ",
						email: "grace@fictional.example",
						avatarUrl: null,
						tediId: null,
					}}
				/>,
			),
		).toContain(">GF<");
	});

	it("normalizes D1 CURRENT_TIMESTAMP values to UTC before rendering", () => {
		expect(normalizeD1Timestamp("2026-03-08 14:29:34")).toBe(
			"2026-03-08 14:29:34Z",
		);
		expect(normalizeD1Timestamp("2026-03-08T14:29:34Z")).toBe(
			"2026-03-08T14:29:34Z",
		);
		expect(normalizeD1Timestamp("2026-03-08T14:29:34+02:00")).toBe(
			"2026-03-08T14:29:34+02:00",
		);
	});

	it("labels invited members by invitation and active members by activity", () => {
		expect(
			memberActivityLabel({
				status: "invited",
				invitedAt: new Date(Date.now() - 90_000).toISOString(),
				lastActiveAt: null,
			}),
		).toMatch(/^Invited /);
		expect(
			memberActivityLabel({
				status: "active",
				invitedAt: null,
				lastActiveAt: new Date(Date.now() - 90_000).toISOString(),
			}),
		).toMatch(/^Active /);
		expect(
			memberActivityLabel({
				status: "active",
				invitedAt: null,
				lastActiveAt: null,
			}),
		).toBe("No recent activity");
	});

	it("keeps compact activity narrow while exposing its full value", () => {
		const activeMember = member({
			email: "active-member@fictional.example",
			lastActiveAt: new Date(Date.now() - 90_000).toISOString(),
		});
		const activity = memberActivityLabel(activeMember);
		const host = document.createElement("div");
		host.innerHTML = renderToStaticMarkup(
			<MemberActivityCell member={activeMember} compact />,
		);

		const text = host.querySelector<HTMLElement>('[data-slot="text"]');
		expect(text?.textContent).toBe(activity);
		expect(text?.getAttribute("title")).toBe(activity);
		expect(text?.getAttribute("aria-label")).toBe(activity);
		expect(text?.className).toContain("min-w-0");
		expect(text?.className).toContain("truncate");
	});

	it("truncates a long identity instead of letting it push out the self badge", () => {
		const longIdentity = member({
			email: "a-member-with-a-very-long-identity@fictional.example",
			name: "A Member With A Very Long Identity",
		});
		for (const compact of [false, true]) {
			const host = document.createElement("div");
			host.innerHTML = renderToStaticMarkup(
				<MemberIdentityCell compact={compact} member={longIdentity} self />,
			);
			// The name sits beside the badge in a flex row: it must be allowed to
			// shrink (`min-w-0`) or its min-content width forces the badge out.
			const name = host.querySelector<HTMLElement>('[data-slot="text"]');
			expect(name?.className).toContain("min-w-0");
			expect(name?.className).toContain("truncate");
			const badge = host.querySelector<HTMLElement>('[data-slot="badge"]');
			expect(badge?.textContent).toBe("You");
			expect(badge?.className).toContain("shrink-0");
		}
	});

	it("renders an honest badge for every membership status, including null", () => {
		expect(
			renderToStaticMarkup(<MemberStatusBadge status="active" />),
		).toContain("Active");
		expect(
			renderToStaticMarkup(<MemberStatusBadge status="invited" />),
		).toContain("Invited");
		expect(
			renderToStaticMarkup(<MemberStatusBadge status="deactivated" />),
		).toContain("Deactivated");
		expect(renderToStaticMarkup(<MemberStatusBadge status={null} />)).toContain(
			"Unknown",
		);
	});
});

function invitedMember(email: string): Member {
	return {
		id: `member-${email}`,
		email,
		organizationId: "org-1",
		role: "member",
		status: "invited",
	} as Member;
}

async function mountInviteDialog() {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const onSettled = vi.fn();
	const onCancel = vi.fn();
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<InviteMemberDialog
					organizationId="org-1"
					onCancel={onCancel}
					onSettled={onSettled}
				/>
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
		client.clear();
	});
	const surface = document.body;
	const input = () =>
		surface.querySelector<HTMLInputElement>("#invite-recipients")!;
	const change = async (value: string) => {
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input(), value);
			input().dispatchEvent(new Event("input", { bubbles: true }));
		});
	};
	const keydown = async (key: string, isComposing = false) => {
		await act(async () => {
			input().dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key, isComposing }),
			);
		});
	};
	const button = (text: string) =>
		[...surface.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === text,
		)!;
	return { surface, input, change, keydown, button, onSettled, onCancel };
}

async function flushInviteMutation() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

describe("multi-recipient invitation dialog", () => {
	it("retains an unconfirmed recipient after a partial success", async () => {
		membersApi.inviteMember.mockImplementation(
			async ({ email }: { email: string }) => {
				if (email === "failed@example.com") throw new Error("connection lost");
				return { data: invitedMember(email) };
			},
		);
		const mounted = await mountInviteDialog();
		await mounted.change("first@example.com failed@example.com");
		await mounted.keydown("Enter");
		await act(async () => mounted.button("Create 2 invitations").click());
		await flushInviteMutation();

		expect(
			membersApi.inviteMember.mock.calls.map(([input]) => input.email),
		).toEqual(["first@example.com", "failed@example.com"]);
		expect(mounted.onSettled).toHaveBeenCalledWith([
			invitedMember("first@example.com"),
		]);
		expect(mounted.onCancel).not.toHaveBeenCalled();
		expect(mounted.surface.textContent).not.toContain("first@example.com");
		expect(mounted.surface.textContent).toContain("failed@example.com");
		expect(mounted.surface.textContent).toContain(
			"Unable to confirm this invitation",
		);
	});

	it("preserves invalid pasted text, respects selection, and ignores composing Enter", async () => {
		const mounted = await mountInviteDialog();
		await mounted.change("replace me");
		mounted.input().setSelectionRange(0, mounted.input().value.length);
		await act(async () => {
			const paste = new Event("paste", { bubbles: true, cancelable: true });
			Object.defineProperty(paste, "clipboardData", {
				value: { getData: () => "valid@example.com, not-an-email" },
			});
			mounted.input().dispatchEvent(paste);
		});

		expect(mounted.surface.textContent).toContain("valid@example.com");
		expect(mounted.input().value).toBe("not-an-email");
		await act(async () => mounted.button("Create invitation").click());
		expect(membersApi.inviteMember).not.toHaveBeenCalled();

		await mounted.change("second@example.com");
		await mounted.keydown("Enter", true);
		expect(mounted.input().value).toBe("second@example.com");
		expect(mounted.surface.textContent).not.toContain(
			"Remove second@example.com",
		);
	});
});

function member(overrides: Partial<Member> & { email: string }): Member {
	return {
		id: `member-${overrides.email}`,
		organizationId: "org-1",
		name: null,
		role: "member",
		status: "active",
		invitedAt: null,
		lastActiveAt: null,
		avatarUrl: null,
		customPermissions: null,
		...overrides,
	} as Member;
}

const TEAM = [
	member({ email: "owner@example.com", role: "owner" }),
	member({ email: "me@example.com", role: "admin" }),
	member({ email: "peer@example.com", role: "member" }),
];

async function mountPanel(options: {
	permissions?: string[];
	type?: "team" | "personal";
	members?: Member[];
	page?: number;
	contextPending?: boolean;
}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false },
			mutations: { retry: false },
		},
	});
	const invalidated: unknown[] = [];
	const invalidate = client.invalidateQueries.bind(client);
	client.invalidateQueries = (async (
		filters?: Parameters<typeof invalidate>[0],
	) => {
		invalidated.push(filters?.queryKey);
		return invalidate(filters);
	}) as typeof client.invalidateQueries;
	const page = options.page ?? 1;
	if (!options.contextPending)
		client.setQueryData(operationalContextQueryOptions().queryKey, {
			authority: { role: "admin", permissions: options.permissions ?? [] },
			organization: { id: "org-1", type: options.type ?? "team" },
		} as never);
	const members = options.members ?? TEAM;
	client.setQueryData(
		membersListQueryOptions({
			organizationId: "org-1",
			limit: MEMBERS_PAGE_SIZE,
			offset: (page - 1) * MEMBERS_PAGE_SIZE,
		}).queryKey,
		{
			data: members,
			pagination: {
				total: members.length + (page - 1) * MEMBERS_PAGE_SIZE,
				limit: MEMBERS_PAGE_SIZE,
				offset: (page - 1) * MEMBERS_PAGE_SIZE,
			},
		} as never,
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<TeamMembersPanel page={page} onPageChange={() => {}} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
		client.clear();
	});
	const button = (text: string) =>
		[...document.body.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === text,
		);
	return { host, invalidated, button };
}

const MANAGE = ["team:manage"];

describe("members surface", () => {
	it("labels browser agents separately from their role and saves identity through the contract", async () => {
		const juniper = member({
			email: "juniper@example.test",
			name: "Juniper",
			kind: "external_agent",
			representedUserId: "river",
			representedUserName: "River",
		});
		membersApi.setMemberIdentity.mockResolvedValue({ data: juniper });
		const mounted = await mountPanel({
			permissions: MANAGE,
			members: [juniper],
		});
		expect(mounted.host.textContent).toContain("Juniper · agent for River");
		const actions = mounted.host.querySelector<HTMLButtonElement>(
			'[aria-label="Actions for juniper@example.test"]',
		)!;
		await act(async () => {
			actions.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			actions.click();
		});
		const edit = [
			...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((item) => item.textContent?.trim() === "Edit identity")!;
		await act(async () => edit.click());
		expect(document.body.textContent).toContain(
			"Representation does not grant access",
		);
		await act(async () => mounted.button("Save identity")!.click());
		await flushInviteMutation();
		expect(membersApi.setMemberIdentity).toHaveBeenCalledWith({
			organizationId: "org-1",
			memberId: juniper.id,
			identity: {
				kind: "external_agent",
				displayName: "Juniper",
				representedUserId: "river",
				avatarUrl: null,
			},
		});
		expect(mounted.invalidated).toContainEqual(osQueryKeys.members());
		expect(membersApi.updateMemberRole).not.toHaveBeenCalled();
	});

	it("shows each member's resolved avatar in every row and initials otherwise", async () => {
		const { host } = await mountPanel({
			members: [
				member({
					email: "cmo@fictional.example",
					name: "CMO",
					avatarUrl: "https://images.fictional.example/cmo.png",
					tediId: "tedi-cmo",
				}),
				member({
					email: "juniper@agent.example",
					name: "Juniper",
					kind: "external_agent",
					representedUserId: "river",
					representedUserName: "River",
					avatarUrl: "https://images.fictional.example/juniper.png",
				}),
				member({ email: "ada@fictional.example", name: "Ada Lovelace" }),
			],
		});
		const avatars = (label: string) => [
			...host.querySelectorAll<HTMLElement>(
				`[role="img"][aria-label="${label}"]`,
			),
		];
		expect(avatars("CMO").length).toBeGreaterThan(0);
		for (const avatar of avatars("CMO")) {
			expect(avatar.dataset.entityKind).toBe("tedi");
			expect(avatar.querySelector("img")?.getAttribute("src")).toBe(
				"https://images.fictional.example/cmo.png",
			);
		}
		for (const avatar of avatars("Juniper")) {
			expect(avatar.dataset.entityKind).toBe("person");
			expect(avatar.querySelector("img")?.getAttribute("src")).toBe(
				"https://images.fictional.example/juniper.png",
			);
			expect(avatar.querySelector("img")?.dataset.imageFit).toBe("contain");
		}
		expect(avatars("Ada Lovelace").length).toBeGreaterThan(0);
		for (const avatar of avatars("Ada Lovelace")) {
			expect(avatar.querySelector("img")).toBeNull();
			expect(avatar.textContent).toBe("AL");
		}
	});

	it("renders the Tedix member contract, not a provider admin widget", async () => {
		const { host } = await mountPanel({});
		for (const entry of TEAM) expect(host.textContent).toContain(entry.email);
		expect(host.textContent).toContain(`Members (${TEAM.length})`);
		expect(host.querySelector("descope-user-management-widget")).toBeNull();
	});

	it("gates every manage affordance on team:manage authority", async () => {
		const reader = await mountPanel({ permissions: ["team:read"] });
		expect(reader.button("Invite member")).toBeUndefined();
		expect(reader.host.querySelector('[aria-label^="Role for "]')).toBeNull();
		cleanups.splice(0).forEach((cleanup) => cleanup());

		const manager = await mountPanel({ permissions: MANAGE });
		expect(manager.button("Invite member")).toBeDefined();
		// Role select and removal require manage authority plus a non-owner,
		// non-self target.
		const roleControls = [
			...manager.host.querySelectorAll('[aria-label^="Role for "]'),
		].map((control) => control.getAttribute("aria-label"));
		expect([...new Set(roleControls)]).toEqual(["Role for peer@example.com"]);
	});

	it("changes a member's role through the members contract", async () => {
		membersApi.updateMemberRole.mockResolvedValue({
			data: member({ email: "peer@example.com", role: "admin" }),
		});
		const { host, invalidated } = await mountPanel({ permissions: MANAGE });
		const trigger = host.querySelector<HTMLElement>(
			'[aria-label="Role for peer@example.com"]',
		)!;
		await act(async () => {
			trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			trigger.click();
		});
		const admin = [
			...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((option) => option.textContent?.trim() === roleLabel("admin"))!;
		await act(async () => {
			admin.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(membersApi.updateMemberRole).toHaveBeenCalledWith({
			organizationId: "org-1",
			memberId: "member-peer@example.com",
			role: "admin",
		});
		expect(invalidated).toContainEqual(osQueryKeys.members());
	});

	it("disables invitations for personal workspaces and says why", async () => {
		const { button } = await mountPanel({
			permissions: MANAGE,
			type: "personal",
		});
		const invite = button("Invite member");
		expect(invite?.disabled).toBe(true);
		expect(invite?.getAttribute("aria-label")).toContain(
			"Personal workspaces do not support",
		);
	});

	it("offers the access view for every member, owner and self included", async () => {
		const { host } = await mountPanel({ permissions: [] });
		const triggers = [
			...host.querySelectorAll<HTMLElement>('[aria-label^="Actions for "]'),
		];
		const owner = triggers.find(
			(trigger) =>
				trigger.getAttribute("aria-label") === "Actions for owner@example.com",
		)!;
		await act(async () => {
			owner.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			owner.click();
		});
		expect(document.body.textContent).toContain("View access");
		expect(document.body.textContent).not.toContain("Remove member");
	});

	it("confirms a destructive member action before removing", async () => {
		let finish!: () => void;
		membersApi.removeMember.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = () => resolve({ ok: true });
				}),
		);
		const { host, invalidated } = await mountPanel({ permissions: MANAGE });
		const trigger = [
			...host.querySelectorAll<HTMLElement>(
				'[aria-label="Actions for peer@example.com"]',
			),
		][0]!;
		await act(async () => {
			trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			trigger.click();
		});
		const remove = [
			...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((item) => item.textContent?.includes("Remove"))!;
		await act(async () => remove.click());
		expect(document.body.textContent).toContain("Remove team member?");
		expect(membersApi.removeMember).not.toHaveBeenCalled();
		const confirm = [...document.body.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Remove member",
		)!;
		await act(async () => {
			confirm.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(membersApi.removeMember).toHaveBeenCalledWith({
			organizationId: "org-1",
			memberId: "member-peer@example.com",
		});
		// Base UI's Dialog.Close would close on the click itself; the dialog
		// must stay open, in its pending state, until the removal settles.
		expect(document.body.textContent).toContain("Remove team member?");
		expect(document.body.textContent).toContain("Removing…");
		await act(async () => {
			finish();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.body.textContent).not.toContain("Remove team member?");
		expect(invalidated).toContainEqual(osQueryKeys.members());
		expect(host.textContent).toContain(
			"peer@example.com was removed from the team",
		);
	});

	it("keeps the remove dialog open with the error when the removal fails", async () => {
		membersApi.removeMember.mockRejectedValue(new Error("Owner is protected"));
		const { host } = await mountPanel({ permissions: MANAGE });
		const trigger = host.querySelector<HTMLElement>(
			'[aria-label="Actions for peer@example.com"]',
		)!;
		await act(async () => {
			trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			trigger.click();
		});
		const remove = [
			...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((item) => item.textContent?.includes("Remove"))!;
		await act(async () => remove.click());
		const confirm = [...document.body.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Remove member",
		)!;
		await act(async () => {
			confirm.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.body.textContent).toContain("Remove team member?");
		expect(document.body.textContent).toContain("Owner is protected");
		expect(confirm.disabled).toBe(false);
		expect(host.textContent).not.toContain("was removed from the team");
	});

	it("uses Kumo-owned labels and help for the invitation fields", async () => {
		const { surface } = await mountInviteDialog();
		expect(
			surface.querySelector('label[for="invite-recipients"]'),
		).not.toBeNull();
		expect(surface.querySelector("#invite-role")).not.toBeNull();
		expect(surface.textContent).toContain(
			"Admins can manage workspace settings.",
		);
		expect(surface.querySelector("#member-email, #member-role")).toBeNull();
	});

	it("paginates with contract offsets from the route's page", async () => {
		// Only the page-2 offset has data; rendering it proves the panel read it.
		const { host } = await mountPanel({
			page: 2,
			members: [member({ email: "later@example.com" })],
		});
		expect(host.textContent).toContain("later@example.com");
		expect(host.querySelector('[data-slot="pagination"], nav')).not.toBeNull();
	});

	// Geometry comes from the shared Kumo adapters: each surface renders the
	// adapter's own classes, not a hand-written inset or border.
	const kumoClass = (element: React.ReactElement) =>
		new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html")
			.body.firstElementChild?.className;

	it("keeps the members header and content on the shared Kumo Card inset", async () => {
		const { host } = await mountPanel({});
		const content = host.querySelector('[data-slot="card-content"]');
		expect(content?.className).toBe(kumoClass(<CardContent />));
	});

	it("uses inline Kumo collections for mobile members", async () => {
		const { host } = await mountPanel({});
		const collection = host.querySelector(
			'[aria-label="Organization members"]',
		);
		expect(collection?.className).toBe(
			kumoClass(
				<Collection
					appearance="inline"
					aria-label="Organization members"
					className="md:hidden"
				>
					<li />
				</Collection>,
			),
		);
	});

	it("keeps the pending collection on shared Kumo Card geometry", async () => {
		const { host } = await mountPanel({ contextPending: true });
		const card = host.querySelector('[aria-label="Loading members"]');
		expect(card?.getAttribute("aria-busy")).toBe("true");
		expect(card?.className).toBe(kumoClass(<Card />));
		expect(card?.querySelector('[data-slot="card-content"]')?.className).toBe(
			kumoClass(<CardContent className="space-y-3" />),
		);
	});
});

describe("roles panel", () => {
	const html = () =>
		new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={new QueryClient()}>
					<TeamRolesPanel />
				</QueryClientProvider>,
			),
			"text/html",
		);

	it("renders the canonical role and scope references, not provider widgets", () => {
		const doc = html();
		expect(
			doc.querySelector('[aria-label="Organization role permissions"]'),
		).not.toBeNull();
		expect(
			doc.querySelector('[aria-label="MCP capability scopes"]'),
		).not.toBeNull();
		for (const role of ASSIGNABLE_ROLES)
			expect(doc.body.textContent).toContain(roleLabel(role));
	});

	it("keeps each dense reference in one labelled scroll region", () => {
		const doc = html();
		const regions = [...doc.querySelectorAll('[role="region"]')];
		expect(regions).toHaveLength(2);
		for (const region of regions) {
			expect(region.getAttribute("tabindex")).toBe("0");
			expect(region.querySelectorAll("table")).toHaveLength(1);
			expect(region.closest(".hidden")).toBeNull();
		}
	});
});
