import type { SpawnOptions } from "bun";
import { waitForFixtureServer } from "../dev/fixture-server-readiness";

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
	let port = process.env.TEDIX_BROWSER_TEST_PORT;
	if (!port) {
		const probe = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(),
		});
		port = String(probe.port!);
		probe.stop();
	}
	const origin = `http://127.0.0.1:${port}`;
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
		await waitForFixtureServer(`${origin}${readyPath}`, { server });
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
