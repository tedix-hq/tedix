import type { BaseContext } from "../rpc/orpc";
import { createError, ErrorCodes } from "../rpc/orpc";
import {
	parseSkillRuntimeErrorBody,
	skillRuntimeErrorCode,
} from "./skill-runtime-error";

/** Shared service-binding client for canonical skill workflow operations. */
export async function callSkillRuntime<T>(
	context: Pick<BaseContext, "env">,
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	const env = context.env as {
		SKILL_RUNTIME?: Fetcher;
		PLATFORM_SERVICE_TOKEN?: string;
	};
	if (!env.SKILL_RUNTIME) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"SKILL_RUNTIME service binding not configured",
		);
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Service-Binding": "true",
	};
	if (env.PLATFORM_SERVICE_TOKEN) {
		headers.Authorization = `Bearer ${env.PLATFORM_SERVICE_TOKEN}`;
	}
	const response = await env.SKILL_RUNTIME.fetch(
		`https://skill-runtime${path}`,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
		},
	);
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		const runtimeError = parseSkillRuntimeErrorBody(text);
		const runtimeLabel = runtimeError.code
			? `${runtimeError.code}: `
			: `skill-runtime ${path} failed (${response.status}): `;
		throw createError(
			skillRuntimeErrorCode(response.status),
			`${runtimeLabel}${runtimeError.message ?? (text || response.statusText)}`,
			{
				service: "skill-runtime",
				path,
				status: response.status,
				runtimeCode: runtimeError.code,
			},
		);
	}
	return response.json() as Promise<T>;
}
