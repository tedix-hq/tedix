import { parse } from "acorn";
import {
	AppRuntimeFilesSchema,
	AppRuntimeConfigSchema,
} from "../schemas/os-app-runtime";
export class AppSourceValidationError extends Error {
	constructor(
		readonly code: "BAD_REQUEST" | "BAD_GATEWAY",
		message: string,
	) {
		super(message);
	}
}

/** Parse every JavaScript file before asking the isolated runtime to link App. */
export async function validateAppSource(
	dryLoad: (
		files: Record<string, string>,
		compatibilityDate: string | undefined,
	) => Promise<Response>,
	files: Record<string, string>,
	compatibilityDate?: unknown,
) {
	AppRuntimeFilesSchema.parse(files);
	const config = AppRuntimeConfigSchema.parse({
		version: 1,
		compatibilityDate,
	});
	for (const [path, source] of Object.entries(files)) {
		if (!path.endsWith(".js")) continue;
		try {
			parse(source, {
				ecmaVersion: "latest",
				sourceType: "module",
				locations: true,
			});
		} catch (error) {
			const syntax = error as SyntaxError & {
				loc?: { line: number; column: number };
			};
			throw new AppSourceValidationError(
				"BAD_REQUEST",
				`${path}:${syntax.loc?.line ?? 1}:${(syntax.loc?.column ?? 0) + 1}: ${syntax.message}`,
			);
		}
	}
	const response = await dryLoad(files, config.compatibilityDate);
	if (response.status === 400)
		throw new AppSourceValidationError(
			"BAD_REQUEST",
			(await response.text()).slice(0, 4000),
		);
	if (!response.ok)
		throw new AppSourceValidationError(
			"BAD_GATEWAY",
			"App validation unavailable; source was not saved",
		);
}
