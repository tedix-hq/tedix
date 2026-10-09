import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const descopeMock = vi.hoisted(() => ({
	userEmail: "member@example.test" as string | null,
	selectTenant: vi.fn(),
	myTenants: vi.fn(async (_ids: string[]) => ({
		ok: true,
		data: { tenants: [{ id: "org_tedix", name: "Tedix" }] },
	})),
	logout: vi.fn(),
	refresh: vi.fn(async () => ({ ok: false })),
	flowProps: null as Record<string, unknown> | null,
}));

vi.mock("@descope/react-sdk/flows", () => ({
	AuthProvider: ({ children }: { children: React.ReactNode }) => children,
	Descope: (props: Record<string, unknown>) => {
		descopeMock.flowProps = props;
		return <div data-descope-flow />;
	},
	useDescope: () => descopeMock,
	useUser: () => ({
		user: descopeMock.userEmail ? { email: descopeMock.userEmail } : null,
		isUserLoading: false,
	}),
	useSession: () => ({
		isAuthenticated: false,
		isSessionLoading: false,
		sessionToken: null,
	}),
}));

const apiMock = vi.hoisted(() => ({
	listMyWorkspaces: vi.fn(),
	stageMultiOrgMcpConsent: vi.fn(),
	revokeMultiOrgMcpConsent: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		directory: { listMyWorkspaces: apiMock.listMyWorkspaces },
		organizations: {
			stageMultiOrgMcpConsent: apiMock.stageMultiOrgMcpConsent,
			revokeMultiOrgMcpConsent: apiMock.revokeMultiOrgMcpConsent,
		},
	},
}));

import {
	INBOUND_CONSENT_AUTHORIZE_INTERACTION,
	INBOUND_CONSENT_CANCEL_INTERACTION,
	InboundConsentPage,
	inboundConsentBrokerReturnPath,
} from "./inbound-consent-page";
import {
	DESCOPE_LOGIN_INTERACTIONS,
	INBOUND_CONSENT_OTP_INTERACTIONS,
	DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME,
} from "@/shared/descope-byos-contract";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const consentRevision = "00000000-0000-4000-8000-000000000001";
const originalFetch = globalThis.fetch;

function renderConsentPage() {
	root.render(<InboundConsentPage />);
}

async function clickButton(label: string) {
	await act(async () => {
		[...container.querySelectorAll("button")]
			.find((button) => button.textContent === label)
			?.click();
	});
}

