import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const AUTH_GUIDANCE =
	"Run bunx wrangler login, or set CLOUDFLARE_API_TOKEN, then retry.";

async function readWranglerToken(): Promise<string> {
	const result = await execute(
		"bunx",
		["wrangler", "auth", "token", "--json"],
		{
			timeout: 30_000,
			maxBuffer: 64 * 1024,
			encoding: "utf8",
			// Wrangler normally copies logger output (including auth JSON) to disk.
			env: {
				...process.env,
				WRANGLER_WRITE_LOGS: "false",
				WRANGLER_LOG: "log",
				WRANGLER_SEND_METRICS: "false",
			},
		},
	);
	return result.stdout;
}

/** Reuse public Wrangler authentication without persisting or printing credentials. */
export async function resolveCloudflareCliToken(
	env: { CLOUDFLARE_API_TOKEN?: string } = process.env,
	readToken: () => Promise<string> = readWranglerToken,
): Promise<string> {
	const explicit = env.CLOUDFLARE_API_TOKEN?.trim();
	if (explicit) return explicit;
	let output: unknown;
	try {
		output = JSON.parse(await readToken());
	} catch {
		// Subprocess errors carry stdout/stderr; never retain them as a cause.
		throw new Error(`Could not read Wrangler authentication. ${AUTH_GUIDANCE}`);
	}
	if (typeof output !== "object" || output === null) {
		throw new Error(
			`Wrangler returned an unsupported authentication response. ${AUTH_GUIDANCE}`,
		);
	}
	const credential = output as { type?: unknown; token?: unknown };
	if (credential.type === "api_key") {
		throw new Error(
			"Cloudflare global API key/email authentication is not supported. Unset CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL before running bunx wrangler login, or set CLOUDFLARE_API_TOKEN, then retry.",
		);
	}
	if (
		(credential.type !== "oauth" && credential.type !== "api_token") ||
		typeof credential.token !== "string" ||
		!credential.token.trim()
	) {
		throw new Error(
			`Wrangler returned no supported bearer token. ${AUTH_GUIDANCE}`,
		);
	}
	return credential.token.trim();
}
