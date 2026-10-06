import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const queryClient = vi.hoisted(() => ({
	fetchQuery: vi.fn(),
	invalidateQueries: vi.fn(),
}));
const authorityPermissions = vi.hoisted(() => ({
	current: ["settings:manage"],
}));
const customDomainEntitlement = vi.hoisted(() => ({
	enabled: true as boolean | undefined,
}));
const siteCustomDomain = vi.hoisted(() => ({
	current: "blog.acme.example" as string | null,
}));
const cmsSiteQuota = vi.hoisted(() => ({
	current: { used: 1, limit: 5 },
}));
const lifecycleMutation = vi.hoisted(() => ({
	isPending: false,
	mutate: vi.fn(),
}));
const domainClaim = vi.hoisted(() => ({
	current: null as null | {
		claimId: string;
		hostname: string;
		status: "pending" | "provisioning" | "active" | "removing";
		isZoneApex: boolean;
		txtName: string;
		txtValue: string;
		cnameTarget: string;
		providerStatus: string | null;
		sslStatus: string | null;
		validationRecords: Array<{
			type: "TXT" | "CNAME";
			name: string;
			value: string;
		}>;
	},
}));
const redirectClaim = vi.hoisted(() => ({
	current: null as typeof domainClaim.current,
}));
const deprovisionStatusData = vi.hoisted(() => ({
	current: undefined as
		| {
				operationId: string;
				siteId: string;
				slug: string;
				status: "queued" | "running" | "succeeded" | "failed";
				stage: string;
				deleted: string[];
				errors: string[];
		  }
		| undefined,
}));
const deprovisionStatusOptions = vi.hoisted(() => ({
	current: null as null | {
		refetchInterval: (query: {
			state: { data?: { operationId: string; status: string } };
		}) => number | false;
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: vi.fn(() => lifecycleMutation),
	useQueryClient: () => queryClient,
	useQuery: (options: { testKind?: string }) => {
		if (options.testKind === "cms-www") {
			return {
				isPending: false,
				isError: false,
				isSuccess: true,
				data: redirectClaim.current,
				refetch: vi.fn(),
			};
		}
		if (options.testKind === "cms-domain") {
			return {
				isPending: false,
				isError: false,
				isSuccess: true,
				data: domainClaim.current,
				refetch: vi.fn(),
			};
		}
		if (options.testKind === "deprovision-status") {
			deprovisionStatusOptions.current =
				options as typeof deprovisionStatusOptions.current;
			return {
				isPending: !deprovisionStatusData.current,
				isError: false,
				data: deprovisionStatusData.current,
			};
		}
		if (options.testKind === "sites") {
			return {
				isPending: false,
				isError: false,
				data: {
					cmsCustomDomainsEnabled: customDomainEntitlement.enabled,
					cmsSiteQuota: cmsSiteQuota.current,
					sites: [
						{
							id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
							type: "cms",
							slug: "acme",
							name: "Acme",
							description: null,
							status: "active",
							url: "https://blog.acme.example",
							accessMode: null,
							customDomain: siteCustomDomain.current,
							activeRevisionId: "75",
							mcpAppId: null,
							authoringAppId: null,
						},
					],
				},
			};
		}
		if (options.testKind === "reconciliation") {
			return {
				isPending: false,
				isError: false,
				data: {
					checkedAt: "2026-08-31T12:00:00.000Z",
					source: "scheduled",
					sitesChecked: 1,
					issues: [],
				},
			};
		}
		return { isPending: false, isError: false, data: undefined };
	},
}));

vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		sites: {
			getCmsDomain: {
				queryOptions: ({
					input,
				}: {
					input: { siteId: string; redirectToApex?: boolean };
				}) => ({
					testKind: input.redirectToApex ? "cms-www" : "cms-domain",
					queryKey: [
						"sites",
						"getCmsDomain",
						input.siteId,
						input.redirectToApex ?? false,
					],
				}),
			},
		},
	},
	docsSiteWorkspaceQueryOptions: () => ({ testKind: "docs" }),
	siteDeprovisionPlanQueryOptions: () => ({ testKind: "deprovision" }),
	siteDeprovisionStatusQueryOptions: () => ({ testKind: "deprovision-status" }),
	siteRecoveryManifestQueryOptions: () => ({ testKind: "recovery" }),
	sitesQueryOptions: () => ({ testKind: "sites" }),
	sitesReconciliationQueryOptions: () => ({ testKind: "reconciliation" }),
}));

vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: { permissions: authorityPermissions.current } },
	}),
}));

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant" }),
}));

