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

import { BrokerLoginPage } from "./account-login";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	descope.authProviderProps = null;
	descope.flowProps = null;
	api.prepareFirstOsOrganization.mockReset();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("BrokerLoginPage broker-only provider", () => {
	it("leaves credential persistence and rotation exclusively to the broker", () => {
		act(() => {
			root.render(<BrokerLoginPage brokerPrefix="/auth/session-broker" />);
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

describe("BrokerLoginPage no-flash rendering", () => {
	it("hides the panel behind a branded loading state until the flow is ready", () => {
		act(() => {
			root.render(<BrokerLoginPage brokerPrefix="/auth/session-broker" />);
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
	});

	it("titles the document for the sign-in screen", () => {
		act(() => {
			root.render(<BrokerLoginPage brokerPrefix="/auth/session-broker" />);
		});
		expect(document.title).toBe("Sign in · Tedix OS");
	});

	it("replaces the completed form with neutral continuation copy", async () => {
		api.prepareFirstOsOrganization.mockImplementation(
			() => new Promise(() => undefined),
		);
		await act(async () => {
			root.render(<BrokerLoginPage brokerPrefix="/auth/session-broker" />);
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