beforeEach(() => {
	descopeMock.flowProps = null;
	descopeMock.userEmail = "member@example.test";
	descopeMock.myTenants.mockClear();
	globalThis.fetch = vi.fn(async () =>
		Response.json({
			authenticated: true,
			user: { email: " MEMBER@EXAMPLE.TEST " },
		}),
	);
	apiMock.listMyWorkspaces.mockReset();
	apiMock.stageMultiOrgMcpConsent.mockReset();
	apiMock.revokeMultiOrgMcpConsent.mockReset();
	apiMock.listMyWorkspaces.mockResolvedValue({
		data: [
			{
				org: { descopeTenantId: "org_tedix", provisionComplete: true },
				surfaces: [
					{
						surface: "mcp",
						provisioned: true,
						canonicalUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
					},
				],
			},
		],
		pagination: { limit: 100, offset: 0, total: 1, hasMore: false },
	});
	apiMock.stageMultiOrgMcpConsent.mockResolvedValue({
		revision: consentRevision,
	});
	apiMock.revokeMultiOrgMcpConsent.mockResolvedValue({});
	window.history.replaceState(
		{},
		"",
		"/oauth/consent?tenant=org_tedix&third_party_app_id=TPAclient1&resource=https%3A%2F%2Ftedix-unified.mcp.tedix.dev%2Fmcp",
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

it("keeps a multi-org password rejection on the retryable screen", async () => {
	window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
	await act(async () => renderConsentPage());
	const update = descopeMock.flowProps?.onScreenUpdate as (
		name: string,
		context: Record<string, unknown>,
		next: ReturnType<typeof vi.fn>,
	) => boolean;
	const next = vi.fn();
	await act(async () => {
		expect(
			update(
				DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME,
				{ error: { code: "E061008", text: "Wrong password" } },
				next,
			),
		).toBe(true);
	});
	expect(container.querySelector('input[type="password"]')).not.toBeNull();
	expect(container.textContent).not.toContain(
		"Authorization could not continue",
	);
	expect(container.querySelector('[role="alert"]')?.textContent).toContain(
		"Please try again",
	);
	expect(next).not.toHaveBeenCalled();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	window.sessionStorage.clear();
	act(() => root.unmount());
	container.remove();
	window.history.replaceState({}, "", "/");
});

describe("InboundConsentPage layout", () => {
	it("describes an all-read request as the requested permissions", async () => {
		window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
		await act(async () => renderConsentPage());
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		await act(async () => {
			onScreenUpdate(
				"Consent Screen - Verified App",
				{
					data: {
						inboundAppApproveScopes: [
							{ id: "mcp:work.read", desc: "Read work" },
							{ id: "mcp:skills.read", desc: "Read skills" },
						],
					},
				},
				vi.fn(),
			);
		});
		const allRequested = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "All requested",
		);
		expect(allRequested?.getAttribute("aria-pressed")).toBe("false");
		expect(container.textContent).not.toContain("Full access");
		expect(container.textContent).toContain("2 of 2 selected");
	});

	it.each([false, true])(
		"batches organization lookups and fails closed when a later batch fails (%s)",
		async (failLaterBatch) => {
			window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
			const tenants = Array.from({ length: 21 }, (_, index) => ({
				id: `org_fixture_${index}`,
				name: `Fixture organization ${index}`,
			}));
			apiMock.listMyWorkspaces.mockResolvedValueOnce({
				data: tenants.map(({ id, name }) => ({
					org: { descopeTenantId: id, name, provisionComplete: true },
					surfaces: [
						{
							surface: "mcp",
							provisioned: true,
							canonicalUrl: "https://fixture.mcp.tedix.dev/mcp",
						},
					],
				})),
				pagination: {
					limit: 100,
					offset: 0,
					total: tenants.length,
					hasMore: false,
				},
			});
			for (let batch = 0; batch < (failLaterBatch ? 2 : 3); batch++) {
				descopeMock.myTenants.mockImplementationOnce(async (ids: string[]) => {
					if (ids.length > 10 || (failLaterBatch && batch === 1)) {
						throw new Error("Provider lookup rejected");
					}
					return {
						ok: true,
						data: {
							tenants: tenants.filter((tenant) => ids.includes(tenant.id)),
						},
					};
				});
			}
			await act(async () => renderConsentPage());
			const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
				screenName: string,
				context: Record<string, unknown>,
				next: ReturnType<typeof vi.fn>,
			) => boolean;
			await act(async () => {
				onScreenUpdate(
					"Consent Screen - Verified App",
					{ data: { inboundAppApproveScopes: [{ id: "mcp:work.read" }] } },
					vi.fn(),
				);
			});
			expect(
				descopeMock.myTenants.mock.calls.map(([ids]) => ids.length),
			).toEqual(failLaterBatch ? [10, 10] : [10, 10, 1]);
			expect(container.textContent).not.toContain(
				"Your Tedix sign-in could not be prepared.",
			);
			const review = [...container.querySelectorAll("button")].find(
				(button) => button.textContent === "Choose organizations",
			);
			expect(review).toBeDefined();
			await act(async () => review?.click());
			if (failLaterBatch) {
				expect(container.textContent).toContain(
					"Could not load your organizations.",
				);
				expect(container.querySelector('button[type="submit"]')).toBeNull();
			}
			for (const tenant of tenants) {
				if (failLaterBatch)
					expect(container.textContent).not.toContain(tenant.name);
				else expect(container.textContent).toContain(tenant.name);
			}
			expect(apiMock.stageMultiOrgMcpConsent).not.toHaveBeenCalled();
		},
	);

	it("reviews read-only access to two explicitly selected organizations", async () => {
		window.history.replaceState(
			{},
			"",
			"/oauth/consent?mode=multi-org&third_party_app_id=TPAclient1&resource=https%3A%2F%2Fconnect.mcp.tedix.dev%2Fmcp",
		);
		descopeMock.myTenants.mockResolvedValueOnce({
			ok: true,
			data: {
				tenants: [
					{ id: "org_tedix", name: "Tedix" },
					{ id: "org_sample", name: "Sample" },
				],
			},
		});
		apiMock.listMyWorkspaces.mockResolvedValue({
			data: [
				{
					org: {
						organizationId: "tedix-id",
						slug: "tedix",
						name: "Tedix",
						descopeTenantId: "org_tedix",
						provisionComplete: true,
					},
					surfaces: [
						{
							surface: "mcp",
							provisioned: true,
							canonicalUrl: "https://tedix.mcp.tedix.dev/mcp",
							handoffUrl: null,
						},
					],
				},
				{
					org: {
						organizationId: "sample-id",
						slug: "sample",
						name: "Sample",
						descopeTenantId: "org_sample",
						provisionComplete: true,
					},
					surfaces: [
						{
							surface: "mcp",
							provisioned: true,
							canonicalUrl: "https://sample.mcp.tedix.dev/mcp",
							handoffUrl: null,
						},
					],
				},
			],
			pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
		});
		await act(async () => renderConsentPage());
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const next = vi.fn().mockResolvedValue({ ok: true });
		// Descope removes the provider query before it renders the consent screen.
		window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
		await act(async () => {
			onScreenUpdate(
				"Consent Screen - Verified App",
				{
					data: {
						inboundAppApproveScopes: [
							{ id: "mcp:apps.read", desc: "Read apps" },
							{ id: "mcp:apps.write", desc: "Write apps" },
							{ id: "openid", desc: "Identify you", required: true },
						],
					},
				},
				next,
			);
		});
		expect(container.textContent).toContain("Custom");
		expect(container.textContent).toContain("All requested");
		expect(container.textContent).not.toContain("Full access");
		const click = async (label: string) => {
			const button = [...container.querySelectorAll("button")].find(
				(candidate) => candidate.textContent === label,
			);
			expect(button).toBeDefined();
			await act(async () => button?.click());
		};
		await click("Read only");
		await click("Choose organizations");
		await act(async () => {
			await Promise.resolve();
		});
		expect(container.textContent).toContain(
			"Organizations you join later are not included.",
		);
		await click("Select all current");
		await click("Review access");
		expect(container.textContent).toContain("Tedix");
		expect(container.textContent).toContain("Sample");
		await click("Authorize");
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"/auth/session-broker/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
		expect(apiMock.listMyWorkspaces).toHaveBeenCalledWith({
			limit: 100,
			offset: 0,
		});
		expect(descopeMock.myTenants).toHaveBeenCalledWith([
			"org_tedix",
			"org_sample",
		]);
		expect(apiMock.stageMultiOrgMcpConsent).toHaveBeenCalledWith({
			clientId: "TPAclient1",
			resourceUrl: "https://connect.mcp.tedix.dev/mcp",
			selectedTenantIds: ["org_tedix", "org_sample"],
			approvedScopes: ["mcp:apps.read"],
		});
		expect(next).toHaveBeenCalledWith(INBOUND_CONSENT_AUTHORIZE_INTERACTION, {
			thirdPartyAppApproveScopes: ["mcp:apps.read", "openid"],
			"form.tedixSelectedOrganizations": '["org_tedix","org_sample"]',
			"form.tedixConsentRevision": consentRevision,
		});
	});

	it("preserves a previous multi-organization grant when reconnect is cancelled and the directory fails", async () => {
		window.sessionStorage.setItem(
			"tedix-inbound-consent-authorization:state-1",
			"https://auth.tedix.dev/authorize?client_id=client-1",
		);
		window.history.replaceState(
			{},
			"",
			"/oauth/consent?mode=multi-org&third_party_app_state_id=state-1",
		);
		apiMock.listMyWorkspaces.mockRejectedValue(
			new Error("Directory unavailable"),
		);
		await act(async () => renderConsentPage());
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const next = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			onScreenUpdate(
				"Consent Screen - Verified App",
				{ data: { inboundAppApproveScopes: [{ id: "mcp:apps.read" }] } },
				next,
			);
		});
		const cancel = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Cancel",
		);
		await act(async () => cancel?.click());
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"/auth/session-broker/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
		expect(apiMock.revokeMultiOrgMcpConsent).not.toHaveBeenCalled();
		expect(apiMock.stageMultiOrgMcpConsent).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledWith(INBOUND_CONSENT_CANCEL_INTERACTION, {
			thirdPartyAppApproveScopes: ["mcp:apps.read"],
			"form.tedixSelectedOrganizations": "[]",
		});
	});

	it.each(
		[
			{
				caseName: "a different broker account",
				brokerEmail: "other@example.test",
				consentEmail: "member@example.test" as string | null,
			},
			{
				caseName: "a missing broker email",
				brokerEmail: null,
				consentEmail: "member@example.test" as string | null,
			},
			{
				caseName: "a missing Descope email",
				brokerEmail: "member@example.test",
				consentEmail: null,
			},
		].flatMap((entry) =>
			["tenant-bound", "multi-org"].map((mode) => ({ ...entry, mode })),
		),
	)(
		"does not show consent for $caseName in $mode mode",
		async ({ brokerEmail, consentEmail, mode }) => {
			descopeMock.userEmail = consentEmail;
			globalThis.fetch = vi.fn(async () =>
				Response.json({
					authenticated: true,
					user: brokerEmail ? { email: brokerEmail } : {},
				}),
			);
			window.history.replaceState(
				{},
				"",
				mode === "multi-org"
					? "/oauth/consent?mode=multi-org"
					: "/oauth/consent?tenant=org_tedix",
			);
			await act(async () => renderConsentPage());
			const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
				screenName: string,
				context: Record<string, unknown>,
				next: ReturnType<typeof vi.fn>,
			) => boolean;
			await act(async () => {
				onScreenUpdate(
					"Consent Screen - Verified App",
					{ data: { inboundAppApproveScopes: [{ id: "mcp:apps.read" }] } },
					vi.fn(),
				);
			});
			expect(container.textContent).toContain(
				"Your Tedix sign-in could not be prepared.",
			);
			expect(window.location.pathname).toBe("/oauth/consent");
			expect(apiMock.listMyWorkspaces).not.toHaveBeenCalled();
			expect(apiMock.stageMultiOrgMcpConsent).not.toHaveBeenCalled();
			expect(apiMock.revokeMultiOrgMcpConsent).not.toHaveBeenCalled();
		},
	);

	it("starts the broker once and preserves the OAuth state after Descope removes it from the visible URL", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ authenticated: false }),
		);
		window.sessionStorage.setItem(
			"tedix-inbound-consent-authorization:state-1",
			"https://auth.tedix.dev/authorize?client_id=client-1",
		);
		window.history.replaceState(
			{},
			"",
			"/oauth/consent?mode=multi-org&third_party_app_state_id=state-1",
		);
		await act(async () => renderConsentPage());
		window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		await act(async () => {
			onScreenUpdate(
				"Consent Screen - Verified App",
				{ data: { inboundAppApproveScopes: [{ id: "mcp:apps.read" }] } },
				vi.fn(),
			);
		});
		expect(
			window.sessionStorage.getItem(
				"tedix-inbound-consent-broker-attempted:state-1",
			),
		).toBe("1");
		expect(window.location.pathname).toBe("/auth/session-broker/start");
		expect(new URLSearchParams(window.location.search).get("redirect_to")).toBe(
			"/oauth/consent?mode=multi-org&third_party_app_state_id=state-1",
		);
		expect(
			window.sessionStorage.getItem(
				"tedix-inbound-consent-authorization:state-1",
			),
		).toBe("https://auth.tedix.dev/authorize?client_id=client-1");
		expect(apiMock.listMyWorkspaces).not.toHaveBeenCalled();
		expect(apiMock.stageMultiOrgMcpConsent).not.toHaveBeenCalled();
		expect(apiMock.revokeMultiOrgMcpConsent).not.toHaveBeenCalled();
	});

	it("does not repeat a failed broker bounce for the same OAuth state", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ authenticated: false }),
		);
		window.sessionStorage.setItem(
			"tedix-inbound-consent-broker-attempted:state-1",
			"1",
		);
		window.history.replaceState(
			{},
			"",
			"/oauth/consent?mode=multi-org&third_party_app_state_id=state-1",
		);
		await act(async () => renderConsentPage());
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		await act(async () => {
			onScreenUpdate(
				"Consent Screen - Verified App",
				{ data: { inboundAppApproveScopes: [{ id: "mcp:apps.read" }] } },
				vi.fn(),
			);
		});
		expect(window.location.pathname).toBe("/oauth/consent");
		expect(container.textContent).toContain(
			"Your Tedix sign-in could not be prepared.",
		);
		expect(apiMock.listMyWorkspaces).not.toHaveBeenCalled();
	});

	it("removes spent callback parameters but keeps the consent state in the broker return path", () => {
		expect(
			inboundConsentBrokerReturnPath(
				"https://os.tedix.dev/oauth/consent?mode=multi-org&third_party_app_state_id=state-1&code=spent&descope-login-flow=flow&t=secret",
			),
		).toBe("/oauth/consent?mode=multi-org&third_party_app_state_id=state-1");
	});

	it("uses the dedicated Descope flow for multi-organization consent", async () => {
		window.history.replaceState({}, "", "/oauth/consent?mode=multi-org");
		await act(async () => renderConsentPage());
		expect(descopeMock.flowProps?.flowId).toBe(
			"inbound-apps-multi-org-consent",
		);
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const next = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			onScreenUpdate("Welcome Screen", {}, next);
		});
		const microsoftButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Continue with Microsoft",
		);
		expect(microsoftButton).toBeDefined();
		expect(container.textContent).not.toContain("Continue with Apple");
		await act(async () => microsoftButton?.click());
		expect(next).toHaveBeenCalledWith("0L1nCJrTJX", {
			provider: "microsoft",
		});
	});

	it("keeps Descope reauthentication inside the shared centered identity panel", async () => {
		act(() => renderConsentPage());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		const panel = container.querySelector(".product-login-panel");
		expect(panel).not.toBeNull();
		expect(panel?.querySelector("[data-descope-flow]")).not.toBeNull();
		expect(panel?.textContent).toContain("Authorize access");
	});

	it("replaces Descope's nested welcome card with shared Tedix login controls", async () => {
		act(() => renderConsentPage());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;

		await act(async () => {
			expect(onScreenUpdate("Welcome Screen", {}, vi.fn())).toBe(true);
		});

		const panels = container.querySelectorAll(".product-login-panel");
		const panel = panels.item(panels.length - 1);
		expect(panel.querySelector("#tedix-identity-email")).not.toBeNull();
		expect(panel.textContent).toContain("Continue with Google");
		expect(panel.textContent).not.toContain("Continue with a passkey");
		expect(panel.querySelector("[data-descope-flow]")).toBeNull();
	});

	it("uses the inbound flow interaction contract and owns OTP verification", async () => {
		act(() => renderConsentPage());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		const onScreenUpdate = descopeMock.flowProps?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const loginNext = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			onScreenUpdate("Welcome Screen", {}, loginNext);
		});
		const googleButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Continue with Google"),
		);
		await act(async () => googleButton?.click());
		expect(loginNext).toHaveBeenCalledWith(
			DESCOPE_LOGIN_INTERACTIONS["inbound-apps-multi-org-consent"].google,
			{ provider: "google" },
		);

		const otpNext = vi.fn().mockResolvedValue({ ok: true });
		await act(async () => {
			expect(onScreenUpdate("Verify OTP", {}, otpNext)).toBe(true);
		});
		expect(container.querySelector("#tedix-identity-otp")).not.toBeNull();
		const resendButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Resend code"),
		);
		await act(async () => resendButton?.click());
		expect(otpNext).toHaveBeenCalledWith(
			INBOUND_CONSENT_OTP_INTERACTIONS.resend,
			{},
		);
	});
});

