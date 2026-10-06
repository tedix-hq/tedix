import { OS_LOGOUT_PATH } from "@/shared/session-status";
import type {
	OsUserPreferences,
	OsUserPreferencesState,
} from "@tedix/api-contract/schemas/user-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const userSettingsApi = vi.hoisted(() => ({
	getPreferences: vi.fn(),
	updatePreferences: vi.fn(),
	getContext: vi.fn(),
}));
const runtimeEntitlementsApi = vi.hoisted(() => ({ get: vi.fn() }));
const connectionsApi = vi.hoisted(() => ({ getUserConnections: vi.fn() }));

vi.mock("@/lib/api", () => ({
	osApi: {
		userSettings: userSettingsApi,
		runtimeEntitlements: runtimeEntitlementsApi,
		connections: connectionsApi,
	},
}));

vi.mock("@/lib/use-os-identity", () => ({
	useOsIdentity: () => ({ name: "Owner", email: "owner@example.com" }),
}));

import {
	inferenceAdmissionLabel,
	modelPolicySummary,
	preferenceOrigin,
	SettingsPage,
	saveState,
} from "./settings-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULTS: OsUserPreferences = {
	theme: "system",
	density: "comfortable",
	locale: null,
	timezone: null,
	accessibility: { motion: "system", contrast: "system" },
	notifications: { approvals: true, runFailures: true, budgetAlerts: true },
	conversationModelRef: null,
};

const cleanups: Array<() => void> = [];

/** TanStack Link needs a RouterProvider; the seam takes an anchor stub. */
function StubMembersLink({
	search,
	to,
	className,
	children,
}: {
	to:
		| "/team"
		| "/admin/organization"
		| "/admin/billing"
		| "/account/connections";
	search?: { tab: "members" };
	className?: string;
	children?: ReactNode;
}) {
	return (
		<a className={className} href={search ? `${to}?tab=${search.tab}` : to}>
			{children}
		</a>
	);
}

