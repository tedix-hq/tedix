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
	props: null as Record<string, unknown> | null,
}));

vi.mock("@descope/react-sdk/flows", () => ({
	SignUpOrInFlow: (props: Record<string, unknown>) => {
		descope.props = props;
		return <div data-descope-flow />;
	},
}));

import { setThemePreference } from "@/lib/theme";
import { DESCOPE_LOGIN_SCREEN_NAME } from "@/shared/descope-byos-contract";
import { DESCOPE_LOGIN_INTERACTIONS } from "@/shared/descope-byos-contract";
import {
	DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME,
	DESCOPE_REVIEWER_SET_PASSWORD_SCREEN_NAME,
	resolveDescopePasswordScreen,
} from "@/shared/descope-byos-contract";
import { TedixSignUpOrInFlow } from "./descope-sign-up-or-in-flow";
import { installTedixDescopeSurfaceTokens } from "@/shared/descope-theme";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	descope.props = null;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	setThemePreference("system");
});

describe("TedixSignUpOrInFlow", () => {
	it("uses the configured email fallback without sending password fields", async () => {
		act(() => root.render(<TedixSignUpOrInFlow />));
		const update = descope.props?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
			ref: HTMLElement,
		) => boolean;
		const next = vi.fn().mockResolvedValue(undefined);
		await act(async () =>
			update(DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME, {}, next, container),
		);
		const fallback = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Continue by email",
		);
		expect(fallback).toBeDefined();
		await act(async () => fallback?.click());
		expect(next).toHaveBeenCalledWith("tZbr-2eP17", {});
	});

	it("clears sign-in state on setup and submits only the exported newPassword field", async () => {
		act(() => root.render(<TedixSignUpOrInFlow />));
		const update = descope.props?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
			ref: HTMLElement,
		) => boolean;
		const next = vi.fn().mockResolvedValue(undefined);
		const enter = async (name: string, value: string) => {
			await act(async () => {
				const input = container.querySelector<HTMLInputElement>(
					`input[name="${name}"]`,
				);
				Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)?.set?.call(input, value);
				input?.dispatchEvent(new Event("input", { bubbles: true }));
			});
		};
		await act(async () =>
			update(DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME, {}, next, container),
		);
		await enter("password", "old-sign-in-value");
		await act(async () => {
			container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		await act(async () =>
			update(
				DESCOPE_REVIEWER_SET_PASSWORD_SCREEN_NAME,
				{ data: { passwordPolicy: { minLength: "8" } } },
				next,
				container,
			),
		);
		expect(
			container.querySelector<HTMLInputElement>('input[name="newPassword"]')
				?.value,
		).toBe("");
		expect(
			container.querySelector<HTMLInputElement>('input[name="newPassword"]')
				?.disabled,
		).toBe(false);
		await enter("newPassword", "Fresh-password1!");
		await enter("passwordConfirmation", "Fresh-password1!");
		await act(async () => {
			container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(next).toHaveBeenLastCalledWith("n6WbbqzlwS", {
			newPassword: "Fresh-password1!",
		});
		expect(
			resolveDescopePasswordScreen(
				"inbound-apps-multi-org-consent",
				DESCOPE_REVIEWER_SET_PASSWORD_SCREEN_NAME,
			),
		).toBeNull();
	});

	it("handles the exact reviewer password screen and keeps errors retryable", async () => {
		act(() => root.render(<TedixSignUpOrInFlow />));
		const update = descope.props?.onScreenUpdate as (
			name: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
			ref: HTMLElement,
		) => boolean;
		const next = vi.fn();
		await act(async () => {
			expect(
				update(
					DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME,
					{ error: "Wrong password" },
					next,
					container,
				),
			).toBe(true);
		});
		expect(container.querySelector('input[type="password"]')).not.toBeNull();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Please try again",
		);
		expect(next).not.toHaveBeenCalled();
		const password = container.querySelector<HTMLInputElement>(
			'input[type="password"]',
		);
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(password, "test-password");
			password?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container
				.querySelector("form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});
		expect(next).toHaveBeenCalledWith("pXVwWREG7M", {
			password: "test-password",
		});
		expect(
			resolveDescopePasswordScreen(
				"inbound-apps-user-consent",
				DESCOPE_REVIEWER_PASSWORD_SCREEN_NAME,
			),
		).toBeNull();
		expect(
			resolveDescopePasswordScreen("sign-up-or-in", "Other Password Screen"),
		).toBeNull();
	});

	it("uses the resolved Tedix theme instead of Descope's light default", () => {
		act(() => setThemePreference("dark"));
		act(() => root.render(<TedixSignUpOrInFlow redirectUrl="/after" />));

		expect(descope.props).toMatchObject({
			redirectUrl: "/after",
			theme: "dark",
		});
		expect(JSON.parse(String(descope.props?.themeOverride))).toMatchObject({
			dark: {
				globals: {
					colors: { primary: { main: "#8b7bf7" } },
				},
			},
		});
	});

	it("updates the shadow-DOM flow when the OS theme changes", () => {
		act(() => setThemePreference("dark"));
		act(() => root.render(<TedixSignUpOrInFlow />));
		expect(descope.props?.theme).toBe("dark");

		act(() => setThemePreference("light"));
		expect(descope.props?.theme).toBe("light");
	});

	it("installs the missing OS surface tokens once in Descope's shadow root", () => {
		const element = document.createElement("div");
		const shadowRoot = element.attachShadow({ mode: "open" });

		installTedixDescopeSurfaceTokens(element);
		installTedixDescopeSurfaceTokens(element);

		const styles = shadowRoot.querySelectorAll("#tedix-descope-surface-tokens");
		expect(styles).toHaveLength(1);
		expect(styles[0]?.textContent).toContain(
			"--descope-colors-surface-contrast: var(--foreground) !important",
		);
		expect(styles[0]?.textContent).toContain(
			"--descope-colors-surface-dark: var(--muted-foreground) !important",
		);
	});

	it("replaces the snapshot-pinned welcome screen with Tedix BYOS controls", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixSignUpOrInFlow />));
		const onScreenUpdate = descope.props?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			advance: (
				interactionId: string,
				form: Record<string, unknown>,
			) => Promise<unknown>,
			ref: HTMLElement,
		) => boolean;

		await act(async () => {
			expect(
				onScreenUpdate(
					DESCOPE_LOGIN_SCREEN_NAME,
					{},
					next,
					document.createElement("div"),
				),
			).toBe(true);
		});

		const email = container.querySelector<HTMLInputElement>(
			"#tedix-identity-email",
		);
		expect(email).not.toBeNull();
		expect(container.textContent).toContain("Continue with Google");
		expect(container.textContent).not.toContain("Welcome!");
		expect(
			container.querySelectorAll(".identity-provider-button svg"),
		).toHaveLength(3);

		await act(async () => {
			if (!email) return;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(email, "owner@example.com");
			email.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			container
				.querySelector<HTMLFormElement>(".identity-email-form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
			await new Promise((resolve) => setTimeout(resolve, 10));
		});

		expect(next).toHaveBeenCalledWith(
			DESCOPE_LOGIN_INTERACTIONS["sign-up-or-in"].email,
			{
				email: "owner@example.com",
			},
		);
	});

	it("releases provider controls when Descope returns an authentication error", async () => {
		const next = vi.fn().mockResolvedValue({ ok: false });
		act(() => root.render(<TedixSignUpOrInFlow />));
		const onScreenUpdate = descope.props?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			advance: (
				interactionId: string,
				form: Record<string, unknown>,
			) => Promise<unknown>,
			ref: HTMLElement,
		) => boolean;

		await act(async () => {
			onScreenUpdate(
				DESCOPE_LOGIN_SCREEN_NAME,
				{},
				next,
				document.createElement("div"),
			);
		});
		const google = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Continue with Google"),
		);
		await act(async () => {
			google?.click();
			await Promise.resolve();
		});
		expect(google?.disabled).toBe(true);
		expect(next).toHaveBeenCalledWith(
			DESCOPE_LOGIN_INTERACTIONS["sign-up-or-in"].google,
			{ provider: "google" },
		);

		await act(async () => {
			onScreenUpdate(
				DESCOPE_LOGIN_SCREEN_NAME,
				{ error: { text: "Failed to sign up or in" } },
				next,
				document.createElement("div"),
			);
		});

		expect(google?.disabled).toBe(false);
		expect(container.textContent).toContain(
			"We couldn't complete sign-in. Please try again.",
		);
	});

	it("validates email before advancing the Descope interaction", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixSignUpOrInFlow />));
		const onScreenUpdate = descope.props?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			advance: typeof next,
			ref: HTMLElement,
		) => boolean;
		await act(async () => {
			onScreenUpdate(
				DESCOPE_LOGIN_SCREEN_NAME,
				{},
				next,
				document.createElement("div"),
			);
		});

		const email = container.querySelector<HTMLInputElement>(
			"#tedix-identity-email",
		);
		expect(
			container.querySelector<HTMLFormElement>(".identity-email-form")
				?.noValidate,
		).toBe(true);
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(email, "not-an-email");
			email?.dispatchEvent(new Event("input", { bubbles: true }));
			container
				.querySelector<HTMLFormElement>(".identity-email-form")
				?.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});

		expect(next).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Enter a valid email address.");
		expect(email?.getAttribute("aria-invalid")).toBe("true");
	});

	it("preserves Descope context errors for the owned screen", async () => {
		act(() => root.render(<TedixSignUpOrInFlow />));
		const onScreenUpdate = descope.props?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
			ref: HTMLElement,
		) => boolean;
		await act(async () => {
			onScreenUpdate(
				DESCOPE_LOGIN_SCREEN_NAME,
				{ error: { text: "That sign-in could not be completed." } },
				vi.fn(),
				document.createElement("div"),
			);
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"That sign-in could not be completed.",
		);
	});

	it("hands non-BYOS screens back to Descope", async () => {
		const downstream = vi.fn().mockReturnValue(false);
		act(() => root.render(<TedixSignUpOrInFlow onScreenUpdate={downstream} />));
		const onScreenUpdate = descope.props?.onScreenUpdate as (
			screenName: string,
			context: Record<string, unknown>,
			next: ReturnType<typeof vi.fn>,
			ref: HTMLElement,
		) => boolean;
		const next = vi.fn();
		const ref = document.createElement("div");

		await act(async () => {
			expect(onScreenUpdate("Verify OTP", {}, next, ref)).toBe(false);
		});
		expect(downstream).toHaveBeenCalledWith("Verify OTP", {}, next, ref);
	});
});