it("narrows a tenant-bound authorization to the selected scopes and hinted organization", async () => {
	window.history.replaceState(
		{},
		"",
		"/oauth/consent?tenant=org_tedix&third_party_app_id=TPAclient1&oidc_resource=https%3A%2F%2Ftedix-unified.mcp.tedix.dev%2Fmcp",
	);
	act(() => renderConsentPage());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	const update = descopeMock.flowProps?.onScreenUpdate as (
		name: string,
		context: Record<string, unknown>,
		next: ReturnType<typeof vi.fn>,
	) => boolean;
	const next = vi.fn().mockResolvedValue({ ok: true });
	await act(async () => {
		update(
			"Consent Screen - Verified App",
			{
				data: {
					inboundAppApproveScopes: [
						{
							id: "mcp:apps.admin",
							desc: "Administer apps",
						},
						{ id: "mcp:apps.read", desc: "Read apps" },
						{ id: "openid", desc: "Identify you", required: true },
					],
				},
				form: {
					thirdPartyAppApproveScopes: [
						"mcp:apps.admin",
						"mcp:apps.read",
						"openid",
					],
				},
			},
			next,
		);
	});
	const controls = [
		...container.querySelectorAll<HTMLElement>('[role="checkbox"]'),
	];
	// The SDK removes provider query values before the user presses Authorize.
	window.history.replaceState({}, "", "/oauth/consent?tenant=org_tedix");
	expect(controls).toHaveLength(3);
	expect(container.textContent).toContain("All requested");
	expect(container.textContent).toContain("2 of 3 selected");
	expect(container.textContent).toContain("Signed in as member@example.test");
	await clickButton("Choose organizations");
	expect(
		container.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
	).toBe("true");
	await clickButton("Review access");
	const authorize = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Authorize",
	);
	expect(authorize).toBeDefined();
	await act(async () => authorize?.click());
	expect(next).toHaveBeenCalledWith(INBOUND_CONSENT_AUTHORIZE_INTERACTION, {
		thirdPartyAppApproveScopes: ["mcp:apps.read", "openid"],
		"form.tedixSelectedOrganizations": JSON.stringify(["org_tedix"]),
		"form.tedixConsentRevision": consentRevision,
	});
});