vi.mock("@/lib/api", () => ({
	osSiteDeprovisionApi: {
		sites: { deprovision: vi.fn() },
	},
	osApi: {
		docs: {
			publishBuild: vi.fn(),
			rollbackBuild: vi.fn(),
			startBuild: vi.fn(),
		},
		sites: {
			beginCmsDomain: vi.fn(),
			getCmsDomain: vi.fn(),
			verifyCmsDomain: vi.fn(),
			removeCmsDomain: vi.fn(),
			createCms: vi.fn(),
			runReconciliation: vi.fn(),
			setLifecycle: vi.fn(),
			deprovision: vi.fn(),
		},
	},
}));

vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/components/kumo/dropdown-menu", () => ({
	DropdownMenu: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="menu">{children}</div>
	),
	DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="menu-content">{children}</div>
	),
	DropdownMenuItem: ({
		children,
		onClick,
		variant,
	}: {
		children: React.ReactNode;
		onClick?: () => void;
		variant?: string;
	}) => (
		<button
			type="button"
			data-testid="menu-item"
			data-variant={variant}
			onClick={onClick}
		>
			{children}
		</button>
	),
	DropdownMenuSeparator: () => <hr />,
	DropdownMenuTrigger: ({
		children,
		render,
	}: {
		children: React.ReactNode;
		render: React.ReactElement<{ "aria-label"?: string }>;
	}) => (
		<button type="button" aria-label={render.props["aria-label"]}>
			{children}
		</button>
	),
}));

import { SitesPage } from "./sites-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

