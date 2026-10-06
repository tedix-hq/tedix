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
import { OS_SILENT_RESUME_GUARD_KEY } from "@/shared/session-status";

vi.mock("@descope/react-sdk/flows", () => ({
	AuthProvider: (props: { children?: React.ReactNode }) => props.children,
	SignUpOrInFlow: () => <div data-descope-flow />,
}));

// The capability lifecycle owns module-level realtime singletons; this suite
// exercises only the broker boundary, so keep the lifecycle inert.
vi.mock("@/lib/capability-lifecycle", () => ({
	disposeOsCapabilities: () => {},
	installOsCapabilityPageLifecycle: () => () => {},
	installOsRealtimeWakeProbes: () => () => {},
}));

// happy-dom hosts resolve "local", which mounts no broker boundary at all.
// Silent resume only exists on deployed hosts, so pin a tenant host here.
vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "tedix" }),
}));

import { SessionBoundary } from "./session-boundary";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let replaceSpy: ReturnType<typeof vi.spyOn>;

function stubBrokerStatus(body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(() =>
			Promise.resolve(
				new Response(JSON.stringify(body), {
					headers: { "Content-Type": "application/json" },
				}),
			),
		),
	);
}

async function renderBoundary() {
	await act(async () => {
		root.render(
			<SessionBoundary renderLogin={() => <div data-descope-flow />}>
				<div data-authenticated-child />
			</SessionBoundary>,
		);
	});
	// One more turn so the status effect commits and the resume effect runs.
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	window.sessionStorage.clear();
	window.history.replaceState({}, "", "/workspace/workspace-1?tab=docs");
	replaceSpy = vi
		.spyOn(window.location, "replace")
		.mockImplementation(() => {});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	replaceSpy.mockRestore();
	vi.unstubAllGlobals();
	window.sessionStorage.clear();
	window.history.replaceState({}, "", "/");
});

describe("SessionBoundary silent session resume", () => {
	it("attempts one silent broker pass instead of rendering the login form", async () => {
		stubBrokerStatus({ authenticated: false });
		await renderBoundary();

		// The user never sees a form: the restoring state fronts the navigation.
		expect(container.textContent).toContain("Restoring your Tedix session…");
		expect(container.querySelector("[data-descope-flow]")).toBeNull();

		expect(replaceSpy).toHaveBeenCalledTimes(1);
		const target = new URL(
			String(replaceSpy.mock.calls[0]?.[0]),
			window.location.origin,
		);
		expect(target.pathname).toBe("/auth/session-broker/start");
		expect(target.searchParams.get("redirect_to")).toBe(
			"/workspace/workspace-1?tab=docs",
		);
		// The guard is committed BEFORE navigating, so a broker that bounces us
		// straight back cannot earn a second unattended attempt.
		expect(window.sessionStorage.getItem(OS_SILENT_RESUME_GUARD_KEY)).not.toBe(
			null,
		);
	});

	it("renders the login form when the tab already spent its silent attempt", async () => {
		window.sessionStorage.setItem(OS_SILENT_RESUME_GUARD_KEY, "1");
		stubBrokerStatus({ authenticated: false });
		await renderBoundary();

		expect(replaceSpy).not.toHaveBeenCalled();
		expect(container.querySelector("[data-descope-flow]")).not.toBeNull();
	});

	it("renders the login form after returning from the broker with ?error", async () => {
		window.history.replaceState(
			{},
			"",
			"/workspace/workspace-1?error=session_unavailable",
		);
		stubBrokerStatus({ authenticated: false });
		await renderBoundary();

		expect(replaceSpy).not.toHaveBeenCalled();
		expect(container.querySelector("[data-descope-flow]")).not.toBeNull();
	});

	it("re-arms the guard and renders children on an authenticated status", async () => {
		window.sessionStorage.setItem(OS_SILENT_RESUME_GUARD_KEY, "1");
		stubBrokerStatus({
			authenticated: true,
			expiresAt: Math.floor(Date.now() / 1000) + 3600,
			user: { name: "Ada", email: "ada@tedix.dev" },
		});
		await renderBoundary();

		expect(replaceSpy).not.toHaveBeenCalled();
		expect(container.querySelector("[data-authenticated-child]")).not.toBe(
			null,
		);
		expect(window.sessionStorage.getItem(OS_SILENT_RESUME_GUARD_KEY)).toBe(
			null,
		);
	});

	it("leaves the renewal shape to the existing resume path, not the guard", async () => {
		// The 401 renewal body resumes through shouldResumeOsBroker and must not
		// consume the tab's single silent attempt.
		stubBrokerStatus({ authenticated: false, renewalRequired: true });
		await renderBoundary();

		expect(container.textContent).toContain("Restoring your Tedix session…");
		expect(window.sessionStorage.getItem(OS_SILENT_RESUME_GUARD_KEY)).toBe(
			null,
		);
	});
});
