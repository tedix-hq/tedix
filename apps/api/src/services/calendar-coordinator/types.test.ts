import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { requestJson } from "./types";

describe("calendar provider requests", () => {
	it.each([301, 302, 303, 307, 308])(
		"does not follow HTTP %i redirects for reads or mutations",
		async (status) => {
			const received: string[] = [];
			const server = createServer((request, response) => {
				received.push(`${request.method} ${request.url}`);
				request.resume();
				if (request.url === "/redirect") {
					response.writeHead(status, { Location: "/target" });
				} else {
					response.writeHead(200, { "Content-Type": "application/json" });
				}
				response.end("{}");
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			try {
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Missing test port");
				const baseUrl = `http://127.0.0.1:${address.port}`;
				await expect(
					requestJson("fictional-token", `${baseUrl}/target`),
				).resolves.toEqual({});
				received.length = 0;
				for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
					await expect(
						requestJson("fictional-token", `${baseUrl}/redirect`, {
							method,
							redirect: "follow",
							...(method === "POST" || method === "PATCH"
								? { body: "{}" }
								: {}),
						}),
					).rejects.toThrow(`Calendar request failed (${status})`);
				}
				expect(received).toEqual([
					"GET /redirect",
					"POST /redirect",
					"PATCH /redirect",
					"DELETE /redirect",
				]);
			} finally {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeAllConnections();
				});
			}
		},
	);
});
