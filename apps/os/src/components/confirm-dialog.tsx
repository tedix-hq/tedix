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
	destructive?: boolean;
	isPending: boolean;
	error?: unknown;
	onConfirm: () => void;
	children?: ReactNode;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel,
	pendingLabel,
	destructive = false,
	isPending,
	error,
	onConfirm,
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
				{error != null && (
					<Alert variant="destructive">
						<AlertDescription>{errorMessage(error)}</AlertDescription>
					</Alert>
				)}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						variant={destructive ? "destructive" : "default"}
						disabled={isPending}
						onClick={(event) => {
							event.preventDefault();
							// Dialog.Close closes on click regardless of preventDefault;
							// the dialog stays open until the mutation settles.
							event.preventBaseUIHandler();
							onConfirm();
						}}
					>
						{isPending ? pendingLabel : confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