it("keeps an accepted interaction disabled while waiting for completion", async () => {
	await act(async () => renderConsentPage());
	const update = descopeMock.flowProps?.onScreenUpdate as (
		name: string,
		context: Record<string, unknown>,
		next: ReturnType<typeof vi.fn>,
	) => boolean;
	const next = vi.fn().mockResolvedValue({ ok: true });
	await act(async () => {
		update(
			"Consent Screen - Verified App",
			{
				data: {
					inboundAppApproveScopes: [{ id: "mcp:apps.read", desc: "Read apps" }],
				},
			},
			next,
		);
	});
	await clickButton("Choose organizations");
	await clickButton("Review access");
	const authorize = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Authorize",
	)!;
	vi.useFakeTimers();
	try {
		await act(async () => authorize.click());
		expect(authorize.disabled).toBe(true);
		await act(async () => authorize.click());
		expect(next).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain("CLI");
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"application that requested access",
		);
		await act(async () => vi.advanceTimersByTime(15_000));
		expect(container.querySelector('[role="status"]')?.textContent).toContain(
			"consent may already have been recorded",
		);
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	{ errorCode: "E064006", errorDescription: "JWT family ID invalidated" },
	{ errorCode: "E061301", errorDescription: "Failed to exchange OAuth code" },
	{ errorCode: "unknown", errorDescription: "Completion failed" },
])(
	"does not claim consent was unrecorded after a flow error: $errorCode",
	async (error) => {
		await act(async () => renderConsentPage());
		const update = descopeMock.flowProps?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		await act(async () => {
			update(
				"Consent Screen - Verified App",
				{
					data: {
						inboundAppApproveScopes: [
							{ id: "mcp:apps.read", desc: "Read apps" },
						],
					},
				},
				vi.fn().mockResolvedValue({ ok: false, error }),
			);
		});
		await clickButton("Choose organizations");
		await clickButton("Review access");
		const authorize = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Authorize",
		)!;
		await act(async () => authorize.click());
		expect(container.textContent).not.toContain("No access was granted");
		expect(container.textContent).not.toContain("before access was granted");
		expect(container.textContent).toMatch(
			/consent may already have been recorded|Return to the application/i,
		);
	},
);

