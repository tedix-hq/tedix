import type { AnyFieldApi } from "@tanstack/react-form";
import type { ComponentProps, ReactNode } from "react";
import {
	Select,
	SelectContent,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";

type FormSelectProps = {
	field: AnyFieldApi;
	id: string;
	placeholder?: string;
	descriptionId?: string;
	errorId?: string;
	disabled?: boolean;
	className?: string;
	children: ReactNode;
	items?: ComponentProps<typeof Select>["items"];
};

export function FormSelect({
	field,
	id,
	placeholder,
	descriptionId,
	errorId,
	disabled,
	className,
	children,
	items,
}: FormSelectProps) {
	const hasErrors = Boolean(field.state.meta.errors?.length);
	const describedBy =
		[descriptionId, hasErrors ? errorId : undefined]
			.filter(Boolean)
			.join(" ") || undefined;
	const value = field.state.value ?? "";

	return (
		<Select
			items={items}
			value={value as string}
			onValueChange={(nextValue) => field.handleChange(nextValue)}
			disabled={disabled}
		>
			<SelectTrigger
				className={className ?? "w-full"}
				id={id}
				aria-labelledby={`${id}-label`}
				aria-invalid={hasErrors || undefined}
				aria-describedby={describedBy}
				aria-errormessage={hasErrors ? errorId : undefined}
			>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent>{children}</SelectContent>
		</Select>
	);
}
