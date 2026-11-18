import {
	errorMessage,
	isAuthorizationError,
	isNotFoundError,
} from "@/lib/orpc-error";

/**
 * Why the server refused a file action, in a sentence a person can act on.
 * `action` completes "You … to <action>", for example "move this file".
 * A missing permission and a file or workspace the person can no longer open
 * get their own wording; any other refusal shows the server's reason as sent.
 */
export function fileActionRefusal(error: unknown, action: string): string {
	if (isAuthorizationError(error))
		return `You are not allowed to ${action}. Ask an owner of the workspace for edit access.`;
	if (isNotFoundError(error))
		return `You cannot ${action}: the file or the workspace is no longer available to you.`;
	return errorMessage(
		error,
		`Something went wrong and we could not ${action}.`,
	);
}
