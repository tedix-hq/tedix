"use client";

import * as z from "zod";

/** Bind an existing JSON text parser to a Zod transform without duplicating errors. */
export function jsonTextSchema<T>(parse: (value: string) => T) {
	return z.string().transform((value, context): T => {
		try {
			return parse(value);
		} catch (error) {
			context.addIssue({
				code: "custom",
				message: error instanceof Error ? error.message : "Enter valid JSON.",
			});
			return z.NEVER;
		}
	});
}
