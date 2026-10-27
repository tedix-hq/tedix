import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import {
	AccountList,
	accountStatus,
	appNames,
	friendlyProviderName,
	groupAccounts,
	humanizeAppSlug,
	type AccountListProps,
} from "./account-list";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const provider: ConnectionProvider = {
	appId: "ms-calendar",
	name: "Microsoft Graph Calendar OAuth",
	description: "client_credentials M2M",
	enabled: true,
	availableScopes: [],
	logoUrl: null,
	connectionType: "oauth",
	registrationMode: "pre_registered",
	accountMode: "multiple",
	availableAccountModes: ["single", "multiple"],
	tokenScope: "user",
	supportedScopes: ["user"],
	recommendedScope: "user",
	referencedByOrg: true,
};
const base: ConnectionInventoryRow = {
	provider,
	scope: "user",
	accountState: "present",
	accountLabel: "user@example.com",
	capabilities: [],
	connection: {
		appId: provider.appId,
		providerName: provider.name,
		status: "connected",
		connectedAt: null,
		tokenExpiresAt: null,
		scopes: ["Calendars.Read"],
		tokenScope: "user",
		connectedByEmail: "user@example.com",
	},
	references: [
		{
			appId: "calendar-app",
			appSlug: "microsoft-graph-calendar-f9ab445d",
			source: "app",
		},
	],
	referencesComplete: true,
	access: "not_evaluated",
	health: "not_checked",
};
const named: ConnectionInventoryRow = {
	...base,
	connectionInstanceId: "00000000-0000-4000-8000-000000000002",
	instanceLabel: "Work account",
};

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
});

async function render(
	rows: ConnectionInventoryRow[],
	overrides: Partial<AccountListProps> = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const props: AccountListProps = {
		owner: "personal",
		groups: groupAccounts(rows),
		checkedAt: "2026-10-24T15:00:00Z",
		isChecking: false,
		onCheck: vi.fn(),
		canManage: () => true,
		deniedReason: () => "Ask an organization admin.",
		canAdd: () => true,
		canBind: true,
		isConnecting: false,
		isDisconnecting: false,
		isBinding: false,
		onConnect: vi.fn(),
		onReconnect: vi.fn(),
		onDisconnect: vi.fn(),
		onRename: vi.fn(),
		onAdd: vi.fn(),
		onBind: vi.fn(),
		serviceHealth: {},
		onCheckService: vi.fn(),
		...overrides,
	};
	await act(async () => root?.render(<AccountList {...props} />));
	return props;
}

function button(label: string, parent: ParentNode = host) {
	return [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === label,
	);
}

async function expand(name = "Outlook Calendar") {
	const trigger = host.querySelector<HTMLButtonElement>(
		`button[aria-label="${name} details"]`,
	)!;
	await act(async () => trigger.click());
}

async function details() {
	await act(async () => button("Details")!.click());
}

