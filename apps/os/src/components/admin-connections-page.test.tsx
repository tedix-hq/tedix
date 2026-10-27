import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ConnectionInventoryRowSchema,
	type ConnectionInventoryRow,
} from "@tedix/api-contract/schemas/connections";
import {
	connectionInventoryCountLabel,
	AdminConnectionsPage,
	filterAccountRows,
} from "./admin-connections-page";

const state = vi.hoisted(() => ({
	rows: [] as ConnectionInventoryRow[],
	add: vi.fn(),
	connect: vi.fn(),
	invalidate: vi.fn(),
	mutate: vi.fn(),
	checkService: vi.fn(),
	canManage: true,
	canManageOrg: false,
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { rows: state.rows, issues: [] },
		isPending: false,
		isError: false,
	}),
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
	useMutation: () => ({ isPending: false, mutate: state.mutate }),
}));
vi.mock("@/lib/connections-actions", () => ({
	useCanManageConnections: () => state.canManageOrg,
	useCanManagePersonalOauthConnections: () => state.canManage,
	useCanBindPersonalAccounts: () => false,
	useConnectionCompleteListener: () => {},
	useDisconnectConnection: () => ({ isPending: false, isError: false }),
	startNamedOauthConnect: state.add,
	startOauthConnect: state.connect,
	effectiveConnectionScope: (_provider: unknown, scope: "user" | "tenant") =>
		scope,
}));
vi.mock("@/lib/api", () => ({
	osApi: {},
	osDirectReadApi: { mcpHealth: { run: state.checkService } },
}));
vi.mock("@/components/capability-navigation", () => ({
	CapabilityNavigation: () => null,
}));
vi.mock("@/components/connection-consumer-grants", () => ({
	ConnectionConsumerGrantsEditor: () => <span>Consumer grant controls</span>,
}));
vi.mock("@/lib/webmcp/use-webmcp-tools", () => ({ useWebMcpTools: () => {} }));
vi.mock("@/lib/os-query-options", () => ({
	connectionsOverviewQueryOptions: () => ({}),
	osQueryKeys: { connections: () => ["test-connections"] },
}));

function row(label?: string): ConnectionInventoryRow {
	return {
		provider: {
			appId: "microsoft-graph-ca-tedix-oauth",
			name: "Microsoft Graph Calendar OAuth",
			description: null,
			enabled: true,
			availableScopes: [],
			logoUrl: null,
			tokenScope: "user",
			recommendedScope: "user",
			connectionType: "oauth",
			registrationMode: "pre_registered",
			accountMode: "multiple",
			availableAccountModes: ["single", "multiple"],
			referencedByOrg: true,
			supportedScopes: ["user"],
		},
		scope: "user",
		accountState: "missing",
		accountLabel: null,
		capabilities: [],
		access: "not_evaluated",
		health: "not_checked",
		connection: null,
		references: [],
		bindingTargets: [],
		referencesComplete: true,
		...(label
			? { instanceLabel: label, connectionInstanceId: "slot-work" }
			: {}),
	};
}

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	state.rows = [];
	state.canManage = true;
	state.canManageOrg = false;
	vi.clearAllMocks();
});

