import { parse } from "acorn";
import { serviceBindingFetch } from "@tedix/api-client/internal";
import {
	AppRuntimeFilesSchema,
	AppRuntimeConfigSchema,
} from "@tedix/api-contract/schemas/os-app-runtime";
import { createError, ErrorCodes } from "../rpc/orpc";

/** Parse every JavaScript file before asking the isolated runtime to link App. */
export async function validateAppSource(
	env: Pick<CloudflareEnv, "TEDI_SERVICE">,
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
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`${path}:${syntax.loc?.line ?? 1}:${(syntax.loc?.column ?? 0) + 1}: ${syntax.message}`,
			);
		}
	}
	const response = await serviceBindingFetch(env.TEDI_SERVICE)(
		"https://tedi-runtime/__internal/workspace-app/validate",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			body: JSON.stringify({
				files,
				compatibilityDate: config.compatibilityDate,
			}),
		},
	);
	if (response.status === 400)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			(await response.text()).slice(0, 4000),
		);
	if (!response.ok)
		throw createError(
			ErrorCodes.BAD_GATEWAY,
			"App validation unavailable; source was not saved",
		);
}
