"use client";

import { useEffect, useMemo } from "react";
import * as z from "zod";
import { FormInput } from "@/components/forms/form-input";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";

export interface EditorTextDialogProps {
	open: boolean;
	title: string;
	description: string;
	fieldLabel: string;
	initialValue: string;
	submitLabel: string;
	allowEmpty?: boolean;
	maxLength: number;
	placeholder?: string;
	onOpenChange: (open: boolean) => void;
	onSubmit: (value: string) => void;
}

/**
 * Shared single-field editor dialog. Editor actions keep their domain-specific
 * commit and undo behavior; this component owns only Kumo dialog semantics,
 * TanStack Form state, Zod validation, and accessible field wiring.
 */
export function EditorTextDialog({
	open,
	title,
	description,
	fieldLabel,
	initialValue,
	submitLabel,
	allowEmpty = false,
	maxLength,
	placeholder,
	onOpenChange,
	onSubmit,
}: EditorTextDialogProps) {
	const schema = useMemo(() => {
		let value = z
			.string()
			.trim()
			.max(
				maxLength,
				`${fieldLabel} must be ${maxLength} characters or fewer.`,
			);
		if (!allowEmpty) value = value.min(1, `${fieldLabel} is required.`);
		return z.object({ value });
	}, [allowEmpty, fieldLabel, maxLength]);

	const form = useZodForm({
		schema,
		defaultValues: { value: initialValue },
		onSubmit: ({ value }) => {
			onSubmit(value.value);
			onOpenChange(false);
		},
	});

	useEffect(() => {
		if (open) form.reset({ value: initialValue });
	}, [form, initialValue, open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent size="sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						event.stopPropagation();
						form.handleSubmit();
					}}
				>
					<FormField form={form} name="value" label={fieldLabel}>
						{(field, meta) => (
							<FormInput
								field={field}
								{...meta}
								autoFocus
								maxLength={maxLength}
								placeholder={placeholder}
							/>
						)}
					</FormField>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<form.Subscribe selector={(state) => state.canSubmit}>
							{(canSubmit) => (
								<Button type="submit" disabled={!canSubmit}>
									{submitLabel}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
