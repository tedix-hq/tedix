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

const descope = vi.hoisted(() => {
	const verify = vi.fn();
	const selectTenant = vi.fn();
	return {
		authProviderProps: null as Record<string, unknown> | null,
		verify,
		selectTenant,
		// The real useDescope() memoizes one sdk instance per provider
		// (useMemo(() => sdk, [sdk])). The mock must honor that identity
		// contract: returning a fresh object per render re-triggers the page's
		// useEffect([descope]) which, on the tokenless recovery path, calls
		// setRecoveryTarget with a new object each pass — an infinite
		// render/effect loop that act() flushes forever and hangs the worker.
		sdk: { magicLink: { verify }, selectTenant },
	};
});

const api = vi.hoisted(() => ({
	prepareFirstOsOrganization: vi.fn(),
	acceptInvitation: vi.fn(),
	getAuthenticatedOsApi: vi.fn(),
}));

const recovery = vi.hoisted(() => ({
	props: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/api", () => api);

vi.mock("./descope-sign-up-or-in-flow", () => ({
	TedixSignUpOrInFlow: (props: Record<string, unknown>) => {
		recovery.props = props;
		return <div data-testid="invitation-recovery-flow" />;
	},
}));

vi.mock("@descope/react-sdk/flows", () => ({
	AuthProvider: (props: Record<string, unknown>) => {
		descope.authProviderProps = props;
		return props.children as React.ReactNode;
	},
	useDescope: () => descope.sdk,
}));

import { InvitationAcceptancePage } from "./invitation-acceptance-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	descope.authProviderProps = null;
	descope.verify.mockReset();
	descope.selectTenant.mockReset();
	api.prepareFirstOsOrganization.mockReset();
	api.acceptInvitation.mockReset();
	api.getAuthenticatedOsApi.mockReset();
	recovery.props = null;
	api.getAuthenticatedOsApi.mockReturnValue({
		members: { acceptInvitation: api.acceptInvitation },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	window.history.replaceState(
		{},
		"",
		"/invite?t=invitation-token&member_id=member-id&tenant_id=tenant-id",
	);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.history.replaceState({}, "", "/");
});

describe("InvitationAcceptancePage", () => {
	it("persists the invitation identity before tenant setup and the product-session broker", async () => {
		descope.verify.mockResolvedValue({
			ok: true,
			data: {
				sessionJwt: "invitation-session-jwt",
				user: { userId: "descope-user-id" },
			},
		});
		descope.selectTenant.mockResolvedValue({
			ok: true,
			data: { sessionJwt: "tenant-session-jwt" },
		});
		api.acceptInvitation.mockResolvedValue({});
		api.prepareFirstOsOrganization.mockResolvedValue({});

		await act(async () => {
			root.render(<InvitationAcceptancePage />);
		});

		expect(api.prepareFirstOsOrganization).toHaveBeenCalledWith(
			"tenant-session-jwt",
		);
		expect(descope.selectTenant).toHaveBeenCalledWith("tenant-id");
		expect(api.getAuthenticatedOsApi).toHaveBeenCalledWith(
			"invitation-session-jwt",
		);
		expect(api.acceptInvitation).toHaveBeenCalledWith({
			memberId: "member-id",
			descopeUserId: "descope-user-id",
		});
		expect(api.acceptInvitation.mock.invocationCallOrder[0]!).toBeLessThan(
			descope.selectTenant.mock.invocationCallOrder[0]!,
		);
		expect(window.location.pathname).toBe("/auth/session-broker/start");
		expect(window.location.search).toBe(
			"?redirect_to=%2Faccount%2Forganizations",
		);
	});

	it("offers a fresh sign-in recovery when the one-time invitation token is invalid", async () => {
		descope.verify.mockResolvedValue({ ok: false });

		await act(async () => {
			root.render(<InvitationAcceptancePage />);
		});

		expect(descope.verify).toHaveBeenCalledWith("invitation-token");
		expect(descope.authProviderProps).toMatchObject({
			autoRefresh: false,
			persistTokens: false,
		});
		expect(descope.authProviderProps).not.toHaveProperty(
			"refreshTokenViaCookie",
		);
		expect(descope.authProviderProps).not.toHaveProperty(
			"sessionTokenViaCookie",
		);
		expect(container.textContent).toContain(
			"This invitation link has already been used or expired",
		);
		// Assert against the live origin (the happy-dom default URL is a harness
		// detail); the invariant is a same-origin /invite recovery URL carrying
		// exactly the member/tenant params and no one-time token.
		expect(recovery.props).toMatchObject({
			redirectUrl: `${window.location.origin}/invite?member_id=member-id&tenant_id=tenant-id`,
		});
	});

	it("offers recovery when an administrator opens a tokenless recovery URL", async () => {
		window.history.replaceState(
			{},
			"",
			"/invite?member_id=member-id&tenant_id=tenant-id",
		);

		await act(async () => {
			root.render(<InvitationAcceptancePage />);
		});

		expect(descope.verify).not.toHaveBeenCalled();
		expect(recovery.props).not.toBeNull();
	});

	it("does not call Descope for a malformed link", async () => {
		window.history.replaceState({}, "", "/invite");

		await act(async () => {
			root.render(<InvitationAcceptancePage />);
		});

		expect(descope.verify).not.toHaveBeenCalled();
		expect(container.textContent).toContain("link is incomplete");
	});
});
