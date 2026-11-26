import { spawnSync } from "node:child_process";
import { laneChildEnv } from "./lane-child-env";

function readGatewayToken(): string | undefined {
	if (process.platform !== "darwin") return;
	const result = spawnSync(
		"/usr/bin/security",
		["find-generic-password", "-s", "CF_AI_GATEWAY_TOKEN", "-w"],
		{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status === 44) return;
	if (result.status !== 0)
		throw new Error(
			"Could not read the OpenCode AI Gateway token from Keychain",
		);
	return result.stdout.trim() || undefined;
}

export function openCodeLaneEnv(
	env = process.env,
	readToken: () => string | undefined = readGatewayToken,
): NodeJS.ProcessEnv {
	const child = laneChildEnv(env);
	if (!child.CF_AI_GATEWAY_TOKEN) {
		const token = readToken();
		if (token) child.CF_AI_GATEWAY_TOKEN = token;
	}
	return child;
}
