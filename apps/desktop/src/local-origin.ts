/** No flag selects the hosted app. A malformed flag must never do so. */
export function localOrigin(
	args: readonly string[],
): string | null | undefined {
	const option = args.find(
		(arg) => arg === "--local" || arg.startsWith("--local="),
	);
	if (option === undefined) return undefined;
	const port = option === "--local" ? "3030" : option.slice("--local=".length);
	if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) return null;
	return `http://localhost:${port}`;
}

// Local onboarding hands off from localhost to the workspace's *.localhost host.
const localOsHost = /^(?:[a-z0-9-]+\.)?localhost$/;

export function localPageAllowed(url: string, origin: string): boolean {
	const target = URL.parse(url);
	return Boolean(
		target?.protocol === "http:" &&
		localOsHost.test(target.hostname) &&
		target.port === new URL(origin).port,
	);
}

export function localRequestAllowed(url: string): boolean {
	const target = URL.parse(url);
	if (!target) return false;
	if (["about:", "blob:", "data:"].includes(target.protocol)) return true;
	return (
		["http:", "ws:"].includes(target.protocol) &&
		(localOsHost.test(target.hostname) ||
			["127.0.0.1", "[::1]"].includes(target.hostname))
	);
}