it.each(["tenant-bound", "multi-org"])(
	"requires canonical broker cookie before showing %s consent and preserves exact request across bounce",
	async (mode) => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ authenticated: false }, { status: 401 }),
		);
		const query = mode === "multi-org" ? "mode=multi-org" : "tenant=org_tedix";
		const resource = "https://tedix-unified.mcp.tedix.dev/mcp";
		window.history.replaceState(
			{},
			"",
			`/oauth/consent?${query}&third_party_app_state_id=state-cookie&third_party_app_id=TPAclient1&oidc_resource=${encodeURIComponent(resource)}`,
		);
		await act(async () => renderConsentPage());
		window.history.replaceState({}, "", `/oauth/consent?${query}`);
		const update = descopeMock.flowProps?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const next = vi.fn();
		await act(async () => {
			update(
				"Consent Screen - Verified App",
				{ data: { inboundAppApproveScopes: [{ id: "mcp:work.read" }] } },
				next,
			);
		});
		expect(window.location.pathname).toBe("/auth/session-broker/start");
		const destination = new URL(
			new URLSearchParams(window.location.search).get("redirect_to")!,
			window.location.origin,
		);
		expect(destination.searchParams.get("third_party_app_state_id")).toBe(
			"state-cookie",
		);
		expect(destination.searchParams.get("third_party_app_id")).toBe(
			"TPAclient1",
		);
		expect(destination.searchParams.get("oidc_resource")).toBe(resource);
		expect(
			destination.searchParams.get(mode === "multi-org" ? "mode" : "tenant"),
		).toBe(mode === "multi-org" ? "multi-org" : "org_tedix");
		expect(container.textContent).not.toContain("Choose permissions");
		expect(apiMock.stageMultiOrgMcpConsent).not.toHaveBeenCalled();
		expect(next).not.toHaveBeenCalled();
	},
);
it.each(["tenant-bound", "multi-org"])(
	"reports an expired canonical session in %s mode without advancing provider consent",
	async (mode) => {
		if (mode === "multi-org") {
			window.history.replaceState(
				{},
				"",
				"/oauth/consent?mode=multi-org&third_party_app_id=TPAclient1&resource=https%3A%2F%2Fconnect.mcp.tedix.dev%2Fmcp",
			);
		}
		apiMock.stageMultiOrgMcpConsent.mockRejectedValue({
			code: "UNAUTHORIZED",
			status: 401,
		});
		await act(async () => renderConsentPage());
		const update = descopeMock.flowProps?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
		) => boolean;
		const next = vi.fn();
		await act(async () => {
			update(
				"Consent Screen - Verified App",
				{ data: { inboundAppApproveScopes: [{ id: "mcp:work.read" }] } },
				next,
			);
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"/auth/session-broker/status",
			expect.objectContaining({ credentials: "same-origin" }),
		);
		await clickButton("Choose organizations");
		// The tenant-bound request starts with its organization selected.
		if (mode === "multi-org") await clickButton("Select all current");
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((b) => b.textContent === "Review access")
				?.click();
		});
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((b) => b.textContent === "Authorize")
				?.click();
		});
		expect(container.textContent).toContain("Your Tedix session expired.");
		expect(next).not.toHaveBeenCalled();
	},
);
