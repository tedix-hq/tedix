import * as z from "zod";

/** Schema for destructive actions that require an exact, visible identifier. */
export function exactConfirmationSchema(expected: string, label: string) {
	return z.object({
		confirmation: z.string().refine((value) => value === expected, {
			message: `${label} does not match.`,
		}),
	});
}