describe("Account-first personal integration", () => {
	it("explains permission requirements when a read-only viewer opens a setup link", async () => {
		state.rows = [row()];
		state.canManage = false;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all", connect: row().provider.appId }}
					onSearchChange={() => {}}
				/>,
			),
		);
		const review = document.querySelector('[role="dialog"]');
		expect(review?.textContent).toContain("Ask an organization admin");
		const proceed = [...(review?.querySelectorAll("button") ?? [])].find(
			(button) => button.textContent === "Continue",
		);
		expect(proceed?.disabled).toBe(true);
		expect(state.connect).not.toHaveBeenCalled();
	});
	it.each([true, false])(
		"reviews a named setup scope upgrade with capability metadata %s",
		async (hasCapability) => {
			const target = row("Work account");
			target.accountState = "present";
			target.connection = {
				appId: target.provider.appId,
				providerName: target.provider.name,
				status: "connected",
				connectedAt: null,
				tokenExpiresAt: null,
				scopes: ["calendar.read"],
				tokenScope: "user",
			};
			target.capabilities = [
				{
					id: "write",
					label: "Write calendar",
					requiredScopes: ["calendar.write"],
					state: "not_configured",
					setupUrl: "/account/connections?connect=mail",
					verified: true,
				},
			];
			target.toolCapabilities = [
				{ id: "read", label: "Read events", riskTier: "read" },
				{
					id: "write",
					label: "Create events",
					riskTier: "bounded_write",
				},
				{
					id: "invite",
					label: "Send invitations",
					riskTier: "external_side_effect",
				},
			];
			target.toolCapabilitiesComplete = true;
			state.rows = [row(), target];
			state.connect.mockResolvedValue(undefined);
			host = document.createElement("div");
			document.body.append(host);
			root = createRoot(host);
			await act(async () =>
				root?.render(
					<AdminConnectionsPage
						scope="personal"
						search={{
							q: "",
							status: "all",
							connect: target.provider.appId,
							connectionInstanceId: "slot-work",
							capability: hasCapability ? "write" : undefined,
							scopes: hasCapability ? "untrusted.scope" : "calendar.write",
						}}
						onSearchChange={() => {}}
					/>,
				),
			);
			expect(state.connect).not.toHaveBeenCalled();
			const review = document.querySelector('[role="dialog"]');
			expect(review?.textContent).toContain("Connect Outlook Calendar");
			expect(review?.textContent).toContain("What Tedix can do with it");
			expect(review?.textContent).toContain("Read: Read events. Automatic.");
			expect(review?.textContent).toContain(
				"Create and edit: Create events. Automatic, logged.",
			);
			expect(review?.textContent).toContain(
				"Protected effects: Send invitations. Asks a person first.",
			);
			expect(review?.textContent).not.toContain("calendar.write");
			const details = [...(review?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Details",
			)!;
			await act(async () => details.click());
			expect(review?.textContent).toContain(
				"OAuth scopes: calendar.read, calendar.write",
			);
			expect(review?.textContent).not.toContain("untrusted.scope");
			const proceed = [...(review?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === "Continue",
			);
			expect(proceed).toBeDefined();
			await act(async () => proceed!.click());
			expect(state.connect).toHaveBeenCalledWith({
				appId: target.provider.appId,
				effectiveScope: "user",
				registrationMode: "pre_registered",
				connectionInstanceId: "slot-work",
				scopes: ["calendar.read", "calendar.write"],
			});
		},
	);
	it("keeps account actions read-only without personal OAuth permission", async () => {
		state.rows = [row()];
		state.canManage = false;
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		expect(host.textContent).not.toContain("Add account");
		const connect = [...host.querySelectorAll("button")].find(
			(button) => button.textContent === "Connect",
		)!;
		expect(connect.disabled).toBe(true);
		expect(state.add).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"uses the same organization account list with manage permission %s",
		async (canManage) => {
			state.rows = [
				{
					...row("Shared"),
					scope: "tenant",
					provider: { ...row().provider, supportedScopes: ["user", "tenant"] },
				},
			];
			state.canManageOrg = canManage;
			host = document.createElement("div");
			document.body.append(host);
			root = createRoot(host);
			await act(async () =>
				root?.render(
					<AdminConnectionsPage
						scope="organization"
						search={{ q: "", status: "all" }}
						onSearchChange={() => {}}
					/>,
				),
			);
			expect(host.textContent).toContain(
				"Needs attention: Sign-in not finished",
			);
			await act(async () =>
				host!
					.querySelector<HTMLButtonElement>(
						'button[aria-label="Outlook Calendar details"]',
					)!
					.click(),
			);
			expect(host.textContent).toContain("Shared");
			expect(host.textContent).toContain("Everyone in this organization");
			const add = [...host.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Add account"),
			);
			if (canManage) {
				expect(add).toBeDefined();
				await act(async () => add!.click());
				expect(state.add).toHaveBeenCalledWith({
					appId: "microsoft-graph-ca-tedix-oauth",
					effectiveScope: "tenant",
				});
			} else {
				expect(add).toBeUndefined();
				expect(
					[...host.querySelectorAll("button")].find(
						(b) => b.textContent === "Connect",
					)!.disabled,
				).toBe(true);
			}
		},
	);
	it("connects a named account using its exact slot ID", async () => {
		state.rows = [row(), row("Work account")];
		state.connect.mockResolvedValue(undefined);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		await act(async () =>
			host!
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Outlook Calendar details"]',
				)!
				.click(),
		);
		const named = host.querySelector('[data-account-row="slot-work"]')!;
		const connect = [...named.querySelectorAll("button")].find(
			(button) => button.textContent === "Connect",
		)!;
		await act(async () => connect.click());
		expect(state.connect).not.toHaveBeenCalled();
		const review = document.querySelector('[role="dialog"]')!;
		expect(review.textContent).toContain("Tedix keeps your");
		const proceed = [...review.querySelectorAll("button")].find(
			(button) => button.textContent === "Continue",
		)!;
		await act(async () => proceed.click());
		expect(state.connect).toHaveBeenCalledWith({
			appId: "microsoft-graph-ca-tedix-oauth",
			effectiveScope: "user",
			registrationMode: "pre_registered",
			connectionInstanceId: "slot-work",
		});
	});
	it("filters exact rows by friendly provider name, named labels and truthful references", () => {
		const rows = [row(), row("Work account")];
		expect(filterAccountRows(rows, "Outlook", "all")).toHaveLength(2);
		expect(filterAccountRows(rows, "Work", "all")).toEqual([rows[1]]);
		expect(filterAccountRows(rows, "", "used")).toHaveLength(0);
		expect(filterAccountRows(rows, "", "unused")).toHaveLength(2);
		expect(
			filterAccountRows(
				[{ ...rows[1]!, referencesComplete: false }],
				"",
				"unused",
			),
		).toHaveLength(0);
		const unknown = {
			...row(),
			accountState: "unknown",
		} as ConnectionInventoryRow;
		const expired = {
			...row(),
			accountState: "present",
			connection: { status: "expired" },
		} as ConnectionInventoryRow;
		expect(filterAccountRows([unknown, expired], "", "connected")).toHaveLength(
			0,
		);
		expect(
			filterAccountRows([unknown, expired], "", "not_connected"),
		).toHaveLength(0);
		// An unchecked status is not a fault: only the expired row needs attention.
		expect(filterAccountRows([unknown, expired], "", "attention")).toEqual([
			expired,
		]);
	});

	it("starts OAuth directly and refreshes inventory after cancellation without creating a label dialog", async () => {
		state.rows = [row(), row("Work account")];
		let rejectConnect!: (error: Error) => void;
		state.add.mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectConnect = reject;
				}),
		);
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		expect(host.textContent).toContain("2 of 2 shown");
		await act(async () =>
			host!
				.querySelector<HTMLButtonElement>(
					'button[aria-label="Outlook Calendar details"]',
				)!
				.click(),
		);
		const add = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Add account"),
		)!;
		await act(async () => add.click());
		expect(state.add).toHaveBeenCalledWith({
			appId: "microsoft-graph-ca-tedix-oauth",
			effectiveScope: "user",
		});
		expect(host.textContent).not.toContain("Add personal account");
		await act(async () => rejectConnect(new Error("Connection cancelled")));
		expect(state.invalidate).toHaveBeenCalledWith({
			queryKey: ["test-connections"],
		});
		expect(host.textContent).toContain("Connection cancelled");
	});
});

