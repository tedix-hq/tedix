import { extractTokenFromCookie } from "@tedix/auth/utils";
import { extractBearerToken } from "@tedix/worker-kit/request-auth";

/** Resolve the API's shared Bearer-or-browser-session credential shape. */
export function extractRequestToken(
	header: (name: string) => string | null | undefined,
): string | null {
	return (
		extractBearerToken(header("Authorization")) ??
		extractTokenFromCookie(header("Cookie"), "DS") ??
		extractTokenFromCookie(header("Cookie"), "id_token")
	);
}
