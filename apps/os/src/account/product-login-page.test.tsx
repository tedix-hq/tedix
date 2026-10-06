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

const descope = vi.hoisted(() => ({
	authProviderProps: null as Record<string, unknown> | null,
	flowProps: null as Record<string, unknown> | null,
}));
const api = vi.hoisted(() => ({
	prepareFirstOsOrganization: vi.fn(),
}));

vi.mock("@/lib/api", () => api);

vi.mock("@descope/react-sdk/flows", () => ({
	AuthProvider: (props: Record<string, unknown>) => {
		descope.authProviderProps = props;
		return props.children as React.ReactNode;
	},
	SignUpOrInFlow: (props: Record<string, unknown>) => {
		descope.flowProps = props;
		return <div data-descope-flow />;
	},
}));

import { ProductLoginPage } from "./product-login-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	descope.authProviderProps = null;
	descope.flowProps = null;
	api.prepareFirstOsOrganization.mockReset();
	// resolveProductLoginIntent reads window.location.href; a valid intent is
	// required or ProductLoginPage renders the invalid-request page with no
	// AuthProvider to inspect.
	window.history.replaceState(
		{},
		"",
		"/login?intent=request_1234567890abcdefghij",
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.history.replaceState({}, "", "/");
});

describe("ProductLoginPage central-login provider", () => {
	it("emits credentials once without making the SDK a second session owner", () => {
		act(() => {
			root.render(<ProductLoginPage />);
		});

		const props = descope.authProviderProps;
		expect(props).not.toBeNull();
		expect(props).toMatchObject({
			autoRefresh: false,
			persistTokens: false,
		});
		expect(props).not.toHaveProperty("refreshTokenViaCookie");
		expect(props).not.toHaveProperty("sessionTokenViaCookie");
	});
});

describe("ProductLoginPage no-flash rendering", () => {
	it("hides the panel behind a branded loading state until the flow is ready", () => {
		act(() => {
			root.render(<ProductLoginPage />);
		});

		// The flow must stay MOUNTED (hidden, not unmounted) or onReady can
		// never fire — assert both halves of that contract.
		expect(container.querySelector("[data-descope-flow]")).not.toBeNull();
		const panel = container.querySelector("main.product-login-page");
		expect(panel?.getAttribute("aria-hidden")).toBe("true");
		const loading = container.querySelector("main.centered-state");
		expect(loading?.textContent).toContain("Preparing your Tedix sign-in…");

		const onReady = descope.flowProps?.onReady as (event: unknown) => void;
		expect(onReady).toBeDefined();
		act(() => {
			onReady({ currentTarget: null });
		});

		expect(container.querySelector("main.centered-state")).toBeNull();
		const readyPanel = container.querySelector("main.product-login-page");
		expect(readyPanel?.getAttribute("aria-hidden")).toBeNull();
		expect(
			readyPanel?.querySelector('.brand-lockup[aria-label="Tedix"]'),
		).not.toBeNull();
		expect(readyPanel?.querySelector("h1")?.textContent).toBe("Sign in");
		expect(readyPanel?.textContent).not.toContain("Sign in to Tedix");
	});

	it("titles the document for the sign-in screen", () => {
		act(() => {
			root.render(<ProductLoginPage />);
		});
		expect(document.title).toBe("Sign in · Tedix OS");
	});

	it("replaces the completed form with neutral continuation copy", async () => {
		api.prepareFirstOsOrganization.mockImplementation(
			() => new Promise(() => undefined),
		);
		await act(async () => {
			root.render(<ProductLoginPage />);
		});
		const onReady = descope.flowProps?.onReady as (event: unknown) => void;
		await act(async () => onReady({ currentTarget: null }));

		const onSuccess = descope.flowProps?.onSuccess as (event: {
			detail: { sessionJwt: string };
		}) => void;
		await act(async () =>
			onSuccess({ detail: { sessionJwt: "authenticated-session" } }),
		);

		const loading = container.querySelector("main.centered-state");
		expect(loading?.textContent).toContain("Finishing your Tedix sign-in…");
		expect(
			container
				.querySelector("main.product-login-page")
				?.getAttribute("aria-hidden"),
		).toBe("true");
		expect(container.textContent).not.toContain("first Tedix workspace");
	});
});
