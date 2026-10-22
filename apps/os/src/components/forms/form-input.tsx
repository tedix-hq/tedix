import type { AnyFieldApi } from "@tanstack/react-form";
import { Input } from "@/components/kumo/input";

type FormInputProps = Omit<
	React.ComponentProps<typeof Input>,
	"value" | "onChange" | "onBlur" | "name" | "id"
> & {
	field: AnyFieldApi;
	id: string;
	descriptionId?: string;
	errorId?: string;
	invalid?: boolean;
	showErrors?: boolean;
};

export function FormInput({
	field,
	id,
	descriptionId,
	errorId,
	invalid = Boolean(field.state.meta.errors?.length),
	showErrors = true,
	...props
}: FormInputProps) {
	const hasErrors = invalid && showErrors;
	const describedBy =
		[descriptionId, hasErrors ? errorId : undefined]
			.filter(Boolean)
			.join(" ") || undefined;

	return (
		<Input
			{...props}
			id={id}
			name={field.name}
			value={(field.state.value ?? "") as string}
			onBlur={field.handleBlur}
			onChange={(event) => field.handleChange(event.target.value)}
			aria-labelledby={`${id}-label`}
			aria-invalid={hasErrors || undefined}
			aria-describedby={describedBy}
			aria-errormessage={hasErrors ? errorId : undefined}
		/>
	);
}
