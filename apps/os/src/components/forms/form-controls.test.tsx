import type { AnyFieldApi } from "@tanstack/react-form";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { FormField } from "@/components/kumo/forms/form-field";
import { FormInput } from "./form-input";
import { FormTextarea } from "./form-textarea";

for (const Control of [FormInput, FormTextarea]) {
	describe(Control.name, () => {
		it.each([
			{ errors: [], isTouched: false, isSubmitted: false, visible: false },
			{
				errors: ["Required."],
				isTouched: false,
				isSubmitted: false,
				visible: false,
			},
			{
				errors: ["Required."],
				isTouched: true,
				isSubmitted: false,
				visible: true,
			},
			{
				errors: ["Required."],
				isTouched: false,
				isSubmitted: true,
				visible: true,
			},
		])(
			"consumes validation metadata for %j",
			({ errors, isTouched, isSubmitted, visible }) => {
				const warning = vi.spyOn(console, "error").mockImplementation(() => {});
				const field = {
					name: "title",
					state: { value: "Draft", meta: { errors, isTouched } },
					handleBlur: vi.fn(),
					handleChange: vi.fn(),
				} as unknown as AnyFieldApi;
				const form = {
					state: { isSubmitted },
					Field: (({
						children,
					}: {
						children: (field: AnyFieldApi) => React.ReactNode;
					}) => children(field)) as never,
				};
				try {
					let id = "";
					const html = renderToStaticMarkup(
						<FormField
							form={form}
							name="title"
							label="Title"
							description="Choose a title."
						>
							{(field, meta) => {
								id = meta.id;
								return (
									<Control
										field={field}
										{...meta}
										required
										placeholder="Title"
									/>
								);
							}}
						</FormField>,
					);
					expect(warning).not.toHaveBeenCalled();
					expect(html).not.toMatch(/\s(?:invalid|showerrors)=/i);
					expect(html).toContain('name="title"');
					expect(html).toContain('placeholder="Title"');
					expect(html).toContain("required");
					expect(html).toContain("Draft");
					expect(html).toContain(`aria-labelledby="${id}-label"`);
					expect(html).toContain(
						`aria-describedby="${id}-${visible ? "error" : "description"}"`,
					);
					if (visible) {
						expect(html).toContain('aria-invalid="true"');
						expect(html).toContain(`aria-errormessage="${id}-error"`);
						expect(html).toContain("Required.");
					} else {
						expect(html).not.toContain("aria-invalid");
						expect(html).not.toContain("aria-errormessage");
						expect(html).not.toContain("Required.");
					}
				} finally {
					warning.mockRestore();
				}
			},
		);
	});
}
