import { useStore } from "@tanstack/react-form";
import { type ComponentProps, useId } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormInput } from "@/components/forms/form-input";
import { exactConfirmationSchema } from "@/components/kumo/forms/exact-confirmation-schema";
import { FormField } from "@/components/kumo/forms/form-field";
import { useZodForm } from "@/components/kumo/forms/use-zod-form";

type TypedConfirmDialogProps = Omit<
	ComponentProps<typeof ConfirmDialog>,
	"children" | "onConfirm" | "confirmDisabled" | "form"
> & {
	expectedName: string;
	nameLabel: string;
	onConfirm: (confirmation: string) => void;
};

export function TypedConfirmDialog(props: TypedConfirmDialogProps) {
	// A new opening or target requires a fresh typed confirmation.
	return props.open ? (
		<TypedConfirmation key={props.expectedName} {...props} />
	) : null;
}

function TypedConfirmation({
	expectedName,
	nameLabel,
	onConfirm,
	...props
}: TypedConfirmDialogProps) {
	const formId = useId();
	const form = useZodForm({
		schema: exactConfirmationSchema(expectedName, nameLabel),
		defaultValues: { confirmation: "" },
		onSubmit: ({ value }) => {
			if (!props.isPending && expectedName) onConfirm(value.confirmation);
		},
	});
	const confirmation = useStore(
		form.store,
		(state) => state.values.confirmation,
	);
	return (
		<ConfirmDialog
			{...props}
			form={formId}
			confirmDisabled={!expectedName || confirmation !== expectedName}
			onConfirm={() => void form.handleSubmit()}
		>
			<form
				id={formId}
				onSubmit={(event) => {
					event.preventDefault();
					void form.handleSubmit();
				}}
			>
				<FormField
					form={form}
					name="confirmation"
					label={`Type ${expectedName} to confirm`}
				>
					{(field, { id, descriptionId, errorId }) => (
						<FormInput
							field={field}
							id={id}
							descriptionId={descriptionId}
							errorId={errorId}
							placeholder={expectedName}
							disabled={props.isPending}
							autoComplete="off"
						/>
					)}
				</FormField>
			</form>
		</ConfirmDialog>
	);
}
