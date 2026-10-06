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
const host = vi.hoisted(() => ({ kind: "tenant" }));
const otpScreen = vi.hoisted(() => ({
	props: null as Record<string, unknown> | null,
}));

// The BYOS OTP screen has its own suite; here we assert only that the step-up
// dialog intercepts the Verify OTP screen and mounts it with the step-up
// interaction contract.
vi.mock("@/shared/descope-byos-otp-screen", () => ({
	TedixByosOtpScreen: (props: Record<string, unknown>) => {
		otpScreen.props = props;
		return <div data-testid="byos-otp" />;
	},
}));

vi.mock("@descope/react-sdk/flows", () => ({
	AuthProvider: (props: Record<string, unknown>) => {
		descope.authProviderProps = props;
		return props.children as React.ReactNode;
	},
	Descope: (props: Record<string, unknown>) => {
		descope.flowProps = props;
		return <div data-descope-flow />;
	},
}));

// The provider guard resolves the lane from the hostname; drive it directly.
vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: host.kind }),
}));

// The Kumo dialog adapter stays byte-identical across apps and portals its
// content; substitute a structural stand-in so the hook logic is what's under
// test.
vi.mock("@/components/kumo/dialog", () => ({
	Dialog: ({
		open,
		children,
	}: {
		open: boolean;
		children?: React.ReactNode;
	}) => (open ? <div data-testid="step-up-dialog">{children}</div> : null),
	DialogContent: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogHeader: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogTitle: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
	DialogDescription: ({ children }: { children?: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import {
	resetStepUpOrphanReportForTest,
	type StepUpCallback,
	useStepUpAuth,
	useStepUpResume,
} from "./step-up-auth";
import {
	captureDescopeContinuation,
	resetStepUpContinuationForTest,
	STEP_UP_INTENT_STORAGE_KEY,
	STEP_UP_RESUME_INCOMPLETE_MESSAGE,
	STEP_UP_RESUME_LOST_MESSAGE,
	writeStepUpIntent,
} from "./step-up-continuation";
import {
	DESCOPE_OTP_SCREEN_NAME,
	STEP_UP_OTP_INTERACTIONS,
} from "@/shared/descope-byos-contract";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
	onToken,
	onFailure,
	tenantId,
}: {
	onToken: StepUpCallback;
	onFailure: (message: string) => void;
	tenantId?: string;
}) {
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		onFailure,
		tenantId,
	});
	observedDialogTypes.push(StepUpDialog);
	return (
		<>
			<button
				type="button"
				data-testid="guarded"
				onClick={() => requireStepUp(onToken)}
			/>
			<StepUpDialog />
		</>
	);
}

let container: HTMLDivElement;
let root: Root;
let observedDialogTypes: React.FC[];

beforeEach(() => {
	descope.authProviderProps = null;
	descope.flowProps = null;
	otpScreen.props = null;
	host.kind = "tenant";
	resetStepUpContinuationForTest();
	resetStepUpOrphanReportForTest();
	window.sessionStorage.clear();
	window.history.replaceState({}, "", "/admin/api-keys");
	observedDialogTypes = [];
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function clickGuarded() {
	act(() => {
		container
			.querySelector<HTMLButtonElement>('[data-testid="guarded"]')
			?.click();
	});
}

describe("useStepUpAuth", () => {
	it("fails closed on the zero-account local lane without mounting Descope", () => {
		host.kind = "local";
		const onToken = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<Harness onToken={onToken} onFailure={onFailure} />);
		});

		clickGuarded();

		expect(onToken).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-testid="step-up-dialog"]')).toBe(
			null,
		);
		expect(descope.authProviderProps).toBeNull();
		expect(descope.flowProps).toBeNull();
	});

	it("mounts the flow inside a broker-safe scoped provider", () => {
		act(() => {
			root.render(<Harness onToken={vi.fn()} onFailure={vi.fn()} />);
		});

		clickGuarded();

		expect(
			container.querySelector('[data-testid="step-up-dialog"]'),
		).not.toBeNull();
		const props = descope.authProviderProps;
		expect(props).not.toBeNull();
		// The OS session broker is the single credential/refresh owner: the
		// scoped mount persists nothing and rotates nothing (a second rotator
		// would trip refresh-family replay E064006). Cookie-via props are dead
		// config under persistTokens=false and must stay absent.
		expect(props).not.toHaveProperty("refreshTokenViaCookie");
		expect(props).not.toHaveProperty("sessionTokenViaCookie");
		expect(props).toMatchObject({
			autoRefresh: false,
			persistTokens: false,
		});
		expect(descope.flowProps).toMatchObject({ flowId: "step-up" });
	});

	it("binds the challenge to the resource organization's Descope tenant", () => {
		act(() => {
			root.render(
				<Harness onToken={vi.fn()} onFailure={vi.fn()} tenantId="org_acme" />,
			);
		});

		clickGuarded();

		expect(descope.flowProps).toMatchObject({
			flowId: "step-up",
			tenant: "org_acme",
		});
	});

	it("hands the stepped-up token to the guarded callback only on success", () => {
		const onToken = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<Harness onToken={onToken} onFailure={onFailure} />);
		});

		clickGuarded();
		const onSuccess = descope.flowProps?.onSuccess as (event: {
			detail: { sessionJwt?: string };
		}) => void;
		act(() => {
			onSuccess({ detail: { sessionJwt: "su-jwt" } });
		});

		expect(onToken).toHaveBeenCalledWith("su-jwt");
		expect(onFailure).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="step-up-dialog"]')).toBe(
			null,
		);
	});

	it("fails closed when the flow returns no session token", () => {
		const onToken = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<Harness onToken={onToken} onFailure={onFailure} />);
		});

		clickGuarded();
		const onSuccess = descope.flowProps?.onSuccess as (event: {
			detail: { sessionJwt?: string };
		}) => void;
		act(() => {
			onSuccess({ detail: {} });
		});

		expect(onToken).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledTimes(1);
	});
	it("intercepts the Verify OTP screen and mounts the OS code input", () => {
		act(() => {
			root.render(<Harness onToken={vi.fn()} onFailure={vi.fn()} />);
		});
		clickGuarded();

		const onScreenUpdate = descope.flowProps?.onScreenUpdate as (
			screen: string,
			context: Record<string, unknown>,
			next: (id: string, form?: Record<string, unknown>) => Promise<unknown>,
		) => boolean;
		const next = vi.fn().mockResolvedValue({ ok: true });

		let handled: boolean | undefined;
		act(() => {
			handled = onScreenUpdate(DESCOPE_OTP_SCREEN_NAME, {}, next);
		});

		// Descope must be told the screen is handled, and our OTP screen mounts
		// with the step-up interaction ids (no back transition on that flow).
		expect(handled).toBe(true);
		expect(container.querySelector('[data-testid="byos-otp"]')).not.toBeNull();
		expect(otpScreen.props).toMatchObject({
			interactions: STEP_UP_OTP_INTERACTIONS,
			next,
		});
		// Screen transitions update the dialog contents without replacing its
		// React component type. Replacing it unmounts Base UI's active dialog and
		// closes the challenge before the OTP input can become visible.
		expect(new Set(observedDialogTypes).size).toBe(1);
	});

	it("leaves every other step-up screen to Descope", () => {
		act(() => {
			root.render(<Harness onToken={vi.fn()} onFailure={vi.fn()} />);
		});
		clickGuarded();

		const onScreenUpdate = descope.flowProps?.onScreenUpdate as (
			screen: string,
			context: Record<string, unknown>,
			next: (id: string, form?: Record<string, unknown>) => Promise<unknown>,
		) => boolean;

		let handled: boolean | undefined;
		act(() => {
			handled = onScreenUpdate("Step Up", {}, vi.fn());
		});

		expect(handled).toBe(false);
		expect(container.querySelector('[data-testid="byos-otp"]')).toBe(null);
	});
});

