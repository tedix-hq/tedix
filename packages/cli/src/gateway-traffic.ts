import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { credentialDirectory } from "./credential-store";

const components = [
	"cli",
	"supervisor",
	"dispatcher",
	"runner-heartbeat",
	"runner-steps",
] as const;
export type CliTrafficComponent = (typeof components)[number];
type FetchLike = (
	...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

/** Count actual HTTP attempts, inside retries, without recording credentials or bodies. */
export function gatewayTrafficFetch(
	fetcher: FetchLike,
	component?: CliTrafficComponent,
	options: { directory?: string; now?: () => number; url?: string } = {},
): FetchLike {
	const directory =
		options.directory ?? join(credentialDirectory(), "mcp-traffic");
	const selected = process.env.TEDIX_CLI_COMPONENT;
	const source =
		component ?? components.find((value) => value === selected) ?? "cli";
	let cleanedDay = "";
	return (input, init) => {
		try {
			const url = new URL(input instanceof Request ? input.url : String(input));
			const gateway = options.url ? new URL(options.url) : undefined;
			if (
				!gateway ||
				(url.origin === gateway.origin && url.pathname === gateway.pathname)
			) {
				const at = new Date((options.now ?? Date.now)()).toISOString();
				const day = at.slice(0, 10);
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				if (cleanedDay !== day) {
					const cutoff = new Date(Date.parse(at) - 7 * 86_400_000)
						.toISOString()
						.slice(0, 10);
					for (const name of readdirSync(directory))
						if (
							/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) &&
							name.slice(0, 10) < cutoff
						)
							try {
								unlinkSync(join(directory, name));
							} catch {}
					cleanedDay = day;
				}
				appendFileSync(
					join(directory, `${day}.ndjson`),
					`${JSON.stringify({
						at,
						component: source,
						method:
							init?.method ?? (input instanceof Request ? input.method : "GET"),
					})}\n`,
					{ mode: 0o600 },
				);
			}
		} catch {
			// Local accounting must never prevent a gateway call or lease renewal.
		}
		return fetcher(input, init);
	};
}
