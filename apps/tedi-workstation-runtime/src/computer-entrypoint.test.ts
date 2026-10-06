import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { URL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe("Sandbox command environment", () => {
	it("forwards public command settings without forwarding daemon secrets", () => {
		const directory = mkdtempSync(join(tmpdir(), "computer-entrypoint-"));
		try {
			const ca = join(directory, "ca.crt");
			writeFileSync(ca, "fixture certificate\n");
			const script = readFileSync(
				new URL("../computer-entrypoint.sh", import.meta.url),
				"utf8",
			)
				.replaceAll("/etc/cloudflare/certs/cloudflare-containers-ca.crt", ca)
				.replace(
					"/tmp/tedix-cloudflare-containers-ca-bundle.crt",
					join(directory, "bundle.crt"),
				)
				.replace("/etc/ssl/certs/ca-certificates.crt", ca)

				.replace("exec sleep infinity", "exec /usr/bin/env");
			const entrypoint = join(directory, "entrypoint.sh");
			writeFileSync(entrypoint, script);
			const output = execFileSync("/bin/sh", [entrypoint], {
				encoding: "utf8",
				env: {
					PATH: "/usr/bin:/bin",
					SANDBOX_INTERCEPT_HTTPS: "1",
					RPC_CLIENT_SECRET: "fixture-private",
					TEDIX_WORKSTATION_DIR: "/workspace/path with spaces",
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "/bin/false",
				} as unknown as NodeJS.ProcessEnv,
			});
			const env = Object.fromEntries(
				output
					.trim()
					.split("\n")
					.map((line) => {
						const separator = line.indexOf("=");
						return [line.slice(0, separator), line.slice(separator + 1)];
					}),
			);
			expect(env.TEDIX_WORKSTATION_DIR).toBe("/workspace/path with spaces");
			expect(env.GIT_TERMINAL_PROMPT).toBe("0");
			for (const name of [
				"CURL_CA_BUNDLE",
				"GIT_SSL_CAINFO",
				"REQUESTS_CA_BUNDLE",
				"SSL_CERT_FILE",
			]) {
				expect(env[name]).toBe(join(directory, "bundle.crt"));
			}
			expect(env.NODE_EXTRA_CA_CERTS).toBe(ca);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
