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

export function isInternalCmsRequest(request: Request, env: Env): boolean {
	const token = env.CMS_INTERNAL_AUTH_TOKEN;
	if (!token) return false;
	const header = request.headers.get("X-Tedix-CMS-Internal-Auth");
	if (header === token) return true;
	const authorization = request.headers.get("Authorization");
	return authorization === `Bearer ${token}`;
}
