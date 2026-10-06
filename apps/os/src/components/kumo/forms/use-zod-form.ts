"use client";

import type { StandardSchemaV1 } from "@tanstack/react-form";
import {
	revalidateLogic,
	standardSchemaValidators,
	useForm,
} from "@tanstack/react-form";
import type { z } from "zod";

export type UseZodFormOptions<TSchema extends z.ZodTypeAny> = {
	schema: TSchema;
	defaultValues: z.input<TSchema>;
	onSubmit: (context: { value: z.output<TSchema> }) => void | Promise<void>;
	validateOn?: "change" | "blur" | "submit";
	validateAfterSubmit?: "change" | "blur" | "submit";
};

/** TanStack Form adapter that preserves Zod input/output transformations. */
export function useZodForm<TSchema extends z.ZodTypeAny>({
	schema,
	defaultValues,
	onSubmit,
	validateOn = "change",
	validateAfterSubmit = "change",
}: UseZodFormOptions<TSchema>) {
	const standardSchema = schema as StandardSchemaV1<
		z.input<TSchema>,
		z.output<TSchema>
	>;
	const validators = {
		onDynamic: ({ value }: { value: z.input<TSchema> }) =>
			standardSchemaValidators.validate(
				{ value, validationSource: "form" },
				standardSchema,
			),
	};

	return useForm({
		defaultValues,
		validationLogic: revalidateLogic({
			mode: validateOn,
			modeAfterSubmission: validateAfterSubmit,
		}),
		validators,
		onSubmit: ({ value }) => onSubmit({ value: schema.parse(value) }),
	});
}
