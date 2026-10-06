import { IDENTITY_JOURNEY_COPY } from "./identity-journey-copy";
import { ArrowLeft, EnvelopeSimple } from "@phosphor-icons/react";
import { useForm } from "@tanstack/react-form";
import * as z from "zod";
import { Button } from "@/components/kumo/button";
import { FormField } from "@/components/kumo/forms/form-field";
import { Input } from "@/components/kumo/input";
import { ByosFlowError, useByosAdvance } from "./descope-byos-advance";
import {
	INBOUND_CONSENT_OTP_INTERACTIONS,
	type ByosOtpInteractions,
	type DescopeByosContext,
	type DescopeFlowNext,
} from "./descope-byos-contract";

const codeSchema = z
	.string()
	.trim()
	.regex(/^\d{6}$/, "Enter the 6-digit code.");

export function TedixByosOtpScreen({
	context,
	interactions = INBOUND_CONSENT_OTP_INTERACTIONS,
	next,
}: {
	context?: DescopeByosContext;
	/** Flow-specific interaction ids; step-up omits `back`. */
	interactions?: ByosOtpInteractions;
	next: DescopeFlowNext;
}) {
	const { advance, error, pending } = useByosAdvance({
		context,
		errorMessage: IDENTITY_JOURNEY_COPY.errors.otpVerify,
		logLabel: "Tedix BYOS OTP advance failed",
		next,
	});
	const form = useForm({
		defaultValues: { code: "" },
		onSubmit: ({ value }) =>
			advance(interactions.verify, {
				code: value.code.trim(),
			}),
	});

	return (
		<div className="identity-login-options">
			<div className="identity-otp-heading">
				<EnvelopeSimple aria-hidden="true" size={28} />
				<p>Enter the 6-digit code sent to your email address.</p>
			</div>
			<form
				className="identity-email-form"
				noValidate
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<FormField
					form={form}
					name="code"
					label="Verification code"
					validators={{
						onSubmit: ({ value }: { value: string }) => {
							const result = codeSchema.safeParse(value);
							return result.success
								? undefined
								: result.error.issues[0]?.message;
						},
					}}
				>
					{(field, meta) => (
						<Input
							id="tedix-identity-otp"
							name={field.name}
							autoComplete="one-time-code"
							inputMode="numeric"
							maxLength={6}
							placeholder="000000"
							value={String(field.state.value ?? "")}
							onChange={(event) =>
								field.handleChange(
									event.target.value.replace(/\D/g, "").slice(0, 6),
								)
							}
							aria-labelledby={`${meta.id}-label`}
							aria-invalid={meta.invalid || undefined}
							aria-describedby={meta.errorId}
						/>
					)}
				</FormField>
				<Button
					type="submit"
					className="w-full"
					loading={pending === INBOUND_CONSENT_OTP_INTERACTIONS.verify}
					disabled={pending !== null}
				>
					Verify code
				</Button>
			</form>
			<div className="identity-otp-actions">
				{interactions.back ? (
					<Button
						type="button"
						variant="ghost"
						icon={<ArrowLeft aria-hidden="true" />}
						disabled={pending !== null}
						onClick={() => void advance(interactions.back as string)}
					>
						Use another email
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					disabled={pending !== null}
					loading={pending === interactions.resend}
					onClick={() =>
						void advance(interactions.resend, {}, { releaseOnResolve: true })
					}
				>
					Resend code
				</Button>
			</div>
			<ByosFlowError context={context} error={error} />
		</div>
	);
}
