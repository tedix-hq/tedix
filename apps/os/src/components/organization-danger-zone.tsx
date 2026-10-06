/**
 * Danger zone: retire the organization without destroying its tedi memory.
 *
 * Owner-only by SERVER rule (`organizations.delete` refuses any non-owner
 * membership before it even checks step-up), so the page renders this section
 * only when the credential-resolved `authority.role` is `owner` — mirroring
 * the guard, not replacing it. The server additionally enforces two-phase
 * offboarding: a delete without `force` requires the org to have been
 * cancelled for the grace period, and that refusal surfaces here verbatim.
 *
 * Step-up: the API rejects `organizations.delete` unless the presented token
 * carries Descope's `su` claim. The stepped-up session JWT travels as a
 * mutation ARGUMENT through `getAuthenticatedOsApi(token)` — the OS
 * same-origin `/api` proxy strips Authorization, and the ambient DS cookie may
 * already have been replaced by an ordinary refresh that dropped the claim.
 * See `@/lib/step-up-auth`.
 */

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { FormInput } from "@/components/forms/form-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/kumo/alert-dialog";
import { Button } from "@/components/kumo/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Loader } from "@/components/kumo/loader";
import { exactConfirmationSchema } from "@/components/kumo/forms/exact-confirmation-schema";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";
import { getAuthenticatedOsApi } from "@/lib/api";
import { useStepUpAuth } from "@/lib/step-up-auth";

/**
 * Where a retired tenant's operator lands. The tenant host itself is being
 * torn down, so this is a cross-host navigation to the central launcher —
 * `window.location.assign`, never a router navigation.
 */
export const POST_DELETE_DESTINATION =
	"https://os.tedix.dev/account/organizations";

interface DangerZoneProps {
	organizationId: string;
	organizationName: string;
}

export function DangerZone({
	organizationId,
	organizationName,
}: DangerZoneProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	// The stepped-up token is held between the step-up flow and the typed-name
	// confirmation. Abandoning the dialog discards it — reopening must
	// re-authenticate rather than reuse a stale proof.
	const [steppedUpToken, setSteppedUpToken] = useState<string | null>(null);
	const { requireStepUp, StepUpDialog } = useStepUpAuth({
		title: "Confirm your identity",
		description:
			"Retiring an organization removes tenant access. Please re-authenticate to continue.",
		onFailure: (message) => setFailure(message),
	});

	const deleteMutation = useMutation({
		mutationFn: (input: { steppedUpToken: string }) =>
			getAuthenticatedOsApi(input.steppedUpToken).organizations.delete({
				organizationId,
			}),
		onSuccess: () => {
			// The organization — and this tenant host — no longer exist. Leave for
			// the launcher's organizations list; nothing here is worth invalidating.
			window.location.assign(POST_DELETE_DESTINATION);
		},
		onError: (error) => {
			setFailure(
				error instanceof Error && error.message
					? error.message
					: "Failed to retire organization",
			);
		},
	});
	const confirmationForm = useZodForm({
		schema: exactConfirmationSchema(organizationName, "Organization name"),
		defaultValues: { confirmation: "" },
		onSubmit: () => {
			if (!steppedUpToken) {
				setFailure("Re-authentication expired. Please start over.");
				setIsOpen(false);
				return;
			}
			setFailure(null);
			deleteMutation.mutate({ steppedUpToken });
		},
	});

	// Called after step-up succeeds — keeps the stepped-up token and opens the
	// name-confirmation dialog.
	const handleDeleteWithStepUp = () => {
		setFailure(null);
		requireStepUp((token) => {
			setSteppedUpToken(token);
			confirmationForm.reset();
			setIsOpen(true);
		});
	};

	const handleOpenChange = (open: boolean) => {
		if (deleteMutation.isPending) return;
		setIsOpen(open);
		// Abandoning the confirmation discards the step-up proof — reopening the
		// dialog has to re-authenticate rather than reuse a stale token.
		if (!open) {
			confirmationForm.reset();
			setSteppedUpToken(null);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-kumo-danger">Danger zone</CardTitle>
				<CardDescription>
					Retire this organization while retaining its durable worker memory for
					recovery or an explicitly authorized later purge.
				</CardDescription>
				<CardAction>
					<Button variant="destructive" onClick={handleDeleteWithStepUp}>
						Retire organization
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="space-y-4">
				<ul className="ml-4 list-disc space-y-1 text-kumo-subtle">
					<li>All apps will be disabled</li>
					<li>All team members will lose access</li>
					<li>All tedis will be retired and their memory retained</li>
					<li>Active subscriptions will be cancelled</li>
				</ul>

				{failure ? (
					<Alert variant="destructive">
						<AlertTitle>The organization was not retired</AlertTitle>
						<AlertDescription>{failure}</AlertDescription>
					</Alert>
				) : null}

				<StepUpDialog />

				<AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Retire organization?</AlertDialogTitle>
							<AlertDialogDescription>
								This removes tenant access, disables its apps, and retires its
								tedis. Their durable memory is retained.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<form
							className="grid gap-4"
							onSubmit={(event) => {
								event.preventDefault();
								void confirmationForm.handleSubmit();
							}}
						>
							<FormField
								form={confirmationForm}
								name="confirmation"
								label={`Type ${organizationName} to confirm`}
							>
								{(field, meta) => (
									<FormInput
										field={field}
										{...meta}
										placeholder={organizationName}
										disabled={deleteMutation.isPending}
										autoComplete="off"
									/>
								)}
							</FormField>
							<AlertDialogFooter>
								<AlertDialogCancel disabled={deleteMutation.isPending}>
									Cancel
								</AlertDialogCancel>
								<confirmationForm.Subscribe
									selector={(state) => state.canSubmit}
								>
									{(canSubmit) => (
										<AlertDialogAction
											type="submit"
											disabled={!canSubmit || deleteMutation.isPending}
											variant="destructive"
										>
											{deleteMutation.isPending && (
												<Loader className="mr-2" size="sm" />
											)}
											Retire organization
										</AlertDialogAction>
									)}
								</confirmationForm.Subscribe>
							</AlertDialogFooter>
						</form>
					</AlertDialogContent>
				</AlertDialog>
			</CardContent>
		</Card>
	);
}