beforeEach(() => {
	authorityPermissions.current = ["settings:manage"];
	customDomainEntitlement.enabled = true;
	siteCustomDomain.current = "blog.acme.example";
	domainClaim.current = null;
	redirectClaim.current = null;
	cmsSiteQuota.current = { used: 1, limit: 5 };
	queryClient.fetchQuery.mockReset();
	queryClient.invalidateQueries.mockReset();
	lifecycleMutation.mutate.mockReset();
	deprovisionStatusData.current = undefined;
	deprovisionStatusOptions.current = null;
	window.sessionStorage.clear();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function renderPage(): HTMLElement {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	act(() => root.render(<SitesPage />));
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	return host;
}

function enterConfirmation(slug: string) {
	const input = document.querySelector<HTMLInputElement>(
		'input[aria-labelledby*="confirmation"]',
	);
	if (!input) throw new Error("Confirmation input missing");
	act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, slug);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("SitesPage owned-site actions", () => {
	it("lets an owner manage a legacy active domain after a plan downgrade", () => {
		customDomainEntitlement.enabled = false;
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain("Existing domain: blog.acme.example");
		expect(host.querySelector('input[id^="cms-domain-"]')).toBeNull();
		const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Manage existing domain",
		);
		if (!action) throw new Error("Legacy domain action missing");
		act(() => action.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith("blog.acme.example");
	});

	it("explains an in-flight domain provisioning attempt and offers retry", () => {
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "www.acme.example",
			status: "provisioning",
			isZoneApex: false,
			txtName: "_tedix.www.acme.example",
			txtValue: "tedix-verify=claim",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "pending",
			sslStatus: null,
			validationRecords: [],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain("Provisioning is in progress");
		const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Retry provisioning",
		);
		if (!retry) throw new Error("Provisioning retry missing");
		act(() => retry.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith(
			domainClaim.current.claimId,
		);
	});

	it("keeps existing domain inspection and removal after the plan loses custom domains", () => {
		customDomainEntitlement.enabled = false;
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "www.acme.example",
			status: "pending",
			isZoneApex: false,
			txtName: "_tedix.www.acme.example",
			txtValue: "tedix-verify=claim",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: null,
			sslStatus: null,
			validationRecords: [],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain(
			"Custom domains are unavailable on this plan",
		);
		expect(host.textContent).toContain("_tedix.www.acme.example");
		expect(host.querySelector('input[id^="cms-domain-"]')).toBeNull();
		expect(host.textContent).not.toContain("Verify domain");
		expect(host.textContent).toContain("Remove domain");
	});

	it("hides domain management until the API advertises the capability", () => {
		customDomainEntitlement.enabled = undefined;
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).not.toContain("Manage existing domain");
		expect(host.querySelector('input[id^="cms-domain-"]')).toBeNull();
	});

	it("shows DNS ownership and TLS instructions for a pending CMS domain", () => {
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "www.acme.example",
			status: "pending",
			isZoneApex: false,
			txtName: "_tedix.www.acme.example",
			txtValue: "tedix-verify=claim",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "pending_validation",
			sslStatus: "pending",
			validationRecords: [
				{
					type: "CNAME",
					name: "_acme-challenge.www.acme.example",
					value: "tls-token",
				},
			],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain("_tedix.www.acme.example");
		expect(host.textContent).toContain("tedix-verify=claim");
		expect(host.textContent).toContain("acme.cms.tedix.dev");
		expect(host.textContent).toContain("_acme-challenge.www.acme.example");
		expect(host.textContent).toContain("tls-token");
		expect(
			[...host.querySelectorAll("li")].find((item) =>
				item.textContent?.includes("_acme-challenge.www.acme.example"),
			)?.textContent,
		).toContain("CNAME");
		const verify = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Verify domain",
		);
		if (!verify) throw new Error("Verify action missing");
		act(() => verify.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith(
			domainClaim.current.claimId,
		);
	});

	it("offers a www redirect after the root domain becomes active", () => {
		siteCustomDomain.current = "acme.example";
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "acme.example",
			status: "active",
			isZoneApex: true,
			txtName: "_tedix-cms.acme.example",
			txtValue: "tedix-verify=root",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "active",
			sslStatus: "active",
			validationRecords: [],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		const connect = [
			...host.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Connect www redirect");
		if (!connect) throw new Error("www action missing");
		act(() => connect.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith("acme.example");
		expect(host.textContent).not.toContain(
			"HTTPS requests to www.acme.example redirect",
		);
	});

	it("shows separate www DNS and TLS status until its HTTPS redirect is active", () => {
		siteCustomDomain.current = "acme.example";
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "acme.example",
			status: "active",
			isZoneApex: true,
			txtName: "_tedix-cms.acme.example",
			txtValue: "tedix-verify=root",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "active",
			sslStatus: "active",
			validationRecords: [],
		};
		redirectClaim.current = {
			claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			hostname: "www.acme.example",
			status: "pending",
			isZoneApex: false,
			txtName: "_tedix-cms.www.acme.example",
			txtValue: "tedix-verify=www",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "pending_validation",
			sslStatus: "pending",
			validationRecords: [
				{
					type: "CNAME",
					name: "_acme-challenge.www.acme.example",
					value: "tls-www",
				},
			],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain("_tedix-cms.www.acme.example");
		expect(host.textContent).toContain("tedix-verify=www");
		expect(host.textContent).toContain("_acme-challenge.www.acme.example");
		expect(host.textContent).toContain(
			"Provider: pending_validation · SSL: pending",
		);
		expect(host.textContent).toContain(
			"The HTTPS 301 redirect starts after www and its TLS certificate are active.",
		);
		const verify = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Verify www",
		);
		if (!verify) throw new Error("Verify www action missing");
		act(() => verify.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith(
			redirectClaim.current.claimId,
		);
	});

	it("reports active www redirects and removes only the selected companion", () => {
		siteCustomDomain.current = "acme.example";
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "acme.example",
			status: "active",
			isZoneApex: true,
			txtName: "_tedix-cms.acme.example",
			txtValue: "tedix-verify=root",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "active",
			sslStatus: "active",
			validationRecords: [],
		};
		redirectClaim.current = {
			claimId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
			hostname: "www.acme.example",
			status: "active",
			isZoneApex: false,
			txtName: "_tedix-cms.www.acme.example",
			txtValue: "tedix-verify=www",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "active",
			sslStatus: "active",
			validationRecords: [],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		expect(host.textContent).toContain(
			"HTTPS requests to www.acme.example redirect to acme.example with a 301, preserving the path and query.",
		);
		const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Remove www redirect",
		);
		if (!remove) throw new Error("Remove www action missing");
		act(() => remove.click());
		expect(document.body.textContent).toContain("Remove www.acme.example?");
		const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")]
			.filter((button) => button.textContent?.trim() === "Remove domain")
			.at(-1);
		if (!confirm) throw new Error("Removal confirmation missing");
		act(() => confirm.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith(
			redirectClaim.current.claimId,
		);
	});

	it("lets an admin start a custom domain claim from the CMS site", async () => {
		siteCustomDomain.current = null;
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		const input = host.querySelector<HTMLInputElement>(
			"#cms-domain-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		);
		const form = input?.closest("form");
		if (!input || !form) throw new Error("Domain form missing");
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, "www.new.example");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			),
		);
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith("www.new.example");
	});

	it("asks before removing an active custom domain", () => {
		domainClaim.current = {
			claimId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			hostname: "www.acme.example",
			status: "active",
			isZoneApex: false,
			txtName: "_tedix.www.acme.example",
			txtValue: "tedix-verify=claim",
			cnameTarget: "acme.cms.tedix.dev",
			providerStatus: "active",
			sslStatus: "active",
			validationRecords: [],
		};
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());
		const remove = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Remove domain",
		);
		if (!remove) throw new Error("Remove action missing");
		act(() => remove.click());
		expect(lifecycleMutation.mutate).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Remove www.acme.example?");
		const confirm = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(button) =>
				button.textContent?.trim() === "Remove domain" && button !== remove,
		);
		if (!confirm) throw new Error("Removal confirmation missing");
		act(() => confirm.click());
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith(
			domainClaim.current.claimId,
		);
	});

	it("shows quota usage and disables creation when all slots are used", () => {
		cmsSiteQuota.current = { used: 1, limit: 1 };
		const host = renderPage();
		expect(host.textContent).toContain("1 / 1 CMS sites");
		expect(
			Array.from(host.querySelectorAll("button")).find((button) =>
				button.textContent?.includes("Create CMS site"),
			)?.disabled,
		).toBe(true);
	});

	it("hides creation from a viewer who can only read owned sites", () => {
		authorityPermissions.current = [];
		const host = renderPage();
		expect(host.querySelector("#new-cms-name")).toBeNull();
		expect(
			host.querySelector('button[aria-controls="create-cms-site"]'),
		).toBeNull();
		expect(host.textContent).toContain("Acme");
	});

	it("offers a starter selection and submits a new site for authoring", async () => {
		const host = renderPage();
		expect(host.textContent).toContain("1 / 5 CMS sites");
		expect(host.querySelector("#new-cms-name")).toBeNull();
		const create = host.querySelector<HTMLButtonElement>(
			'button[aria-controls="create-cms-site"]',
		);
		if (!create) throw new Error("Create site action missing");
		act(() => create.click());
		const name = host.querySelector<HTMLInputElement>("#new-cms-name");
		const slug = host.querySelector<HTMLInputElement>("#new-cms-slug");
		const form = name?.closest("form");
		if (!name || !slug || !form) throw new Error("CMS creation form missing");
		act(() => {
			for (const [input, value] of [
				[name, "New site"],
				[slug, "new-site"],
			] as const) {
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(input, value);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});
		await act(async () =>
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			),
		);
		expect(lifecycleMutation.mutate).toHaveBeenCalledWith({
			name: "New site",
			slug: "new-site",
			templateSlug: "native-marketing",
		});
		expect(host.textContent).toContain("Deploy a theme when you");
	});
	it("presents each site as a scan-friendly row with its status and release", () => {
		const host = renderPage();
		const siteRow = host.querySelector("tbody tr");

		expect(siteRow?.querySelector('[data-slot="icon-frame"]')).not.toBeNull();
		expect(siteRow?.textContent).toContain("Acme");
		expect(siteRow?.textContent).toContain("active");
		expect(siteRow?.textContent).toContain("blog.acme.example");
		expect(siteRow?.textContent).toContain("Bundle v75");
	});

	it("makes management visible and keeps lifecycle actions in the menu", () => {
		const host = renderPage();

		expect(
			[...host.querySelectorAll("tbody button")].find(
				(button) => button.textContent?.trim() === "Manage",
			),
		).not.toBeNull();
		expect(
			host.querySelector('button[aria-label="More actions for Acme"]'),
		).not.toBeNull();
		expect(host.textContent).toContain("Open public site");
		expect(
			host.querySelector(
				'[data-testid="menu-item"][data-variant="destructive"]',
			)?.textContent,
		).toBe("Archive site");
	});

	it("filters sites by domain and opens a focused management view", () => {
		const host = renderPage();
		const search = host.querySelector<HTMLInputElement>(
			'input[aria-label="Search sites"]',
		);
		if (!search) throw new Error("Site search missing");
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(search, "missing.example");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.textContent).toContain("No matching sites");
		const clear = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "Clear filters",
		);
		if (!clear) throw new Error("Clear filters action missing");
		act(() => clear.click());
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>("tbody button"),
		].find((button) => button.textContent?.trim() === "Manage");
		if (!manage) throw new Error("Visible Manage action missing");
		act(() => manage.click());
		expect(host.querySelector("h1")?.textContent).toBe("Acme");
		expect(host.textContent).toContain("Custom domain");
		expect(host.querySelector("tbody")).toBeNull();
		const back = host.querySelector<HTMLButtonElement>("[data-page-back]");
		if (!back) throw new Error("Back to all sites missing");
		act(() => back.click());
		expect(host.querySelector("tbody tr")).not.toBeNull();
	});

	it("opens typed confirmation immediately before any lifecycle mutation", () => {
		const host = renderPage();
		const archive = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Archive site");
		if (!archive) throw new Error("Archive action missing");

		act(() => archive.click());

		expect(lifecycleMutation.mutate).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Archive Acme?");
		expect(document.body.textContent).toContain("Type acme to confirm");
		expect(
			document.querySelector('input[aria-labelledby*="confirmation"]'),
		).not.toBeNull();
		expect(lifecycleMutation.mutate).not.toHaveBeenCalled();
	});

	it("submits the exact slug when the final archive button is clicked", async () => {
		const host = renderPage();
		const archive = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Archive site");
		if (!archive) throw new Error("Archive action missing");
		act(() => archive.click());
		enterConfirmation("acme");

		const confirm = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(button) =>
				button.textContent?.trim() === "Archive site" &&
				button.type === "submit",
		);
		if (!confirm) throw new Error("Final archive button missing");
		await act(async () => confirm.click());

		expect(lifecycleMutation.mutate).toHaveBeenCalledWith({
			siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			action: "archive",
			confirmation: "acme",
		});
		expect(document.body.textContent).toContain("Archive Acme?");
	});

	it("submits the exact slug when the final deprovision button is clicked", async () => {
		const host = renderPage();
		const manage = [
			...host.querySelectorAll<HTMLButtonElement>('[data-testid="menu-item"]'),
		].find((button) => button.textContent === "Manage site");
		if (!manage) throw new Error("Manage site action missing");
		act(() => manage.click());

		const deprovision = [
			...host.querySelectorAll<HTMLButtonElement>("button"),
		].find((button) => button.textContent?.trim() === "Deprovision");
		if (!deprovision) throw new Error("Deprovision action missing");
		act(() => deprovision.click());
		enterConfirmation("acme");

		const confirm = [
			...document.querySelectorAll<HTMLButtonElement>("button"),
		].find(
			(button) => button.textContent?.trim() === "Deprovision permanently",
		);
		if (!confirm) throw new Error("Final deprovision button missing");
		await act(async () => confirm.click());

		expect(lifecycleMutation.mutate).toHaveBeenCalledWith({
			siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			confirmation: "acme",
			name: "Acme",
		});
		expect(document.body.textContent).toContain("Deprovision Acme?");
	});

	it("restores the final cleanup receipt after a reload, even when the site is gone", () => {
		const operation = {
			operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			slug: "acme",
			name: "Acme",
			status: "queued",
			stage: "Starting cleanup",
			deleted: [],
			errors: [],
		};
		window.sessionStorage.setItem(
			"tedix:sites:last-deprovision",
			JSON.stringify(operation),
		);
		deprovisionStatusData.current = {
			...operation,
			status: "succeeded",
			stage: "Complete",
			deleted: ["durable_object", "media", "site"],
		};

		const host = renderPage();
		expect(host.textContent).toContain("Cleanup — Acme");
		expect(host.textContent).toContain("acme was deprovisioned");
		expect(host.textContent).toContain("3 resource(s) removed");
		expect(queryClient.invalidateQueries).toHaveBeenCalled();
		expect(
			JSON.parse(
				window.sessionStorage.getItem("tedix:sites:last-deprovision") ?? "null",
			).status,
		).toBe("succeeded");
	});

	it("polls a restored cleanup until the final receipt is available", () => {
		window.sessionStorage.setItem(
			"tedix:sites:last-deprovision",
			JSON.stringify({
				operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
				siteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				slug: "acme",
				name: "Acme",
				status: "queued",
				stage: "Starting cleanup",
				deleted: [],
				errors: [],
			}),
		);

		const host = renderPage();
		expect(host.textContent).toContain("Starting cleanup");
		expect(
			deprovisionStatusOptions.current?.refetchInterval({ state: {} }),
		).toBe(3_000);
		expect(
			deprovisionStatusOptions.current?.refetchInterval({
				state: {
					data: {
						operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
						status: "running",
					},
				},
			}),
		).toBe(3_000);
		expect(
			deprovisionStatusOptions.current?.refetchInterval({
				state: {
					data: {
						operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
						status: "succeeded",
					},
				},
			}),
		).toBe(false);
	});
});
