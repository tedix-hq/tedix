import type { SpawnOptions } from "bun";
import {
	waitForFixtureBrowser,
	waitForFixtureServer,
} from "../dev/fixture-server-readiness";

/**
 * The OS fixture server a browser spec runs against. With `OS_FIXTURE_ORIGIN`
 * set (by `run-specs.ts`), the spec reuses that server and leaves it running.
 * Otherwise it starts its own Vite dev server and stops it in `stop()`.
 */
export type FixtureServer = {
	origin: string;
	/** Exit code of an owned server; null while it runs or when it is shared. */
	exitCode(): number | null;
	exited?: Promise<number>;
	stop(): Promise<void>;
};

type Output = SpawnOptions.OptionsObject<
	SpawnOptions.Writable,
	SpawnOptions.Readable,
	SpawnOptions.Readable
>["stdout"];

/**
 * The port an owned fixture server listens on: `TEDIX_BROWSER_TEST_PORT` when
 * set, else a free one, so parallel jobs never collide on a fixed port.
 */
export function fixturePort(): string {
	const pinned = process.env.TEDIX_BROWSER_TEST_PORT;
	if (pinned) return pinned;
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = String(probe.port!);
	probe.stop();
	return port;
}

export async function startFixtureServer(
	readyPath = "/",
	{
		shared = true,
		stdout = "inherit",
		stderr = "inherit",
	}: {
		/** False for a spec that writes fixture state other specs would see. */
		shared?: boolean;
		stdout?: Output;
		stderr?: Output;
	} = {},
): Promise<FixtureServer> {
	const external = shared ? process.env.OS_FIXTURE_ORIGIN : undefined;
	if (external) {
		const origin = external.replace(/\/$/, "");
		await waitForFixtureServer(`${origin}${readyPath}`);
		return { origin, exitCode: () => null, stop: async () => {} };
	}
	const port = fixturePort();
	const origin = `http://127.0.0.1:${port}`;
	const deadline = performance.now() + 90_000;
	const remaining = () => {
		const milliseconds = deadline - performance.now();
		if (milliseconds <= 0)
			throw new Error(`Fixture server ${origin}: not ready within 90000ms`);
		return milliseconds;
	};
	const server = Bun.spawn(
		[
			"../../node_modules/.bin/vp",
			"dev",
			"--port",
			port,
			"--strictPort",
			"--host",
			"127.0.0.1",
		],
		{
			cwd: new URL("../", import.meta.url).pathname,
			env: { ...process.env, TEDIX_BROWSER_FIXTURE: "1" },
			stdout,
			stderr,
			detached: true,
		},
	);
	// vp launches Vite in a child; stop the whole group so test gates receive EOF.
	async function stop() {
		if (server.exitCode !== null) return;
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await Promise.race([server.exited, Bun.sleep(5_000)]);
		if (server.exitCode === null)
			try {
				process.kill(-server.pid, "SIGKILL");
			} catch {
				server.kill("SIGKILL");
			}
		await server.exited;
	}
	try {
		await waitForFixtureServer(`${origin}${readyPath}`, {
			server,
			timeoutMs: remaining(),
		});
		// HTML is available before Vite's cold dependency scan and compilation.
		// Finish that work before concurrent specs spend their navigation budgets.
		// Individual fixtures may require the spec's request mocks, so use the
		// normal OS entry for bootstrap.
		await waitForFixtureBrowser(origin, remaining);
	} catch (error) {
		await stop();
		throw error;
	}
	return {
		origin,
		exitCode: () => server.exitCode,
		exited: server.exited,
		stop,
	};
}