describe("Connection inventory coverage", () => {
	it("scopes filtered counts to loaded rows when more rows exist", () => {
		expect(connectionInventoryCountLabel(12, 100, true)).toBe(
			"12 of first 100 shown",
		);
		expect(connectionInventoryCountLabel(12, 12, false)).toBe("12 of 12 shown");
	});

	it("hides long inventory status metadata at phone width", async () => {
		state.rows = Array.from({ length: 100 }, (_, index) => ({
			...row(`Account ${index + 1}`),
			connectionInstanceId: `slot-${index + 1}`,
		}));
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		const metadata = [...host.querySelectorAll("span")].find((element) =>
			element.textContent?.includes("100 of 100 shown"),
		);
		expect(metadata?.className).toContain("hidden");
		expect(metadata?.className).toContain("sm:inline");
	});

	it("shows an unverifiable account on its own row instead of a page banner", async () => {
		state.rows = [{ ...row(), accountState: "restricted" }];
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () =>
			root?.render(
				<AdminConnectionsPage
					scope="personal"
					search={{ q: "", status: "all" }}
					onSearchChange={() => {}}
				/>,
			),
		);
		expect(host.textContent).not.toContain("Verification incomplete");
		const affected = host.querySelector(
			'[data-account-group="microsoft-graph-ca-tedix-oauth"]',
		)!;
		expect(affected.textContent).toContain("Status not checked");
		expect(affected.textContent).not.toContain("Needs attention");
		expect(
			[...affected.querySelectorAll("button")].some(
				(button) => button.textContent === "Reconnect",
			),
		).toBe(false);
		expect(host.textContent).not.toContain("Provider healthy");
	});
});

