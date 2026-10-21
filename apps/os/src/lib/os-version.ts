export const OS_VERSION_POLL_MS = 10 * 60 * 1000;

export function installOsVersionChecks({
	buildSha,
	notify,
	fetchVersion = fetch,
}: {
	buildSha: string;
	notify: (sha: string) => void;
	fetchVersion?: typeof fetch;
}): () => void {
	let disposed = false;
	let pending = false;
	let notifiedSha = "";
	const check = async () => {
		if (pending || disposed) return;
		pending = true;
		try {
			const response = await fetchVersion("/version.json", {
				cache: "no-store",
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) return;
			const version: unknown = await response.json();
			if (
				typeof version !== "object" ||
				version === null ||
				!("sha" in version)
			)
				return;
			const sha = version.sha;
			if (
				!disposed &&
				typeof sha === "string" &&
				/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) &&
				sha !== buildSha &&
				sha !== notifiedSha
			) {
				notifiedSha = sha;
				notify(sha);
			}
		} catch {
			// Offline tabs and old installations may have no version endpoint.
		} finally {
			pending = false;
		}
	};
	window.addEventListener("focus", check);
	const interval = window.setInterval(check, OS_VERSION_POLL_MS);
	return () => {
		disposed = true;
		window.removeEventListener("focus", check);
		window.clearInterval(interval);
	};
}
