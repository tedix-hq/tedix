import { OS_OUTPUT_CONTENT_MAX_BYTES } from "@tedix/api-contract/utils/os-output-limits";

/**
 * Why a refused save will be refused again however often it is sent, in words
 * for the person editing; empty for a failure that may pass by itself (no
 * network, a timeout, a server fault), which is worth trying again quietly.
 */
export function lastingSaveFailure(error: unknown): string {
	const { code, message } = (error ?? {}) as {
		code?: unknown;
		message?: unknown;
	};
	if (code === "too_large")
		return `This file is over the ${OS_OUTPUT_CONTENT_MAX_BYTES / 1e6} MB limit, so new changes are not saved. Remove or shrink large images.`;
	if (code === "not_permitted")
		return "You can no longer edit this file, so new changes are not saved.";
	if (code === "bad_arguments")
		return typeof message === "string" && message !== code
			? message
			: "This file cannot be saved as it is, so new changes are not saved.";
	return "";
}