type AccountKind = "oauth" | "named_oauth" | "api_key";
type RecoveryState = "missing" | "expired" | "needs_consent" | "error";

function recoveryRow(
	kind: AccountKind,
	scope: "user" | "tenant",
	status: RecoveryState,
): ConnectionInventoryRow {
	const appId = kind === "api_key" ? "acme-project-key" : "acme-calendar";
	return ConnectionInventoryRowSchema.parse({
		...row(),
		provider: {
			...row().provider,
			appId,
			name: kind === "api_key" ? "Acme Projects" : "Acme Calendar OAuth",
			connectionType: kind === "api_key" ? "api_key" : "oauth",
			registrationMode: kind === "api_key" ? null : "pre_registered",
			tokenScope: scope,
			recommendedScope: scope,
			supportedScopes: ["user", "tenant"],
		},
		scope,
		accountState:
			status === "error"
				? "unknown"
				: status === "needs_consent"
					? "present"
					: status,
		connection:
			status === "expired" || status === "needs_consent"
				? {
						appId,
						providerName: "Acme",
						status: status === "expired" ? "expired" : "reconnect_needed",
						connectedAt: null,
						tokenExpiresAt: null,
						scopes: ["calendar.read"],
						tokenScope: scope,
					}
				: null,
		references: [
			{ appId: "acme-app", appSlug: "acme-calendar", source: "app" },
		],
		...(kind === "named_oauth"
			? {
					instanceLabel: "Planning team",
					connectionInstanceId: "11111111-1111-4111-8111-111111111111",
				}
			: {}),
	});
}

async function mountRecoveryPage(
	scope: "user" | "tenant",
	search: {
		connect?: string;
		capability?: string;
		connectionInstanceId?: string;
	} = {},
) {
	if (!host) {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () =>
		root?.render(
			<AdminConnectionsPage
				scope={scope === "user" ? "personal" : "organization"}
				search={{ q: "", status: "all", ...search }}
				onSearchChange={() => {}}
			/>,
		),
	);
	return host;
}

const statusCopy = {
	missing: "Available to connect",
	expired: "Sign-in expired",
	needs_consent: "Sign in again to keep it working",
	error: "Status not checked",
} as const;