describe("account list model", () => {
	it("uses friendly names without combining mail and calendar", () => {
		expect(friendlyProviderName(provider)).toBe("Outlook Calendar");
		expect(
			friendlyProviderName({ ...provider, name: "Microsoft Graph Mail OAuth" }),
		).toBe("Outlook Mail");
		expect(friendlyProviderName({ ...provider, name: "Google Calendar" })).toBe(
			"Google Calendar",
		);
	});

	it("names apps for people, never by internal slug", () => {
		expect(humanizeAppSlug("pricewise-official-f9ab445d")).toBe(
			"Pricewise official",
		);
		expect(humanizeAppSlug("alegra-tedix")).toBe("Alegra");
		expect(
			appNames([
				{ appId: "a", appSlug: "pricewise-official-f9ab445d", source: "app" },
				{ appId: "a", appSlug: "pricewise-official-f9ab445d", source: "tool" },
				{ appId: "b", appSlug: "x-1", appName: "Pricing desk", source: "app" },
			]),
		).toEqual(["Pricewise official", "Pricing desk"]);
	});

	it("gives every account exactly one status and never reads a failed check as absence", () => {
		expect(accountStatus(base).label).toBe("Connected");
		expect(accountStatus({ ...base, accountState: "unknown" })).toEqual({
			kind: "unchecked",
			label: "Status not checked",
			reason: "Couldn't check this account",
		});
		expect(
			accountStatus({ ...base, accountState: "restricted", connection: null }),
		).toEqual({
			kind: "unchecked",
			label: "Status not checked",
			reason: "Provider didn't allow a status check",
		});
		expect(
			accountStatus({
				...base,
				connection: { ...base.connection!, status: "revoked" },
			}),
		).toMatchObject({ kind: "attention", action: "reconnect" });
		expect(
			accountStatus({
				...base,
				provider: { ...provider, connectionType: "api_key" },
				accountState: "expired",
			}).label,
		).toBe("Needs attention: Key stopped working");
		expect(
			accountStatus({
				...base,
				capabilities: [
					{
						id: "write",
						label: "Write calendar",
						requiredScopes: ["Calendars.Write"],
						state: "not_configured",
						setupUrl: "/account/connections?connect=ms-calendar",
						verified: true,
					},
				],
			}).label,
		).toBe("Needs attention: Missing permission for Write calendar");
		expect(
			accountStatus({ ...named, accountState: "missing", connection: null }),
		).toMatchObject({ kind: "attention", action: "connect" });
		expect(
			accountStatus({ ...base, accountState: "missing", connection: null }),
		).toMatchObject({ kind: "available", action: "connect" });
	});

	it("sorts needs-attention before connected and keeps never-used defaults out of used groups", () => {
		const mail: ConnectionInventoryRow = {
			...base,
			provider: { ...provider, appId: "ms-mail", name: "Microsoft Graph Mail" },
			accountState: "expired",
		};
		const unused: ConnectionInventoryRow = {
			...base,
			provider: { ...provider, appId: "alpic", name: "Alpic" },
			accountState: "missing",
			connection: null,
		};
		const groups = groupAccounts([
			unused,
			{ ...base, accountState: "missing", connection: null },
			named,
			mail,
		]);
		expect(groups.map((group) => group.provider.appId)).toEqual([
			"ms-mail",
			"ms-calendar",
			"alpic",
		]);
		expect(groups[1]!.accounts).toEqual([named]);
		expect(groups[2]!.status.kind).toBe("available");
	});
});

it("places Who can use this only in organization account details", async () => {
	await render([{ ...named, scope: "tenant" }], {
		owner: "organization",
		renderConsumerGrants: (row) => (
			<span data-grants-for={row.connectionInstanceId}>Grant controls</span>
		),
	});
	await expand();
	await details();
	expect(host.textContent).toContain("Who can use this");
	expect(
		host.querySelector(`[data-grants-for="${named.connectionInstanceId}"]`),
	).not.toBeNull();

	await act(async () => root?.unmount());
	root = undefined;
	await render([named], {
		owner: "personal",
		renderConsumerGrants: () => <span>Grant controls</span>,
	});
	await expand();
	await details();
	expect(host.textContent).not.toContain("Who can use this");
	expect(host.textContent).not.toContain("Grant controls");
});

