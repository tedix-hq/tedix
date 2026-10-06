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
import { TedixByosOtpScreen } from "./descope-byos-otp-screen";
import { INBOUND_CONSENT_OTP_INTERACTIONS } from "./descope-byos-contract";
import { IDENTITY_JOURNEY_COPY } from "./identity-journey-copy";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

function setInputValue(input: HTMLInputElement, value: string): void {
	// React tracks the value property; go through the native setter so its
	// change detection sees the update from the bubbled input event.
	const setter = Object.getOwnPropertyDescriptor(
		window.HTMLInputElement.prototype,
		"value",
	)!.set!;
	setter.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!match) throw new Error(`no button containing "${label}"`);
	return match;
}

describe("TedixByosOtpScreen", () => {
	it("verifies a 6-digit code through the consent OTP interaction", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		const input = container.querySelector<HTMLInputElement>(
			"#tedix-identity-otp",
		);
		expect(input).not.toBeNull();
		await act(async () => {
			setInputValue(input!, "123456");
		});
		await act(async () => {
			input!
				.closest("form")!
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});

		expect(next).toHaveBeenCalledWith(INBOUND_CONSENT_OTP_INTERACTIONS.verify, {
			code: "123456",
		});
	});

	it("rejects a malformed code without calling the flow", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		const input = container.querySelector<HTMLInputElement>(
			"#tedix-identity-otp",
		)!;
		await act(async () => {
			setInputValue(input, "12");
		});
		await act(async () => {
			input
				.closest("form")!
				.dispatchEvent(
					new Event("submit", { bubbles: true, cancelable: true }),
				);
		});

		expect(next).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Enter the 6-digit code.");
	});

	it("surfaces the shared copy and re-enables buttons when the flow throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const next = vi.fn().mockRejectedValue(new Error("flow down"));
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		await act(async () => button("Resend code").click());

		expect(container.textContent).toContain(
			IDENTITY_JOURNEY_COPY.errors.otpVerify,
		);
		expect(button("Verify code").disabled).toBe(false);
		expect(button("Resend code").disabled).toBe(false);
	});

	it("re-enables verification after a successful same-screen resend", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		await act(async () => button("Resend code").click());

		expect(next).toHaveBeenCalledWith(
			INBOUND_CONSENT_OTP_INTERACTIONS.resend,
			{},
		);
		expect(button("Verify code").disabled).toBe(false);
		expect(button("Resend code").disabled).toBe(false);
	});

	it("releases the pending state when the flow reports a context error", async () => {
		// Descope can report an authentication error through the next context
		// render before the interaction promise settles. That signal must release
		// Verify/Resend instead of leaving the screen disabled.
		const next = vi.fn(() => new Promise<unknown>(() => undefined));
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		act(() => button("Resend code").click());
		expect(button("Verify code").disabled).toBe(true);

		act(() =>
			root.render(
				<TedixByosOtpScreen
					context={{ error: { text: "The code expired." } }}
					next={next}
				/>,
			),
		);

		expect(button("Verify code").disabled).toBe(false);
		expect(container.textContent).toContain("The code expired.");
	});

	it("routes the back action to the consent back interaction", async () => {
		const next = vi.fn().mockResolvedValue({ ok: true });
		act(() => root.render(<TedixByosOtpScreen context={{}} next={next} />));

		await act(async () => button("Use another email").click());

		expect(next).toHaveBeenCalledWith(
			INBOUND_CONSENT_OTP_INTERACTIONS.back,
			{},
		);
	});
});
