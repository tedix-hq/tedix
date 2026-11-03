import { createContext, useContext } from "react";

/** A temporary verification failure suspends existing UI; it grants no cached authority. */
export const WorkspaceVerificationPausedContext = createContext(false);
export function useWorkspaceVerificationPaused(): boolean {
	return useContext(WorkspaceVerificationPausedContext);
}
export function isWorkspaceAccessDenied(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const value = error as {
		code?: unknown;
		status?: unknown;
		statusCode?: unknown;
	};
	return (
		["FORBIDDEN", "UNAUTHORIZED", "NOT_FOUND"].includes(String(value.code)) ||
		[401, 403, 404].includes(Number(value.status ?? value.statusCode))
	);
}
