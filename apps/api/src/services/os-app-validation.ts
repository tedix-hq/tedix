import { serviceBindingFetch } from "@tedix/api-client/internal";
import {
	validateAppSource as validateSource,
	AppSourceValidationError,
} from "@tedix/api-contract/utils/app-source-validation";
import { createError } from "../rpc/orpc";

export async function validateAppSource(
	env: Pick<CloudflareEnv, "TEDI_SERVICE">,
	files: Record<string, string>,
	compatibilityDate?: unknown,
) {
	try {
		await validateSource(
			(source, date) =>
				serviceBindingFetch(env.TEDI_SERVICE)(
					"https://tedi-runtime/__internal/workspace-app/validate",
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify({ files: source, compatibilityDate: date }),
					},
				),
			files,
			compatibilityDate,
		);
	} catch (error) {
		if (error instanceof AppSourceValidationError)
			throw createError(error.code, error.message);
		throw error;
	}
}
