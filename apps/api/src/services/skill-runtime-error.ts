import { type ErrorCode, ErrorCodes } from "../rpc/orpc";

export function skillRuntimeErrorCode(status: number): ErrorCode {
	switch (status) {
		case 400:
			return ErrorCodes.BAD_REQUEST;
		case 401:
			return ErrorCodes.UNAUTHORIZED;
		case 403:
			return ErrorCodes.FORBIDDEN;
		case 404:
			return ErrorCodes.NOT_FOUND;
		case 409:
			return ErrorCodes.CONFLICT;
		case 429:
			return ErrorCodes.TOO_MANY_REQUESTS;
		default:
			return ErrorCodes.BAD_GATEWAY;
	}
}

export function parseSkillRuntimeErrorBody(body: string): {
	code?: string;
	message?: string;
} {
	try {
		const parsed = JSON.parse(body) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return {};
		const record = parsed as Record<string, unknown>;
		return {
			code: typeof record.error === "string" ? record.error : undefined,
			message: typeof record.message === "string" ? record.message : undefined,
		};
	} catch {
		return {};
	}
}
