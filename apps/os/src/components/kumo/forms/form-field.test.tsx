import type { AnyFieldApi } from "@tanstack/react-form";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { type FormFieldRenderMeta, FormField } from "./form-field";

type FieldState = {
	errors?: unknown[];
	isTouched?: boolean;
};

/**
 * Minimal stand-in for the TanStack Form surface `FormField` consumes: a
 * `state.isSubmitted` flag and a `Field` render-prop component. Keeps the test
 * on the adapter's own contract rather than on TanStack internals.
 */
function fakeForm({
	errors = [],
	isSubmitted = false,
	isTouched = false,
}: FieldState & { isSubmitted?: boolean } = {}) {
	const field = {
		name: "email",
		state: { meta: { errors, isTouched }, value: "" },
	} as unknown as AnyFieldApi;

	return {
		state: { isSubmitted },
		Field: (({ children }: { children: (field: AnyFieldApi) => ReactNode }) =>
			children(field)) as never,
	};
}

describe("FormField adapter", () => {
	it("keeps the label/control/description id wiring its call sites depend on", () => {
		let seen: FormFieldRenderMeta | undefined;

		const html = renderToStaticMarkup(
			<FormField
				description="We only use this for account recovery."
				form={fakeForm()}
				label="Email address"
				name="email"
			>
				{(_field, meta) => {
					seen = meta;
					return <input aria-labelledby={`${meta.id}-label`} id={meta.id} />;
				}}
			</FormField>,
		);

		expect(seen).toBeDefined();
		expect(seen?.invalid).toBe(false);
		expect(seen?.showErrors).toBe(false);
		expect(seen?.descriptionId).toBe(`${seen?.id}-description`);
		expect(seen?.errorId).toBeUndefined();

		expect(html).toContain(`id="${seen?.id}-label"`);
		expect(html).toContain(`for="${seen?.id}"`);
		expect(html).toContain(`aria-labelledby="${seen?.id}-label"`);
		expect(html).toContain(`id="${seen?.id}-description"`);
		expect(html).toContain("We only use this for account recovery.");
	});

	it("pins label, description, and error to the Tedix type roles", () => {
		const html = renderToStaticMarkup(
			<FormField
				description="Helper"
				form={fakeForm()}
				label="Slug"
				name="slug"
			>
				{(_field, meta) => <input id={meta.id} />}
			</FormField>,
		);

		expect(html).toContain("type-tedix-body");
		expect(html).toContain("type-tedix-control");
		expect(html).not.toContain("text-base");
	});

	it("shows Kumo's optional indicator", () => {
		const html = renderToStaticMarkup(
			<FormField form={fakeForm()} label="Website" name="website" optional>
				{(_field, meta) => <input id={meta.id} />}
			</FormField>,
		);

		expect(html).toContain("(optional)");
	});

	it("normalizes string and object errors through Kumo's normalizer", () => {
		let seen: FormFieldRenderMeta | undefined;

		const html = renderToStaticMarkup(
			<FormField
				description="Hidden while an error is showing."
				form={fakeForm({
					errors: ["Required.", { message: "Must be an email." }],
					isTouched: true,
				})}
				label="Email address"
				name="email"
			>
				{(_field, meta) => {
					seen = meta;
					return <input id={meta.id} />;
				}}
			</FormField>,
		);

		expect(seen?.invalid).toBe(true);
		expect(seen?.showErrors).toBe(true);
		expect(seen?.errorId).toBe(`${seen?.id}-error`);
		expect(seen?.descriptionId).toBeUndefined();
		expect(html).toContain("Required.; Must be an email.");
		expect(html).not.toContain("Hidden while an error is showing.");
	});

	it("holds errors back until the field is touched or the form is submitted", () => {
		const untouched = renderToStaticMarkup(
			<FormField form={fakeForm({ errors: ["Required."] })} name="email">
				{(_field, meta) => <input id={meta.id} />}
			</FormField>,
		);
		const submitted = renderToStaticMarkup(
			<FormField
				form={fakeForm({ errors: ["Required."], isSubmitted: true })}
				name="email"
			>
				{(_field, meta) => <input id={meta.id} />}
			</FormField>,
		);

		expect(untouched).not.toContain("Required.");
		expect(submitted).toContain("Required.");
	});

	it("keeps emitting the orientation hook", () => {
		const html = renderToStaticMarkup(
			<FormField form={fakeForm()} name="email" orientation="horizontal">
				{(_field, meta) => <input id={meta.id} />}
			</FormField>,
		);

		expect(html).toContain('data-orientation="horizontal"');
	});
});