// ---------------------------------------------------------------------------
// The redirect round trip
// ---------------------------------------------------------------------------

/** The URL shape observed in production when step-up returns from a redirect. */
const RETURN_URL =
	"https://acme.os.tedix.dev/admin/api-keys?code=bcff601d&descope-login-flow=step-up%7C%23%7C3IRCjtEodoh1Hvpl8dxBv15VKf7_11.end";

const INTENT_KEY = "admin-api-keys:create";

function IntentHarness({
	onToken,
	onFailure,
}: {
	onToken: StepUpCallback;
	onFailure: (message: string) => void;
}) {
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		intentKey: INTENT_KEY,
		onFailure,
	});
	return (
		<>
			<button
				type="button"
				data-testid="guarded"
				onClick={() => requireStepUp(onToken, { name: "CI" })}
			/>
			<StepUpDialog />
		</>
	);
}

function ResumeHarness({
	onResume,
	onFailure,
}: {
	onResume: StepUpCallback;
	onFailure: (message: string) => void;
}) {
	const { StepUpDialog } = useStepUpAuth({
		intentKey: INTENT_KEY,
		autoResume: true,
		onResume,
		onFailure,
	});
	return <StepUpDialog />;
}

const resumeSeen = { intent: null as unknown, failure: null as string | null };

function ResumeReader() {
	const result = useStepUpResume<{ name: string }>({
		key: INTENT_KEY,
		parse: (payload) =>
			payload && typeof payload === "object"
				? (payload as { name: string })
				: null,
	});
	resumeSeen.intent = result.intent;
	resumeSeen.failure = result.failure;
	return null;
}

