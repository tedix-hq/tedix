"use client";

import {
	fieldVariants,
	normalizeFieldError,
} from "@cloudflare/kumo/components/field";
import { Label as KumoLabel } from "@cloudflare/kumo/components/label";
import { Field } from "@cloudflare/kumo/primitives/field";
import type { AnyFieldApi, FieldComponent } from "@tanstack/react-form";
import { type ReactNode, useId } from "react";

/**
 * Why this adapter exists
 * -----------------------
 * `FormField` binds one TanStack Form field to the Kumo field chrome: label,
 * optional indicator, description, error, and the ids that wire them together
 * for assistive tech. Feature code supplies only the control.
 *
 * What comes from Kumo now
 * ------------------------
 * The pieces Kumo's *styled* `components/field` module ships are imported
 * rather than reimplemented:
 *
 * - `normalizeFieldError` replaces a hand-rolled `errorMessage()` normalizer.
 * - `fieldVariants()` replaces hand-written grid classes, and brings its
 *   checkbox/switch row handling with it.
 * - `components/label`'s `Label` (via `asContent`) replaces a hand-built
 *   "(optional)" indicator — the same composition the styled `Field` uses
 *   internally.
 *
 * Why not the styled `<Field>` component itself
 * ---------------------------------------------
 * Two hard blockers, both about escape hatches Kumo's `Field` does not expose:
 *
 * 1. **Ids.** `Field` renders its label, description, and error internally and
 *    accepts no `id`, so the ids this component hands to its render prop
 *    (`meta.id`, `meta.descriptionId`, `meta.errorId`) and the `${id}-label`
 *    contract that `components/forms/form-input.tsx` and `form-textarea.tsx`
 *    consume via `aria-labelledby` could not be produced. Base UI generates its
 *    own control id, which would point `htmlFor` at an element that does not
 *    exist, because the wrapped control is a plain `Input`, not a
 *    `Field.Control`.
 * 2. **Typography.** `Field` hard-codes `text-base` on the label and `text-sm`
 *    on the description/error with no `className` prop. That bypasses the
 *    Tedix `.type-tedix-*` roles this adapter layer exists to enforce.
 *
 * So the layout/label/error *logic* comes from Kumo's styled module, while the
 * structure stays on the Base UI `primitives/field` elements that accept ids
 * and class names. Revisit if Kumo ever gives `Field` id or class overrides.
 */

export type FormFieldRenderMeta = {
	id: string;
	descriptionId?: string;
	errorId?: string;
	invalid: boolean;
	showErrors: boolean;
};

type FormApiWithField = {
	state: { isSubmitted: boolean };
	Field: FieldComponent<
		any,
		any,
		any,
		any,
		any,
		any,
		any,
		any,
		any,
		any,
		any,
		any
	>;
};

export type FormFieldProps = {
	form: FormApiWithField;
	name: string;
	label?: string;
	description?: string;
	orientation?: "vertical" | "horizontal" | "responsive";
	validators?: unknown;
	optional?: boolean;
	children: (field: AnyFieldApi, meta: FormFieldRenderMeta) => ReactNode;
};

/**
 * Reduces one TanStack Form error entry to a renderable string via Kumo's
 * `normalizeFieldError`, which accepts a string or a `{ message }` object.
 * Anything else (a Zod issue shape Kumo does not recognise, a thrown value) is
 * stringified rather than handed to React as an object.
 */
function errorText(error: unknown): string | undefined {
	if (!error) return undefined;
	const normalized = normalizeFieldError(
		error as Parameters<typeof normalizeFieldError>[0],
	);
	if (!normalized) return undefined;
	return typeof normalized.message === "string"
		? normalized.message
		: String(error);
}

export function FormField({
	form,
	name,
	label,
	description,
	orientation = "vertical",
	validators,
	optional,
	children,
}: FormFieldProps) {
	const reactId = useId();
	const fieldId = `${name}-${reactId}`;
	const labelId = `${fieldId}-label`;

	return (
		<form.Field name={name} validators={validators as never}>
			{(field) => {
				const errors = field.state.meta.errors ?? [];
				const showErrors =
					errors.length > 0 &&
					(field.state.meta.isTouched || form.state.isSubmitted);
				const invalid = showErrors && errors.length > 0;
				const message = errors.map(errorText).filter(Boolean).join("; ");
				const errorId = showErrors && message ? `${fieldId}-error` : undefined;
				const descriptionId =
					description && !errorId ? `${fieldId}-description` : undefined;

				return (
					<Field.Root
						className={fieldVariants()}
						data-orientation={orientation}
					>
						<Field.Label
							id={labelId}
							htmlFor={fieldId}
							className="m-0 select-none font-medium text-kumo-default type-tedix-body"
						>
							<KumoLabel asContent showOptional={optional}>
								{label ?? name}
							</KumoLabel>
						</Field.Label>
						{children(field, {
							id: fieldId,
							descriptionId,
							errorId,
							invalid,
							showErrors,
						})}
						{showErrors && message ? (
							<Field.Error
								id={errorId}
								className="col-span-full text-kumo-danger type-tedix-control"
								match
							>
								{message}
							</Field.Error>
						) : description ? (
							<Field.Description
								id={descriptionId}
								className="col-span-full text-kumo-subtle type-tedix-control"
							>
								{description}
							</Field.Description>
						) : null}
					</Field.Root>
				);
			}}
		</form.Field>
	);
}
