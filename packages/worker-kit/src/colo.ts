let colo: string | undefined;
let asked = false;

/**
 * The Cloudflare data centre running this isolate, for latency logs. The
 * first call starts one lookup and returns undefined; later calls return the
 * airport code, or "unknown" when the lookup failed.
 */
export function isolateColo(): string | undefined {
	if (!asked) {
		asked = true;
		fetch("https://cloudflare.com/cdn-cgi/trace", {
			signal: AbortSignal.timeout(2_000),
		})
			.then((response) => response.text())
			.then((text) => {
				colo = /^colo=([A-Z]+)$/m.exec(text)?.[1] ?? "unknown";
			})
			.catch(() => {
				colo = "unknown";
			});
	}
	return colo;
}
