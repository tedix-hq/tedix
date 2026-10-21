import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/kumo/alert";
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
import { errorMessage } from "@/lib/orpc-error";

interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description: ReactNode;
	confirmLabel: string;
	pendingLabel: string;
	/** Replaces the confirm label while an error is shown. */
	retryLabel?: string;
	cancelLabel?: string;
	destructive?: boolean;
	isPending: boolean;
	confirmDisabled?: boolean;
	/** Shown inside the dialog: the page behind it is covered. */
	error?: unknown;
	onConfirm: () => void;
	/** Associates the footer action with a form in the dialog body. */
	form?: string;
	children?: ReactNode;
}

/**
 * The one confirmation pattern: an explicit choice that stays open until the
 * write settles, shows progress on the confirm button, and keeps a failure on
 * screen with a retry. The caller closes it on success.
 */
export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	pendingLabel,
	retryLabel,
	cancelLabel = "Cancel",
	destructive = false,
	isPending,
	confirmDisabled = false,
	error,
	onConfirm,
	form,
	children,
}: ConfirmDialogProps) {
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => !isPending && onOpenChange(next)}
		>
			<AlertDialogContent size="sm">
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				{children}
				{error != null && !isPending && (
					<Alert variant="destructive" data-confirm-error>
						<AlertDescription>{errorMessage(error)}</AlertDescription>
					</Alert>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>
						{cancelLabel}
					</AlertDialogCancel>
					<AlertDialogAction
						form={form}
						type={form ? "submit" : "button"}
						variant={destructive ? "destructive" : "default"}
						loading={isPending}
						disabled={isPending || confirmDisabled}
						onClick={(event) => {
							event.preventDefault();
							// Dialog.Close closes on click regardless of preventDefault;
							// the dialog stays open until the mutation settles.
							event.preventBaseUIHandler();
							onConfirm();
						}}
					>
						{isPending
							? pendingLabel
							: error != null && retryLabel
								? retryLabel
								: confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
