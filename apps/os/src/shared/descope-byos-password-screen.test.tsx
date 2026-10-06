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
import {
	TedixByosPasswordScreen,
	type ByosPasswordScreenContract,
} from "./descope-byos-password-screen";
import type { DescopeByosContext } from "./descope-byos-contract";

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
const signIn: ByosPasswordScreenContract = {
	mode: "sign-in",
	submit: "sign-in",
	forgotPassword: "reset",
	back: "back",
	fields: { loginId: "email", password: "password" },
};
const setup: ByosPasswordScreenContract = {
	mode: "set",
	submit: "set",
	fields: { newPassword: "newPassword_noPolicyOverrides" },
};
function input(name: string) {
	return container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
}
async function fill(name: string, value: string) {
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			window.HTMLInputElement.prototype,
			"value",
		)!.set!.call(input(name), value);
		input(name).dispatchEvent(new Event("input", { bubbles: true }));
	});
}
async function submit() {
	await act(async () => {
		container
			.querySelector("form")!
			.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	});
}
function render(
	contract = signIn,
	context: DescopeByosContext = {},
	next = vi.fn().mockResolvedValue({}),
) {
	act(() =>
		root.render(
			<TedixByosPasswordScreen
				contract={contract}
				context={context}
				next={next}
			/>,
		),
	);
	return next;
}

describe("TedixByosPasswordScreen", () => {
	it("sends exact declared outputs, preserves password whitespace, and clears secrets", async () => {
		const next = render(signIn, { form: { extraneous: "not an output" } });
		await fill("email", " reviewer@example.com ");
		await fill("password", " Password123! ");
		await submit();
		expect(next).toHaveBeenCalledWith("sign-in", {
			email: "reviewer@example.com",
			password: " Password123! ",
		});
		expect(input("password").value).toBe("");
		expect(input("email").autocomplete).toBe("username");
		expect(input("password").autocomplete).toBe("current-password");
		expect(
			container.querySelector<HTMLButtonElement>("button[type=submit]")!
				.disabled,
		).toBe(true);
	});
	it("does not advance empty passwords or invalid email", async () => {
		const next = render();
		await fill("email", "bad");
		await submit();
		expect(container.textContent).toContain("Enter a valid email");
		await fill("email", "reviewer@example.com");
		await submit();
		expect(container.textContent).toContain("Enter your password");
		expect(next).not.toHaveBeenCalled();
	});
	it("requires confirmation and uses normalized BYOS minLength policy", async () => {
		const next = render(setup, {
			data: { passwordPolicy: { minLength: "12" } },
		});
		await fill("newPassword_noPolicyOverrides", "short");
		await fill("passwordConfirmation", "different");
		await submit();
		expect(container.textContent).toContain("don't match");
		await fill("passwordConfirmation", "short");
		await submit();
		expect(container.textContent).toContain("Use at least 12 characters");
		expect(next).not.toHaveBeenCalled();
		await fill("newPassword_noPolicyOverrides", "LongPassword123!");
		await fill("passwordConfirmation", "LongPassword123!");
		await submit();
		expect(next).toHaveBeenCalledWith("set", {
			newPassword_noPolicyOverrides: "LongPassword123!",
		});
		expect(input("passwordConfirmation").value).toBe("");
		expect(input("newPassword_noPolicyOverrides").autocomplete).toBe(
			"new-password",
		);
	});
	it("sends replacement fields without confirmation or accumulated context", async () => {
		const contract: ByosPasswordScreenContract = {
			mode: "replace",
			submit: "replace",
			fields: { oldPassword: "password", newPassword: "newPassword" },
		};
		const next = render(contract);
		await fill("password", "OldPassword!");
		await fill("newPassword", "NewPassword!");
		await fill("passwordConfirmation", "NewPassword!");
		await submit();
		expect(next).toHaveBeenCalledWith("replace", {
			password: "OldPassword!",
			newPassword: "NewPassword!",
		});
	});
	it("sends only email when requesting a reset", async () => {
		const next = render({
			mode: "reset",
			submit: "send-reset",
			fields: { loginId: "email" },
		});
		expect(container.querySelector("input[type=password]")).toBeNull();
		await fill("email", "reviewer@example.com");
		await submit();
		expect(next).toHaveBeenCalledWith("send-reset", {
			email: "reviewer@example.com",
		});
	});
	it("does not disclose provider errors or rejected form contents in logs", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const next = vi
			.fn()
			.mockRejectedValue(new Error("Password123! provider payload"));
		render(signIn, {}, next);
		await fill("email", "reviewer@example.com");
		await fill("password", "Password123!");
		await submit();
		expect(log).toHaveBeenCalledWith("Tedix BYOS password interaction failed");
		expect(container.textContent).not.toContain("Password123!");
		expect(container.textContent).toContain("Please try again");
		expect(
			container.querySelector<HTMLButtonElement>("button[type=submit]")!
				.disabled,
		).toBe(false);
	});
	it("re-enables after context errors without echoing their text", async () => {
		const next = render();
		await fill("email", "reviewer@example.com");
		await fill("password", "Password123!");
		await submit();
		render(
			signIn,
			{ error: { text: "Password123! leaked provider text" } },
			next,
		);
		expect(container.textContent).not.toContain("Password123!");
		expect(
			container.querySelector<HTMLButtonElement>("button[type=submit]")!
				.disabled,
		).toBe(false);
	});
	it("forgot-password transitions never send credential fields", async () => {
		const next = render();
		await fill("password", "Password123!");
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent?.includes("Forgot password"))!
				.click();
		});
		expect(next).toHaveBeenCalledWith("reset", {});
		expect(input("password").value).toBe("");
	});
	it("uses the supplied email continuation label without sending credentials", async () => {
		const next = render({ ...signIn, backLabel: "Continue by email" });
		await fill("email", "reviewer@example.com");
		await fill("password", "Password123!");
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent === "Continue by email")!
				.click();
		});
		expect(next).toHaveBeenCalledWith("back", {});
		expect(input("password").value).toBe("");
	});
	it("enforces disallowed characters from the BYOS policy without showing submitted secrets", async () => {
		const next = render(setup, {
			data: { passwordPolicy: { disallowedChars: "$" } },
		});
		await fill("newPassword_noPolicyOverrides", "Password$123");
		await fill("passwordConfirmation", "Password$123");
		await submit();
		expect(next).not.toHaveBeenCalled();
		expect(container.textContent).toContain("doesn't meet");
		expect(container.textContent).not.toContain("Password$123");
	});
});