function render(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<SettingsPage MembersLinkComponent={StubMembersLink} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 6; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

describe("saveState", () => {
	it("keeps pending, conflict, error and clean distinguishable", () => {
		expect(saveState({ dirty: true, isPending: true, error: null })).toBe(
			"saving",
		);
		expect(
			saveState({ dirty: true, isPending: false, error: { code: "CONFLICT" } }),
		).toBe("conflict");
		expect(
			saveState({ dirty: true, isPending: false, error: new Error("boom") }),
		).toBe("error");
		expect(saveState({ dirty: true, isPending: false, error: null })).toBe(
			"dirty",
		);
		expect(saveState({ dirty: false, isPending: false, error: null })).toBe(
			"clean",
		);
	});
});

describe("preferenceOrigin", () => {
	const base: OsUserPreferencesState = {
		preferences: DEFAULTS,
		source: "default",
		revision: 0,
		updatedAt: null,
	};

	it("never reports platform defaults as the operator's saved choice", () => {
		expect(preferenceOrigin(base)).toContain("nothing saved");
	});

	it("distinguishes an unreadable stored row from an unset one", () => {
		// source `default` at a NON-zero revision means a row exists but did not
		// parse — that is a different fact from "never saved" and must read so.
		expect(preferenceOrigin({ ...base, revision: 4 })).toContain(
			"could not be read",
		);
	});

	it("reports a real save with its timestamp", () => {
		const text = preferenceOrigin({
			...base,
			source: "stored",
			revision: 2,
			updatedAt: "2026-08-17T10:00:00.000Z",
		});
		expect(text).toContain("Saved to your Tedix profile");
		expect(text).toContain("2026");
	});

	it("names the isolated profile instead of claiming a Tedix account", () => {
		expect(preferenceOrigin(base, true)).toContain("isolated profile");
		expect(
			preferenceOrigin({ ...base, source: "stored", revision: 1 }, true),
		).toContain("isolated local profile");
	});
});

describe("inferenceAdmissionLabel", () => {
	it("separates local entitlement from provider transport", () => {
		expect(
			inferenceAdmissionLabel({
				active: true,
				localEvaluation: true,
				localInferenceEnabled: false,
			}),
		).toBe("AI replies are off in this local session");
		expect(
			inferenceAdmissionLabel({
				active: true,
				localEvaluation: true,
				localInferenceEnabled: true,
			}),
		).toBe("Paid remote AI is enabled for this local session");
	});

	it("keeps production admission and blocked states explicit", () => {
		expect(
			inferenceAdmissionLabel({
				active: true,
				localEvaluation: false,
				localInferenceEnabled: false,
			}),
		).toBe("admitting inference");
		expect(
			inferenceAdmissionLabel({
				active: false,
				localEvaluation: true,
				localInferenceEnabled: true,
			}),
		).toBe("inference BLOCKED");
	});
});

describe("modelPolicySummary", () => {
	it("keeps the unconfigured and limited model policies distinct", () => {
		expect(modelPolicySummary(null)).toBe("All model tiers allowed");
		expect(
			modelPolicySummary({
				allowedModelTiers: ["balanced", "frontier"],
				dailyTokenLimit: 50_000,
				dailySpendLimitMicros: 2_500_000,
			}),
		).toBe("Model tiers: balanced · frontier · 50,000 tokens/day · $2.50/day");
	});
});

describe("SettingsPage", () => {
	beforeEach(() => {
		for (const fn of [
			userSettingsApi.getPreferences,
			userSettingsApi.updatePreferences,
			userSettingsApi.getContext,
			runtimeEntitlementsApi.get,
			connectionsApi.getUserConnections,
		]) {
			fn.mockReset();
		}
		userSettingsApi.getPreferences.mockResolvedValue({
			preferences: DEFAULTS,
			source: "default",
			revision: 0,
			updatedAt: null,
		});
		userSettingsApi.getContext.mockResolvedValue({
			organization: {
				id: "00000000-0000-4000-8000-000000000001",
				name: "Acme",
				slug: "acme",
				type: "organization",
				logoUrl: null,
			},
			authority: {
				authType: "user",
				role: "member",
				permissions: ["apps:read", "os:read", "os:run"],
				machineScopes: [],
				crossTenantOverrideActive: false,
			},
			purpose: { access: "restricted", charter: null },
		});
		runtimeEntitlementsApi.get.mockResolvedValue({
			entitlement: null,
			modelPolicy: null,
		});
		connectionsApi.getUserConnections.mockResolvedValue({ data: [] });
	});

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("reads the durable preferences rather than browser storage", async () => {
		const container = render();
		await flush();
		expect(userSettingsApi.getPreferences).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain(
			"nothing saved to your profile yet",
		);
	});

	it("provides a visible broker-backed sign-out action", async () => {
		const container = render();
		await flush();
		const signOut = [...container.querySelectorAll("a")].find(
			(anchor) => anchor.textContent?.trim() === "Sign out",
		);
		expect(signOut?.getAttribute("href")).toBe(OS_LOGOUT_PATH);
	});

	it("uses Kumo icon frames and keeps mobile controls below the icon-copy pair", async () => {
		const container = render();
		await flush();
		const rows = [...container.querySelectorAll('[data-slot="setting-row"]')];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(
				row.querySelector(':scope > [data-slot="icon-frame"]'),
			).not.toBeNull();
			expect(row.className).toContain("grid-cols-[2.25rem_minmax(0,1fr)]");
		}

		const controls = [
			...container.querySelectorAll('[data-slot="setting-row-control"]'),
		];
		expect(controls.length).toBeGreaterThan(0);
		for (const control of controls) {
			expect(control.className).toContain("col-span-2");
			expect(control.className).toContain("sm:col-span-1");
		}
	});

	it("owns the complete user appearance choice", async () => {
		const container = render();
		await flush();
		const appearanceRow = [
			...container.querySelectorAll('[data-slot="setting-row"]'),
		].find((row) => row.textContent?.includes("Appearance"));
		expect(appearanceRow).not.toBeUndefined();
		for (const label of ["System", "Light", "Dark"]) {
			expect(
				[...appearanceRow!.querySelectorAll("button")].some((button) =>
					button.textContent?.includes(label),
				),
			).toBe(true);
		}
	});

	it("keeps sign out available when preferences cannot load", async () => {
		userSettingsApi.getPreferences.mockRejectedValue(
			new Error("identity mapping unavailable"),
		);
		const container = render();
		await flush();
		expect(container.textContent).toContain("Preferences could not be loaded");
		const signOut = [...container.querySelectorAll("a")].find(
			(anchor) => anchor.textContent?.trim() === "Sign out",
		);
		expect(signOut?.getAttribute("href")).toBe(OS_LOGOUT_PATH);
	});

	it("builds every deep link from the credential-resolved slug", async () => {
		const container = render();
		await flush();
		const hrefs = [...container.querySelectorAll("a")].map((a) =>
			a.getAttribute("href"),
		);
		// Organization settings and billing moved into the OS itself: internal
		// routes, never Dashboard deep links.
		expect(hrefs).toContain("/admin/organization");
		expect(hrefs).not.toContain(
			"https://app.tedix.dev/organizations/acme/settings/organization",
		);
		expect(hrefs).toContain("/admin/billing");
		expect(hrefs).not.toContain(
			"https://app.tedix.dev/organizations/acme/settings/billing",
		);
		// Connections live at the canonical personal account route; the old
		// Dashboard settings/connections deep link is gone.
		expect(hrefs).toContain("/account/connections");
		expect(hrefs).not.toContain(
			"https://app.tedix.dev/organizations/acme/settings/connections",
		);
		// Nothing may be derived from the hostname the shell was served on.
		expect(hrefs.every((href) => !href?.includes("localhost"))).toBe(true);
	});

	it("says a restricted charter is a permission boundary, not an empty one", async () => {
		const container = render();
		await flush();
		expect(container.textContent).toContain(
			"cannot read the charter. This is a permission boundary",
		);
		expect(container.textContent).not.toContain("No charter authored");
	});

	it("reports a missing entitlement as blocked inference, never as healthy", async () => {
		const container = render();
		await flush();
		expect(container.textContent).toContain(
			"No runtime entitlement configured",
		);
	});

	it("keeps the save button disabled until something actually changed", async () => {
		const container = render();
		await flush();
		const save = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Save preferences"),
		);
		expect(save?.hasAttribute("disabled")).toBe(true);
		expect(container.textContent).toContain("No unsaved changes");
		expect(userSettingsApi.updatePreferences).not.toHaveBeenCalled();
	});

	it("explains a lost compare-and-swap instead of silently retrying it", async () => {
		userSettingsApi.getPreferences.mockResolvedValue({
			preferences: DEFAULTS,
			source: "stored",
			revision: 3,
			updatedAt: "2026-08-17T10:00:00.000Z",
		});
		userSettingsApi.updatePreferences.mockRejectedValue({
			code: "CONFLICT",
			message: "lost",
			data: { expectedRevision: 3, currentRevision: 4 },
		});
		const container = render();
		await flush();

		// Drive the save through the same control an operator uses.
		const density = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Compact",
		);
		expect(density).toBeTruthy();
		await act(async () => {
			density?.click();
		});
		const save = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Save preferences"),
		);
		await act(async () => {
			save?.click();
		});
		await flush();

		expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({
			preferences: { ...DEFAULTS, density: "compact" },
			expectedRevision: 3,
		});
		expect(container.textContent).toContain("Someone else saved first");
		// Exactly one attempt: the losing write must not be replayed.
		expect(userSettingsApi.updatePreferences).toHaveBeenCalledTimes(1);
	});

	it("does not present stored-only model or notification controls as working settings", async () => {
		const container = render();
		await flush();
		expect(container.textContent).not.toContain("Conversational model");
		expect(container.textContent).not.toContain("Approvals awaiting you");
		expect(container.textContent).not.toContain(
			"No delivery channel reads these",
		);
	});
});
