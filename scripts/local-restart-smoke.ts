#!/usr/bin/env bun
// `bun run-local --restart-smoke`: boot with fresh state and write a marker,
// shut down, boot again on the same state and read the marker back.

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_API_URL, LOCAL_OS_URL } from "./run-local";

type RestartPhase = "write" | "read";

function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "localhost", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function waitForLauncherPortsToClose(timeoutMs = 20_000): Promise<void> {
	const ports = [
		Number(new URL(LOCAL_API_URL).port),
		Number(new URL(LOCAL_OS_URL).port),
	];
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await isPortInUse(ports[0])) && !(await isPortInUse(ports[1]))) {
			return;
		}
		await Bun.sleep(250);
	}
	throw new Error(
		"The first local stack did not release ports 8790 and 3030 after shutdown",
	);
}

function runBoot(
	phase: RestartPhase,
	marker: string,
	statePath: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"bun",
			["scripts/run-local.ts", "--no-install", "--smoke"],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					TEDIX_LOCAL_RESTART_MARKER: marker,
					TEDIX_LOCAL_RESTART_PHASE: phase,
					TEDIX_LOCAL_PERSIST_TO: statePath,
					TEDIX_LOCAL_RUN_MODE: "start",
				},
			},
		);
		let output = "";
		const capture = (chunk: Buffer) => {
			output = `${output}${chunk.toString()}`.slice(-128_000);
		};
		child.stdout?.on("data", capture);
		child.stderr?.on("data", capture);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (
				code === 0 &&
				output.includes('"status": "passed"') &&
				output.includes(`"phase": "${phase}"`) &&
				output.includes(marker)
			) {
				resolve(output);
				return;
			}
			reject(
				new Error(
					`Restart ${phase} boot exited with ${code ?? signal ?? "unknown"} without passing${output ? `\n${output.trim()}` : ""}`,
				),
			);
		});
	});
}

const marker = `TEDIX_LOCAL_RESTART_${crypto.randomUUID()}`;
const statePath = mkdtempSync(join(tmpdir(), "tedix-local-restart-"));
const startedAt = Date.now();

console.log(
	"→ First boot: write a unique marker through Tedix OS into local D1",
);
const firstStartedAt = Date.now();
await runBoot("write", marker, statePath);
const firstBootMs = Date.now() - firstStartedAt;
await waitForLauncherPortsToClose();

console.log("→ Second boot: read the same marker without rewriting it");
const secondStartedAt = Date.now();
await runBoot("read", marker, statePath);
const secondBootMs = Date.now() - secondStartedAt;
await waitForLauncherPortsToClose();

console.log(
	JSON.stringify(
		{
			status: "passed",
			marker,
			boots: 2,
			firstBootMs,
			secondBootMs,
			totalMs: Date.now() - startedAt,
		},
		null,
		2,
	),
);
