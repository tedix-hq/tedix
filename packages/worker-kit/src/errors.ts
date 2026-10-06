import type { Env, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createLogger } from "./logger";

export interface JsonErrorEnvelope {
	error: string;
	message: string;
	path?: string;
}

export interface HonoErrorHandlerOptions {
	service: string;
	includeNotFoundPath?: boolean;
}

/** Install fail-closed JSON 404/500 handling on a top-level Hono Worker app. */
export function installHonoErrorHandlers<E extends Env>(
	app: Hono<E>,
	options: HonoErrorHandlerOptions,
): void {
	const log = createLogger({ component: options.service });
	app.onError((error, context) => {
		log.error("Request failed", { event: "request.failed", error });
		if (error instanceof HTTPException) {
			return context.json<JsonErrorEnvelope>(
				{
					error: "http_error",
					message: error.message,
				},
				error.status,
			);
		}
		return context.json<JsonErrorEnvelope>(
			{
				error: "internal_error",
				message: "Internal Server Error",
			},
			500,
		);
	});

	app.notFound((context) =>
		context.json<JsonErrorEnvelope>(
			{
				error: "not_found",
				message: "Not Found",
				...(options.includeNotFoundPath === false
					? {}
					: { path: context.req.path }),
			},
			404,
		),
	);
}
