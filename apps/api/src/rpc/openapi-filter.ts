import { getOpenAPIMeta } from "@orpc/openapi";

export const PUBLIC_REST_TAG = "REST";

/** Is this exact procedure part of the supported public REST contract? */
export function isPublicProcedure(
	contract: Parameters<typeof getOpenAPIMeta>[0],
): boolean {
	const tags = getOpenAPIMeta(contract)?.tags ?? [];
	return tags.includes(PUBLIC_REST_TAG) && !tags.includes("internal");
}
