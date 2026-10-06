/**
 * Zero-account local API lane: a dev-only Vite middleware that answers the
 * SPA's `/api/*` traffic from `local-fixtures.ts` — no Cloudflare account, no
 * Descope tenant, no live credentials. Authenticated development against a
 * real deployment uses the OS Worker, not this fixture middleware.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import {
	handleLocalRpc,
	LOCAL_WIDGET_APP_SLUG,
	LOCAL_WIDGET_RESOURCE_URI,
} from "./local-fixtures";

const SSE_STREAM_PATH =
	/^\/api\/kernel\/runtime\/conversations\/[^/]+\/events\/stream(?:\?|$)/;

const LOCAL_WIDGET_HTML = `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Revenue dashboard</title>
		<style>
			:root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
			body { margin: 0; padding: 20px; background: Canvas; color: CanvasText; }
			main { display: grid; gap: 16px; }
			.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
			article { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 10px; padding: 14px; }
			strong { display: block; margin-top: 6px; font-size: 1.35rem; }
		</style>
	</head>
	<body>
		<main data-local-revenue-gadget>
			<header><h1>Revenue dashboard</h1><p>Committed week 32 snapshot</p></header>
			<section class="metrics" aria-label="Revenue metrics">
				<article>Revenue<strong>MXN 412,000</strong></article>
				<article>Week over week<strong>+6%</strong></article>
				<article>Orders<strong>541</strong></article>
			</section>
		</main>
	</body>
</html>`;

export function localWidgetResource(
	appSlug: string | null,
	resourceUri: string | null,
): unknown | null {
	if (
		appSlug !== LOCAL_WIDGET_APP_SLUG ||
		resourceUri !== LOCAL_WIDGET_RESOURCE_URI
	) {
		return null;
	}
	return {
		contents: [
			{
				uri: LOCAL_WIDGET_RESOURCE_URI,
				mimeType: "text/html;profile=mcp-app",
				text: LOCAL_WIDGET_HTML,
			},
		],
	};
}

const readBody = (req: IncomingMessage): Promise<string> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
};

async function serveLocalApi(
	req: IncomingMessage,
	res: ServerResponse,
	url: string,
): Promise<void> {
	if (url.startsWith("/widgets/resource")) {
		if ((req.method ?? "GET") !== "GET") {
			sendJson(res, 405, { error: "Local widget resources are read-only" });
			return;
		}
		const params = new URL(url, "http://localhost").searchParams;
		const payload = localWidgetResource(params.get("app"), params.get("uri"));
		if (!payload) {
			sendJson(res, 404, { error: "Local widget resource not found" });
			return;
		}
		sendJson(res, 200, payload);
		return;
	}

	if (SSE_STREAM_PATH.test(url)) {
		// A valid, empty, immediately-closed replay: the chat hook treats it as
		// settled and the durable reads (readMessages/readRunSet) carry the data.
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
		});
		res.write("retry: 60000\n\n");
		res.end();
		return;
	}

	if (url.startsWith("/api/rpc/")) {
		const method = req.method ?? "GET";
		let envelope: unknown;
		try {
			if (method === "GET") {
				const data = new URL(url, "http://localhost").searchParams.get("data");
				envelope = data ? JSON.parse(data) : undefined;
			} else {
				const raw = await readBody(req);
				envelope = raw ? JSON.parse(raw) : undefined;
			}
		} catch {
			sendJson(res, 400, {
				json: {
					defined: false,
					inferable: false,
					code: "BAD_REQUEST",
					message: "Malformed RPC request envelope",
				},
			});
			return;
		}
		const result = handleLocalRpc(url, method, envelope);
		if (result) {
			sendJson(res, result.status, result.body);
			return;
		}
		// Loud gap: an uncovered procedure fails fast as a parseable oRPC error
		// instead of hanging or silently returning an empty page.
		sendJson(res, 404, {
			json: {
				defined: false,
				inferable: false,
				code: "NOT_FOUND",
				message: `No local fixture handler for ${url.split("?")[0]}`,
			},
		});
		return;
	}

	sendJson(res, 404, {
		error: `Unhandled local /api path: ${url.split("?")[0]}`,
	});
}

export function localApiPlugin(): Plugin {
	return {
		name: "tedix-os-local-api",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const url = req.url ?? "";
				if (url.split("?")[0] === "/health") {
					res.setHeader("cache-control", "no-store");
					sendJson(res, 200, {
						status: "ok",
						runtime: "fixtures",
						data: "in-memory",
						auth: "disabled",
					});
					return;
				}
				if (!url.startsWith("/api/") && !url.startsWith("/widgets/resource")) {
					next();
					return;
				}
				serveLocalApi(req, res, url).catch((error: unknown) => {
					console.error("[local-api] request failed", error);
					if (!res.headersSent) {
						sendJson(res, 500, {
							json: {
								defined: false,
								inferable: false,
								code: "INTERNAL_SERVER_ERROR",
								message: "Local fixture middleware failed",
							},
						});
					} else {
						res.end();
					}
				});
			});
		},
	};
}