async function openDetails(page: ParentNode, name: string) {
	const trigger = page.querySelector<HTMLButtonElement>(
		`button[aria-label="${name} details"]`,
	);
	expect(trigger, `${name} details`).not.toBeNull();
	await act(async () => trigger!.click());
	await act(async () => recoveryButton(page, "Details").click());
}

function recoveryButton(parent: ParentNode, label: string) {
	const button = [
		...parent.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]'),
	].find((item) => item.textContent?.trim() === label);
	expect(button, `Available action: ${label}`).toBeDefined();
	return button!;
}

const recoveryCases = (["oauth", "named_oauth", "api_key"] as const).flatMap(
	(kind) =>
		(["user", "tenant"] as const).flatMap((scope) =>
			(["missing", "expired", "needs_consent", "error"] as const)
				// API keys cannot request OAuth consent.
				.filter((status) => kind !== "api_key" || status !== "needs_consent")
				.flatMap((status) =>
					[true, false].map((allowed) => ({ kind, scope, status, allowed })),
				),
		),
);

describe("Disconnected account recovery matrix", () => {
	it.each(recoveryCases)(
		"$kind / $scope / $status / allowed=$allowed preserves recovery and ownership",
		async ({ kind, scope, status, allowed }) => {
			const target = recoveryRow(kind, scope, status);
			const setup = new URLSearchParams({
				connect: target.provider.appId,
				capability: "read",
			});
			if (target.connectionInstanceId)
				setup.set("connectionInstanceId", target.connectionInstanceId);
			const setupUrl = `${scope === "user" ? "/account" : "/admin"}/connections?${setup}`;
			target.capabilities = [
				{
					id: "read",
					label: "Read calendar",
					requiredScopes: ["calendar.read"],
					state:
						status === "missing" || status === "error"
							? "not_configured"
							: "needs_reauth",
					setupUrl,
					verified: status !== "error",
				},
			];
			state.rows = [target];
			// Deliberately grant the other permission: it must not authorize this row.
			const personalOauth = kind !== "api_key" && scope === "user";
			state.canManage = personalOauth ? allowed : !allowed;
			state.canManageOrg = personalOauth ? !allowed : allowed;
			state.connect.mockResolvedValue(undefined);
			const page = await mountRecoveryPage(scope);
			const name = kind === "api_key" ? "Acme Projects" : "Acme Calendar";
			const visibleStatus =
				kind === "named_oauth" && status === "missing"
					? "Sign-in not finished"
					: kind === "api_key" && status === "expired"
						? "Key stopped working"
						: statusCopy[status];
			expect(page.textContent).toContain(visibleStatus);
			expect(page.textContent).not.toContain("MCP healthy");
			// A never-connected default account has nothing to inspect yet; every
			// other state opens details that name the owner and the setup link.
			if (!(status === "missing" && kind !== "named_oauth")) {
				await openDetails(page, name);
				expect(page.textContent).toContain(
					scope === "user" ? "Only you" : "Everyone in this organization",
				);
				const link = page.querySelector<HTMLAnchorElement>(
					'a[aria-label="Set up Read calendar"]',
				);
				expect(link?.getAttribute("href")).toBe(setupUrl);
			}
			// Follow the supported local setup route by rendering its validated search.
			// No browser navigation, OAuth popup or provider call occurs in this suite.
			await mountRecoveryPage(scope, {
				connect: setup.get("connect")!,
				capability: setup.get("capability")!,
				connectionInstanceId: setup.get("connectionInstanceId") ?? undefined,
			});
			const review = document.querySelector('[role="dialog"]')!;
			expect(review.textContent).toContain(
				scope === "user"
					? "Only you will be able to use this account"
					: "Apps in this organization will use this account",
			);
			const proceed = recoveryButton(review, "Continue");
			expect(proceed.disabled).toBe(!allowed);
			expect(state.connect).not.toHaveBeenCalled();
			if (!allowed) {
				expect(review.textContent).toContain(
					"Ask an organization admin to manage this connection or grant you access",
				);
				await act(async () => proceed.click());
				expect(state.connect).not.toHaveBeenCalled();
			} else {
				await act(async () => proceed.click());
				if (kind === "api_key") {
					expect(
						document.querySelector('[role="dialog"]')?.textContent,
					).toContain("Connect Acme Projects");
					expect(recoveryButton(document, "Save key").disabled).toBe(true);
					expect(state.connect).not.toHaveBeenCalled();
				} else {
					expect(state.connect).toHaveBeenCalledExactlyOnceWith({
						appId: target.provider.appId,
						effectiveScope: scope,
						registrationMode: "pre_registered",
						connectionInstanceId: target.connectionInstanceId,
						scopes: ["calendar.read"],
					});
				}
			}
			expect(state.add).not.toHaveBeenCalled();
			expect(state.mutate).not.toHaveBeenCalled();
			expect(state.checkService).not.toHaveBeenCalled();
		},
	);

	it.each(recoveryCases.filter(({ status }) => status !== "error"))(
		"$kind / $scope / $status / allowed=$allowed has a recovery action without capability metadata",
		async ({ kind, scope, status, allowed }) => {
			const target = recoveryRow(kind, scope, status);
			state.rows = [target];
			const personalOauth = kind !== "api_key" && scope === "user";
			state.canManage = personalOauth ? allowed : !allowed;
			state.canManageOrg = personalOauth ? !allowed : allowed;
			state.connect.mockResolvedValue(undefined);
			const page = await mountRecoveryPage(scope);
			const action = recoveryButton(
				page,
				status === "missing" ? "Connect" : "Reconnect",
			);
			expect(
				action.disabled || action.getAttribute("aria-disabled") === "true",
			).toBe(!allowed);
			await act(async () => action.click());
			if (allowed) {
				const review = document.querySelector('[role="dialog"]')!;
				expect(review.textContent).toContain("Tedix keeps your");
				if (status !== "missing")
					expect(review.textContent).toContain("replaces the current");
				expect(state.connect).not.toHaveBeenCalled();
				await act(async () => recoveryButton(review, "Continue").click());
			}
			if (allowed && kind !== "api_key")
				expect(state.connect).toHaveBeenCalledExactlyOnceWith({
					appId: target.provider.appId,
					effectiveScope: scope,
					registrationMode: "pre_registered",
					connectionInstanceId: target.connectionInstanceId,
				});
			else expect(state.connect).not.toHaveBeenCalled();
			if (allowed && kind === "api_key")
				expect(
					document.querySelector('[role="dialog"]')?.textContent,
				).toContain("Connect Acme Projects");
			expect(state.mutate).not.toHaveBeenCalled();
		},
	);

	it("keeps an unchecked MCP service separate from a mocked healthy service and an expired credential", async () => {
		state.rows = [recoveryRow("api_key", "tenant", "expired")];
		state.canManageOrg = true;
		state.checkService.mockResolvedValue({
			allPassed: true,
			passCount: 3,
			failCount: 0,
			toolCount: 2,
		});
		const page = await mountRecoveryPage("tenant");
		expect(page.textContent).not.toContain("MCP");
		await openDetails(page, "Acme Projects");
		expect(page.textContent).toContain("MCP service not checked");
		expect(page.textContent).not.toContain("MCP healthy");
		await act(async () => recoveryButton(page, "Check app service").click());
		expect(state.checkService).toHaveBeenCalledExactlyOnceWith({
			appSlug: "acme-calendar",
			authStrategy: "auto",
			tasksExtension: "ignore",
		});
		expect(page.textContent).toContain("MCP healthy · 2 live tools");
		expect(page.textContent).toContain("Key stopped working");
		expect(page.textContent).toContain(
			"Provider API tools and credential usability were not tested",
		);
		expect(state.connect).not.toHaveBeenCalled();
		expect(state.mutate).not.toHaveBeenCalled();
	});
});