describe("account list rows", () => {
	it("shows one status closed, the accounts open, and everything else behind Details", async () => {
		const access = {
			...base,
			toolCapabilities: [
				{ id: "read", label: "Read events", riskTier: "read" as const },
				{
					id: "write",
					label: "Create events",
					riskTier: "bounded_write" as const,
				},
				{
					id: "invite",
					label: "Send invitations",
					riskTier: "external_side_effect" as const,
				},
			],
			toolCapabilitiesComplete: true,
			capabilities: [
				{
					id: "access",
					label: "Access",
					requiredScopes: [],
					state: "connected" as const,
					setupUrl: "/account/connections?connect=ms-calendar",
					verified: true,
				},
			],
		};
		await render([access]);
		const row = host.querySelector('[data-account-group="ms-calendar"]')!;
		expect(row.textContent).toBe("Outlook CalendarConnected");
		await expand();
		expect(host.textContent).toContain("Only you can use it.");
		expect(button("Reconnect")).toBeDefined();
		expect(button("Disconnect")).toBeDefined();
		expect(button("Add account")).toBeDefined();
		for (const hidden of [
			"What Tedix can do with it",
			"Used by",
			"Last checked",
			"Tedix keeps your",
			"Access",
			"client_credentials",
			"user@example.com",
			"microsoft-graph-calendar-f9ab445d",
		])
			expect(host.textContent).not.toContain(hidden);
		await details();
		expect(host.textContent).toContain("What Tedix can do with it");
		expect(host.textContent).toContain("Read: Read events. Automatic.");
		expect(host.textContent).toContain(
			"Create and edit: Create events. Automatic, logged.",
		);
		expect(host.textContent).toContain(
			"Protected effects: Send invitations. Asks a person first.",
		);
		expect(host.textContent).not.toContain("Tedix keeps your");
		expect(host.textContent).toContain("Used byMicrosoft graph calendar");
		expect(host.textContent).toContain(
			"You can sign in with more than one account",
		);
		expect(host.textContent).toContain("client_credentials M2M");
		expect(host.textContent).toContain("microsoft-graph-calendar-f9ab445d");
		expect(host.textContent).toContain("MCP service not checked");
	});

	it("separates and wraps long app references and service health", async () => {
		const longSlug = `calendar-${"x".repeat(96)}`;
		await render(
			[
				{
					...base,
					references: [
						{ appId: "long-app", appSlug: longSlug, source: "app" },
						{ appId: "short-app", appSlug: "calendar", source: "app" },
					],
				},
			],
			{
				serviceHealth: {
					[provider.appId]: {
						status: "healthy",
						appSlug: longSlug,
						toolCount: 12,
						detail: `${longSlug}'s MCP protocol service passed every check.`,
					},
				},
			},
		);
		await expand();
		await details();

		const references = host.querySelector<HTMLElement>(
			"[data-connection-app-identifiers]",
		)!;
		const health = host.querySelector<HTMLElement>(
			"[data-connection-service-health]",
		)!;
		expect(references.textContent).toContain(longSlug);
		expect(references.className).toContain("[overflow-wrap:anywhere]");
		expect(health.textContent).toContain("MCP healthy");
		expect(health.textContent).toContain(longSlug);
		expect(health.className).toContain("[overflow-wrap:anywhere]");
		const referencesRow = references.closest("dd")?.parentElement;
		const healthRow = health.closest("dd")?.parentElement;
		expect(referencesRow).not.toBe(healthRow);
		expect(referencesRow?.querySelector("dt")?.textContent).toBe(
			"App identifiers",
		);
		expect(healthRow?.querySelector("dt")?.textContent).toBe("App service");
		const checkButton = button(`Check ${longSlug}`)!;
		expect(checkButton.className).toContain("whitespace-normal");
		expect(checkButton.className).toContain("[overflow-wrap:anywhere]");
	});

	it("lists every account of a multi-account provider under one row", async () => {
		const mail = {
			...named,
			provider: { ...provider, appId: "ms-mail", name: "Microsoft Graph Mail" },
			instanceLabel: "Mail account",
		};
		await render([base, named, mail]);
		await expand();
		const calendar = host.querySelector('[data-account-group="ms-calendar"]')!;
		expect(calendar.textContent).toContain("Default account");
		expect(calendar.textContent).toContain("Work account");
		expect(calendar.textContent).not.toContain("Mail account");
	});

	it.each(["Rename", "Reconnect", "Disconnect"])(
		"routes %s through the exact named account",
		async (action) => {
			const props = await render([base, named]);
			await expand();
			await details();
			const target =
				action === "Rename"
					? button("Rename Work account")!
					: host.querySelector<HTMLButtonElement>(
							`button[aria-label="${action} Outlook Calendar Work account"]`,
						)!;
			await act(async () => target.click());
			const callback =
				action === "Rename"
					? props.onRename
					: action === "Reconnect"
						? props.onReconnect
						: props.onDisconnect;
			expect(callback).toHaveBeenCalledWith(named);
		},
	);

	it("routes Add account to the exact provider", async () => {
		const props = await render([base, named]);
		await expand();
		await act(async () => button("Add account")!.click());
		expect(props.onAdd).toHaveBeenCalledWith(provider);
	});

	it("offers no second account where the app takes one account", async () => {
		await render(
			[
				{
					...base,
					provider: {
						...provider,
						connectionType: "api_key",
						accountMode: "single",
						availableAccountModes: ["single"],
					},
				},
			],
			{ owner: "organization" },
		);
		await expand();
		expect(host.textContent).toContain("Everyone in this organization");
		expect(host.textContent).toContain("Connected by user@example.com");
		expect(button("Add account")).toBeUndefined();
		await details();
		expect(host.textContent).toContain("One account");
		expect(host.textContent).toContain("Tedix keeps one key per owner");
	});

	it("shows the organization account policy control only to admins", async () => {
		const onAccountModeChange = vi.fn();
		await render([base], {
			owner: "organization",
			onAccountModeChange,
		});
		await expand();
		await details();
		expect(
			host.querySelector(
				'[aria-label="Accounts allowed for Outlook Calendar"]',
			),
		).not.toBeNull();
		expect(host.textContent).toContain("Several accounts");
	});

	it("shows an unchecked status as neutral, with Reconnect on the account and Check now in Details", async () => {
		const props = await render([
			{ ...named, accountState: "unknown", connection: null },
			{ ...base, accountState: "restricted", connection: null },
		]);
		const row = host.querySelector('[data-account-group="ms-calendar"]')!;
		expect(row.textContent).toBe("Outlook CalendarStatus not checked");
		expect(
			row.querySelector('[data-account-status="unchecked"]'),
		).not.toBeNull();
		expect(host.textContent).not.toContain("Needs attention");
		expect(button("Reconnect")).toBeUndefined();
		await expand();
		expect(host.textContent).toContain(
			"Status not checked: Couldn't check this account",
		);
		expect(host.textContent).toContain(
			"Status not checked: Provider didn't allow a status check",
		);
		expect(button("Reconnect")).toBeDefined();
		expect(button("Connect")).toBeUndefined();
		expect(host.textContent).not.toContain("Not connected");
		await details();
		expect(host.textContent).toContain("Couldn't check this account");
		await act(async () => button("Check now")!.click());
		expect(props.onCheck).toHaveBeenCalledOnce();
	});

	it("keeps Needs attention and Reconnect for a real fault", async () => {
		const props = await render([
			{ ...base, accountState: "restricted", connection: null },
			{
				...base,
				provider: {
					...provider,
					appId: "ms-mail",
					name: "Microsoft Graph Mail",
				},
				accountState: "expired",
			},
		]);
		const groups = [...host.querySelectorAll("[data-account-group]")];
		expect(
			groups.map((group) => group.getAttribute("data-account-group")),
		).toEqual(["ms-mail", "ms-calendar"]);
		expect(groups[0]!.textContent).toContain(
			"Needs attention: Sign-in expired",
		);
		await act(async () => button("Reconnect")!.click());
		expect(props.onReconnect).toHaveBeenCalledOnce();
		expect(
			[...host.querySelectorAll("button")].filter(
				(item) => item.textContent?.trim() === "Reconnect",
			),
		).toHaveLength(1);
	});

	it("keeps management actions disabled without permission", async () => {
		const props = await render([base, named], { canManage: () => false });
		await expand();
		await details();
		for (const label of ["Reconnect", "Disconnect", "Rename Work account"])
			expect(
				[...host.querySelectorAll<HTMLButtonElement>("button")]
					.filter((item) => item.textContent === label)
					.every((item) => item.disabled),
			).toBe(true);
		expect(props.onDisconnect).not.toHaveBeenCalled();
	});

	it("binds only explicit named account targets, by app name", async () => {
		const target = {
			appId: "second-calendar-app",
			appSlug: "second-calendar",
			source: "app" as const,
		};
		const row = { ...named, bindingTargets: [target] };
		const props = await render([row]);
		await expand();
		await details();
		await act(async () => button("Use for Second calendar")!.click());
		expect(props.onBind).toHaveBeenCalledWith(row, target);
	});

	it("lets an org admin turn an account's access check off and back to default", async () => {
		const row = {
			...named,
			scope: "tenant" as const,
			accessCheck: { checkEachPersonsAccess: true, source: "default" as const },
		};
		const props = await render([row], {
			owner: "organization",
			onSetAccessCheck: vi.fn(),
		});
		await expand();
		await details();
		expect(host.textContent).toContain("Check each person's access");
		expect(host.querySelector('[data-access-check="on"]')).not.toBeNull();
		expect(button("Use default")).toBeUndefined();
		await act(async () => button("Turn off")!.click());
		expect(props.onSetAccessCheck).toHaveBeenCalledWith(row, false);
	});

	it("offers the default back for an admin override and blocks non-admins", async () => {
		const row = {
			...named,
			scope: "tenant" as const,
			accessCheck: { checkEachPersonsAccess: false, source: "admin" as const },
		};
		const props = await render([row], {
			owner: "organization",
			canManage: () => false,
			onSetAccessCheck: vi.fn(),
		});
		await expand();
		await details();
		expect(host.textContent).toContain("set by an admin");
		expect(button("Turn on")!.disabled).toBe(true);
		expect(button("Use default")!.disabled).toBe(true);
		expect(props.onSetAccessCheck).not.toHaveBeenCalled();
	});

	it("collapses never-connected apps under Available to connect", async () => {
		const props = await render([
			base,
			{
				...base,
				provider: { ...provider, appId: "alpic", name: "Alpic" },
				accountState: "missing",
				connection: null,
			},
		]);
		expect(host.textContent).toContain("Available to connect");
		expect(host.querySelector('[data-account-group="alpic"]')).toBeNull();
		await act(async () =>
			[...host.querySelectorAll("button")]
				.find((item) => item.textContent?.includes("Available to connect"))!
				.click(),
		);
		const alpic = host.querySelector('[data-account-group="alpic"]')!;
		await act(async () => button("Connect", alpic)!.click());
		expect(props.onConnect).toHaveBeenCalledOnce();
	});
});
