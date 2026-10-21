// @vitest-environment node
import { spawn } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { waitForFixtureServer } from "./fixture-server-readiness";

const servers: Server[] = [];
async function serve(listener: RequestListener) {
	const server = createServer(listener);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No HTTP port");
	return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

describe("browser fixture readiness", () => {
	it("waits through HTTP startup failures until the fixture is ready", async () => {
		let requests = 0;
		const url = await serve((_request, response) => {
			requests++;
			response.writeHead(requests > 2 ? 200 : 503).end();
		});
		await waitForFixtureServer(url, { timeoutMs: 1_000, pollIntervalMs: 10 });
		expect(requests).toBe(3);
	});

	it("reports the last HTTP failure when the wall deadline expires", async () => {
		const url = await serve((_request, response) => {
			response.writeHead(503, "Fixture compiling").end();
		});
		await expect(
			waitForFixtureServer(url, { timeoutMs: 500, pollIntervalMs: 20 }),
		).rejects.toThrow("Last response: HTTP 503 Fixture compiling");
	});

	it("aborts stalled requests and keeps the overall readiness deadline", async () => {
		let requests = 0;
		const url = await serve(() => {
			requests++;
		});
		const started = performance.now();
		await expect(
			waitForFixtureServer(url, {
				timeoutMs: 600,
				requestTimeoutMs: 80,
				pollIntervalMs: 10,
			}),
		).rejects.toThrow(/not ready within 600ms.*Last error:.*AbortError/);
		expect(requests).toBeGreaterThan(1);
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("fails on child exit while an HTTP readiness request is still pending", async () => {
		const url = await serve(() => {});
		const child = spawn(process.execPath, [
			"-e",
			"setTimeout(() => process.exit(7), 50)",
		]);
		const exited = new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code) => resolve(code ?? -1));
		});
		const started = performance.now();
		try {
			await expect(
				waitForFixtureServer(url, {
					server: {
						get exitCode() {
							return child.exitCode;
						},
						exited,
					},
					timeoutMs: 5_000,
					requestTimeoutMs: 4_000,
				}),
			).rejects.toThrow("exited early with code 7");
			expect(performance.now() - started).toBeLessThan(2_000);
		} finally {
			child.kill();
			await exited;
		}
	});
});
