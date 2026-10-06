import type { AnyFieldApi } from "@tanstack/react-form";
import { Textarea } from "@/components/kumo/textarea";

type FormTextareaProps = Omit<
	React.ComponentProps<typeof Textarea>,
	"value" | "onChange" | "onBlur" | "name" | "id"
> & {
	field: AnyFieldApi;
	id: string;
	descriptionId?: string;
	errorId?: string;
};

export function FormTextarea({
	field,
	id,
	descriptionId,
	errorId,
	...props
}: FormTextareaProps) {
	const hasErrors = Boolean(field.state.meta.errors?.length);
	const describedBy =
		[descriptionId, hasErrors ? errorId : undefined]
			.filter(Boolean)
			.join(" ") || undefined;

	return (
		<Textarea
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
