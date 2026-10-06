import { useEffect, useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import type {
	DescopeByosContext,
	DescopeFlowNext,
} from "./descope-byos-contract";

/** Exact current-screen names and interactions from the exported Descope flow. */
export type ByosPasswordScreenContract = {
	mode: "sign-in" | "set" | "replace" | "reset";
	submit: string;
	back?: string;
	backLabel?: string;
	forgotPassword?: string;
	fields: {
		loginId?: string;
		password?: string;
		newPassword?: string;
		oldPassword?: string;
	};
};

const FAILURE = "We couldn't complete this step. Please try again.";

function passwordPolicy(context?: DescopeByosContext) {
	const data = context?.data;
	if (!data || typeof data !== "object") return {};
	const policy = (data as Record<string, unknown>).passwordPolicy;
	if (!policy || typeof policy !== "object") return {};
	// BYOS supplies normalized strings, not the password.getPolicy SDK schema.
	const raw = policy as Record<string, unknown>;
	const minimum = Number(raw.minLength);
	return {
		minimum:
			Number.isInteger(minimum) && minimum > 0 && minimum <= 64
				? minimum
				: undefined,
		disallowedChars:
			typeof raw.disallowedChars === "string" ? raw.disallowedChars : "",
	};
}

const TITLES = {
	"sign-in": "Sign in with a password",
	set: "Set your password",
	replace: "Change your password",
	reset: "Reset your password",
} as const;

/** Descope owns authentication/policy. This screen sends only declared outputs. */
export function TedixByosPasswordScreen({
	contract,
	context,
	next,
}: {
	contract: ByosPasswordScreenContract;
	context?: DescopeByosContext;
	next: DescopeFlowNext;
}) {
	const [loginId, setLoginId] = useState("");
	const [password, setPassword] = useState("");
	const [oldPassword, setOldPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [pending, setPending] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const settingPassword =
		contract.mode === "set" || contract.mode === "replace";
	const policy = passwordPolicy(context);
	useEffect(() => {
		if (context?.error) setPending(null);
	}, [context?.error]);

	const clearPasswords = () => {
		setPassword("");
		setOldPassword("");
		setConfirmation("");
	};
	const advance = async (
		interaction: string,
		form: Record<string, unknown>,
	) => {
		setPending(interaction);
		setError(null);
		clearPasswords();
		try {
			await next(interaction, form);
			// Resolution hands control to the flow, not proof of authentication.
		} catch {
			// A provider exception can contain the submitted form. Never log it.
			console.error("Tedix BYOS password interaction failed");
			setError(FAILURE);
			setPending(null);
		}
	};
	const submit = () => {
		if (pending !== null) return;
		if (
			contract.fields.loginId &&
			!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginId.trim())
		) {
			setError("Enter a valid email address.");
			return;
		}
		if (contract.mode !== "reset" && !password) {
			setError("Enter your password.");
			return;
		}
		if (settingPassword && password !== confirmation) {
			setError("The passwords don't match.");
			return;
		}
		if (contract.mode === "replace" && !oldPassword) {
			setError("Enter your current password.");
			return;
		}
		if (settingPassword && policy.minimum && password.length < policy.minimum) {
			setError(`Use at least ${policy.minimum} characters.`);
			return;
		}
		if (
			settingPassword &&
			(password.length > 64 ||
				[...(policy.disallowedChars ?? "")].some((character) =>
					password.includes(character),
				))
		) {
			setError("Your password doesn't meet the password requirements.");
			return;
		}
		const form: Record<string, unknown> = {};
		if (contract.fields.loginId) form[contract.fields.loginId] = loginId.trim();
		if (contract.mode !== "reset") {
			const field = settingPassword
				? contract.fields.newPassword
				: contract.fields.password;
			if (
				!field ||
				(contract.mode === "replace" && !contract.fields.oldPassword)
			) {
				setError(FAILURE);
				return;
			}
			form[field] = password;
			if (contract.mode === "replace" && contract.fields.oldPassword)
				form[contract.fields.oldPassword] = oldPassword;
		}
		void advance(contract.submit, form);
	};
	const message = error ?? (context?.error ? FAILURE : null);
	return (
		<div className="identity-login-options">
			<h2>{TITLES[contract.mode]}</h2>
			{contract.mode === "reset" ? (
				<p>We'll email you a link to reset your password.</p>
			) : null}
			<form
				className="identity-email-form"
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					submit();
				}}
			>
				{contract.fields.loginId ? (
					<label>
						Email address
						<Input
							name={contract.fields.loginId}
							type="email"
							autoComplete="username"
							inputMode="email"
							value={loginId}
							disabled={pending !== null}
							onChange={(event) => setLoginId(event.target.value)}
						/>
					</label>
				) : null}
				{contract.mode === "replace" ? (
					<label>
						Current password
						<Input
							name={contract.fields.oldPassword}
							type="password"
							autoComplete="current-password"
							value={oldPassword}
							disabled={pending !== null}
							onChange={(event) => setOldPassword(event.target.value)}
						/>
					</label>
				) : null}
				{contract.mode !== "reset" ? (
					<label>
						{settingPassword ? "New password" : "Password"}
						<Input
							name={
								settingPassword
									? contract.fields.newPassword
									: contract.fields.password
							}
							type="password"
							autoComplete={
								settingPassword ? "new-password" : "current-password"
							}
							maxLength={settingPassword ? 64 : undefined}
							value={password}
							disabled={pending !== null}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</label>
				) : null}
				{settingPassword ? (
					<>
						<label>
							Confirm password
							<Input
								name="passwordConfirmation"
								type="password"
								autoComplete="new-password"
								maxLength={64}
								value={confirmation}
								disabled={pending !== null}
								onChange={(event) => setConfirmation(event.target.value)}
							/>
						</label>
						<p>
							{policy.minimum
								? `Use at least ${policy.minimum} characters. `
								: ""}
							Additional password requirements are checked securely by Descope.
						</p>
					</>
				) : null}
				<Button
					type="submit"
					className="w-full"
					loading={pending === contract.submit}
					disabled={pending !== null}
				>
					{contract.mode === "reset"
						? "Send reset link"
						: contract.mode === "sign-in"
							? "Sign in"
							: "Save password"}
				</Button>
			</form>
			{contract.forgotPassword ? (
				<Button
					type="button"
					variant="ghost"
					disabled={pending !== null}
					onClick={() => void advance(contract.forgotPassword!, {})}
				>
					Forgot password?
				</Button>
			) : null}
			{contract.back ? (
				<Button
					type="button"
					variant="ghost"
					disabled={pending !== null}
					onClick={() => void advance(contract.back!, {})}
				>
					{contract.backLabel ?? "Back"}
				</Button>
			) : null}
			{message ? (
				<p role="alert" className="identity-flow-error">
					{message}
				</p>
			) : null}
		</div>
	);
}
