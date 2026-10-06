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
};

export function FormInput({
	field,
	id,
	descriptionId,
	errorId,
	...props
}: FormInputProps) {
	const hasErrors = Boolean(field.state.meta.errors?.length);
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
