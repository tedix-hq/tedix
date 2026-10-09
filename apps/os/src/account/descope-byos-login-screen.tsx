import { ByosFlowError, useByosAdvance } from "@/shared/descope-byos-advance";
import { IDENTITY_JOURNEY_COPY } from "@/shared/identity-journey-copy";
import { AppleLogo, GoogleLogo, Key } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import * as z from "zod";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import { Input } from "@/components/kumo/input";
import {
	DESCOPE_LOGIN_SCREEN_NAME,
	type DescopeByosContext,
	type DescopeFlowNext,
	type DescopeLoginContract,
} from "@/shared/descope-byos-contract";

export function isTedixByosLoginScreen(screenName: string): boolean {
	return screenName === DESCOPE_LOGIN_SCREEN_NAME;
}

const emailSchema = z.object({
	email: z
		.string()
		.trim()
		.min(1, "Enter your email address.")
		.email("Enter a valid email address."),
});

function validateEmail(value: string): string | undefined {
	const result = emailSchema.shape.email.safeParse(value);
	return result.success ? undefined : result.error.issues[0]?.message;
}

export function TedixByosLoginScreen({
	context,
	interactions,
	next,
}: {
	context?: DescopeByosContext;
	interactions: DescopeLoginContract;
	next: DescopeFlowNext;
}) {
	const { advance, error, pending } = useByosAdvance({
		context,
		errorMessage: IDENTITY_JOURNEY_COPY.errors.signInAdvance,
		logLabel: "Tedix BYOS login advance failed",
		next,
	});
	const form = useForm({
		defaultValues: { email: "" },
		onSubmit: ({ value }) =>
			advance(interactions.email, {
				email: value.email.trim(),
			}),
	});

	return (
		<div className="identity-login-options">
			<form
				className="identity-email-form"
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					event.stopPropagation();
					void form.handleSubmit();
				}}
			>
				<FormField
					form={form}
					name="email"
					label="Email address"
					validators={{
						onBlur: ({ value }: { value: string }) => validateEmail(value),
						onSubmit: ({ value }: { value: string }) => validateEmail(value),
					}}
				>
					{(field, meta) => (
						<Input
							id="tedix-identity-email"
							name={field.name}
							type="email"
							autoComplete="email"
							inputMode="email"
							placeholder="you@example.com"
							value={String(field.state.value ?? "")}
							onBlur={field.handleBlur}
							onChange={(event) => field.handleChange(event.target.value)}
							aria-labelledby={`${meta.id}-label`}
							aria-invalid={meta.invalid || undefined}
							aria-describedby={meta.errorId}
							aria-errormessage={meta.errorId}
						/>
					)}
				</FormField>
				<form.Subscribe
					selector={(state) =>
						[state.canSubmit, state.isSubmitting, state.values.email] as const
					}
				>
					{([canSubmit, isSubmitting, email]) => (
						<Button
							type="submit"
							className="w-full"
							loading={isSubmitting}
							disabled={pending !== null || !canSubmit || !email.trim()}
						>
							Continue with email
						</Button>
					)}
				</form.Subscribe>
			</form>

			<div className="identity-method-divider" role="separator">
				<span>or</span>
			</div>

			<div className="identity-provider-list">
				<Button
					type="button"
					variant="outline"
					className="identity-provider-button w-full"
					icon={<GoogleLogo aria-hidden="true" size={18} weight="bold" />}
					loading={pending === interactions.google}
					disabled={pending !== null}
					onClick={() =>
						void advance(interactions.google, { provider: "google" })
					}
				>
					Continue with Google
				</Button>
				{"apple" in interactions ? (
					<Button
						type="button"
						variant="outline"
						className="identity-provider-button w-full"
						icon={<AppleLogo aria-hidden="true" size={18} weight="fill" />}
						loading={pending === interactions.apple}
						disabled={pending !== null}
						onClick={() =>
							void advance(interactions.apple, { provider: "apple" })
						}
					>
						Continue with Apple
					</Button>
				) : null}
				{"microsoft" in interactions ? (
					<Button
						type="button"
						variant="outline"
						className="identity-provider-button w-full"
						loading={pending === interactions.microsoft}
						disabled={pending !== null}
						onClick={() =>
							void advance(interactions.microsoft, { provider: "microsoft" })
						}
					>
						Continue with Microsoft
					</Button>
				) : null}
				{"passkey" in interactions ? (
					<Button
						type="button"
						variant="outline"
						className="identity-provider-button w-full"
						icon={<Key aria-hidden="true" size={18} weight="regular" />}
						loading={pending === interactions.passkey}
						disabled={pending !== null}
						onClick={() => void advance(interactions.passkey)}
					>
						Continue with a passkey
					</Button>
				) : null}
			</div>

			<p className="identity-legal-copy">
				Tedix is for businesses only. By continuing, you confirm you are signing
				up for a business and agree to the Tedix{" "}
				<a href="https://tedix.dev/privacy/" target="_blank" rel="noreferrer">
					Privacy Policy
				</a>{" "}
				and{" "}
				<a href="https://tedix.dev/terms/" target="_blank" rel="noreferrer">
					Terms of Service
				</a>
				.
			</p>
			<ByosFlowError context={context} error={error} />
		</div>
	);
}