describe("step-up that navigates away", () => {
	it("persists the guarded operation's input before the flow can leave", () => {
		act(() => {
			root.render(<IntentHarness onToken={vi.fn()} onFailure={vi.fn()} />);
		});
		clickGuarded();

		const raw = window.sessionStorage.getItem(STEP_UP_INTENT_STORAGE_KEY);
		expect(raw).not.toBeNull();
		const record = JSON.parse(raw as string) as Record<string, unknown>;
		expect(record.key).toBe(INTENT_KEY);
		expect(record.payload).toEqual({ name: "CI" });
	});

	it("completes the operation after the challenge returns", () => {
		// The document is new and the router has already normalized Descope's
		// parameters off the URL — the boot capture is what survives.
		captureDescopeContinuation(RETURN_URL);
		const onResume = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<ResumeHarness onResume={onResume} onFailure={onFailure} />);
		});

		// The flow must be MOUNTED with its parameters back on the URL, or the
		// pending execution can never resume.
		expect(
			container.querySelector('[data-testid="step-up-dialog"]'),
		).not.toBeNull();
		expect(window.location.search).toContain(
			"descope-login-flow=step-up%7C%23%7C",
		);
		expect(window.location.search).toContain("code=bcff601d");

		const onSuccess = descope.flowProps?.onSuccess as (event: {
			detail: { sessionJwt?: string };
		}) => void;
		act(() => {
			onSuccess({ detail: { sessionJwt: "su-jwt" } });
		});

		expect(onResume).toHaveBeenCalledWith("su-jwt");
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("surfaces an error when the challenge did not come back", () => {
		// No captured continuation: the user returned without a usable code.
		const onResume = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<ResumeHarness onResume={onResume} onFailure={onFailure} />);
		});

		expect(onResume).not.toHaveBeenCalled();
		expect(onFailure).toHaveBeenCalledWith(STEP_UP_RESUME_INCOMPLETE_MESSAGE);
		expect(container.querySelector('[data-testid="step-up-dialog"]')).toBe(
			null,
		);
	});

	it("reports a step-up return that nothing can replay, exactly once", () => {
		// This is the production silence: a successful challenge lands back on an
		// unchanged page. Every step-up caller now reports it, and only one does.
		captureDescopeContinuation(RETURN_URL);
		const first = vi.fn();
		const second = vi.fn();
		act(() => {
			root.render(
				<>
					<Harness onToken={vi.fn()} onFailure={first} />
					<Harness onToken={vi.fn()} onFailure={second} />
				</>,
			);
		});

		expect(first.mock.calls.length + second.mock.calls.length).toBe(1);
		expect([...first.mock.calls, ...second.mock.calls][0]?.[0]).toBe(
			STEP_UP_RESUME_LOST_MESSAGE,
		);
	});

	it("stays quiet when the returning flow is the login flow", () => {
		captureDescopeContinuation(
			"https://acme.os.tedix.dev/?t=abc&descope-login-flow=sign-up-or-in%7C%23%7Cx.end",
		);
		const onFailure = vi.fn();
		act(() => {
			root.render(<Harness onToken={vi.fn()} onFailure={onFailure} />);
		});
		expect(onFailure).not.toHaveBeenCalled();
	});

	it("resumes the operation once and never twice", () => {
		writeStepUpIntent(window.sessionStorage, {
			key: INTENT_KEY,
			payload: { name: "CI" },
			createdAt: Date.now(),
		});
		captureDescopeContinuation(RETURN_URL);

		act(() => {
			root.render(<ResumeReader />);
		});
		expect(resumeSeen.intent).toEqual({ name: "CI" });
		expect(resumeSeen.failure).toBeNull();
		// Consumed out of storage by the read itself.
		expect(
			window.sessionStorage.getItem(STEP_UP_INTENT_STORAGE_KEY),
		).toBeNull();

		// A reload of the same URL: no intent survives, so no second create can
		// be issued, and the user is told rather than shown nothing.
		resetStepUpContinuationForTest();
		resetStepUpOrphanReportForTest();
		captureDescopeContinuation(RETURN_URL);
		const reloaded = createRoot(document.createElement("div"));
		act(() => {
			reloaded.render(<ResumeReader />);
		});
		act(() => reloaded.unmount());
		expect(resumeSeen.intent).toBeNull();
		expect(resumeSeen.failure).toBe(STEP_UP_RESUME_LOST_MESSAGE);
	});

	it("does not resume on the zero-account local lane", () => {
		host.kind = "local";
		captureDescopeContinuation(RETURN_URL);
		const onResume = vi.fn();
		const onFailure = vi.fn();
		act(() => {
			root.render(<ResumeHarness onResume={onResume} onFailure={onFailure} />);
		});
		expect(onResume).not.toHaveBeenCalled();
		expect(onFailure).not.toHaveBeenCalled();
		expect(descope.flowProps).toBeNull();
	});
});
