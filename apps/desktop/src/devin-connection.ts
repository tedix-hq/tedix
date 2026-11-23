import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { TEDIX_DEVIN_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import { personEnv, toolPath } from "./shell";
import { type Connection, devinConnection } from "./tool-connection";

export async function checkDevinConnection(
	command: string,
	url: string,
	onStart: (stop: () => void) => void,
): Promise<Connection> {
	const directory = await mkdtemp(join(tmpdir(), "tedix-devin-"));
	try {
		const config = join(directory, "devin");
		await mkdir(config);
		await Promise.all([
			writeFile(
				join(config, "mcp_config.json"),
				JSON.stringify({
					mcpServers: {
						tedix: {
							transport: "http",
							url,
							oauthClientId: TEDIX_DEVIN_OAUTH_CLIENT_ID,
						},
					},
				}),
			),
			writeFile(
				join(config, "config.json"),
				JSON.stringify({
					read_config_from: {
						claude: false,
						cursor: false,
						windsurf: false,
						opencode: false,
						zed: false,
					},
				}),
			),
		]);
		// ACP starts Devin's MCP client at initialization. Keep its native
		// credential store, but load only Tedix and never start an agent session.
		return await new Promise<Connection>((resolve) => {
			const child = spawn(command, ["acp", "--process-model", "in-process"], {
				cwd: directory,
				env: {
					...personEnv(),
					PATH: toolPath(),
					XDG_CONFIG_HOME: directory,
					RUST_LOG: "toolbox::tools::mcp=info",
				},
				stdio: ["pipe", "ignore", "pipe"],
			});
			const lines = createInterface({ input: child.stderr });
			let result: Connection = "unknown";
			const stop = () => child.kill("SIGKILL");
			const timer = setTimeout(stop, 30_000);
			onStart(stop);
			lines.on("line", (line) => {
				const status = devinConnection(line);
				if (status === undefined) return;
				result = status;
				stop();
			});
			child.on("error", stop);
			child.on("close", () => {
				clearTimeout(timer);
				lines.close();
				resolve(result);
			});
			child.stdin.on("error", stop);
			child.stdin.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: 1,
						clientCapabilities: {},
						clientInfo: { name: "Tedix setup", version: "1" },
					},
				}) + "\n",
			);
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
