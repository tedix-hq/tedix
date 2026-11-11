import {
	extractBearerToken,
	secureEqual,
} from "@tedix/worker-kit/request-auth";
import type { Env } from "./env";

export const DATABASE_RUNTIME_ADMIN_PATH = "/_tedix/internal/database-runtime";
export const DATABASE_DEPROVISION_ADMIN_PATH =
	"/_tedix/internal/database-runtime/deprovision";
export const DATABASE_STORAGE_ADMIN_PATH =
	"/_tedix/internal/database-runtime/storage";
export const DATABASE_RECOVERY_BOOKMARK_ADMIN_PATH =
	"/_tedix/internal/database-runtime/recovery-bookmark";
export const CMS_RECOVERY_ADMIN_PATH =
	"/_tedix/internal/database-runtime/recovery-captures";
export const CMS_SITE_RESTORE_ADMIN_PATH =
	"/_tedix/internal/database-runtime/site-restores";
export const DATABASE_SCHEMA_DIAGNOSTIC_PATH =
	"/_tedix/internal/database-runtime/schema-diagnostic";
export const MEDIA_BUCKET_ADMIN_PATH = "/_tedix/internal/media-bucket";
export const MEDIA_BUCKET_INTENT_HEADER = "X-Tedix-CMS-Media-Intent";
export const CMS_SITE_ID_HEADER = "X-Tedix-CMS-Site-Id";

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("Content-Type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(body, null, 2), {
		...init,
		headers,
	});
}

const ERROR_MESSAGE_LIMIT = 200;

/** Failure body for an internal admin route. The caller only ever sees a
 * stable code and a truncated `Error.message`; a non-Error throw yields the
 * code itself. Stack traces and raw thrown values go to the Worker log. */
export function errorResponse(
	status: number,
	code: string,
	cause: unknown,
): Response {
	console.error(`cms-runtime internal admin ${code}`, cause);
	const message =
		cause instanceof Error
			? cause.message.slice(0, ERROR_MESSAGE_LIMIT) || code
			: code;
	return jsonResponse(
		{ ok: false, success: false, code, error: message },
		{ status },
	);
}

/**
 * Whether the request carries the internal admin token. Async so the
 * comparison is constant-time; the name differs from the old synchronous check
 * so a call site that forgets `await` fails to compile instead of passing.
 */
export async function verifyInternalCmsRequest(
	request: Request,
	env: Env,
): Promise<boolean> {
	const token = env.CMS_INTERNAL_AUTH_TOKEN;
	if (!token) return false;
	if (
		await secureEqual(request.headers.get("X-Tedix-CMS-Internal-Auth"), token)
	)
		return true;
	return secureEqual(
		extractBearerToken(request.headers.get("Authorization")),
		token,
	);
}
