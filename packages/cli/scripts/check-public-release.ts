import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { compareVersions } from "../src/update";

interface LatestRelease {
	version: string;
}

const DEFAULT_BASE_URL = "https://downloads.tedix.dev";
const DEFAULT_FETCH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;

export async function fetchWithRetry(
	fetchImpl: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
	options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<Response> {
	const attempts = options.attempts ?? DEFAULT_FETCH_ATTEMPTS;
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const response = await fetchImpl(input, init);
			const retryable =
				response.status === 408 ||
				response.status === 429 ||
				response.status >= 500;
			if (!retryable || attempt === attempts) return response;
			lastError = new Error(`Release request failed (${response.status})`);
		} catch (error) {
			lastError = error;
			if (attempt === attempts) throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	}
	throw lastError;
}

function cacheBustedUrl(url: string, nonce: string): string {
	const parsed = new URL(url);
	parsed.searchParams.set("release-preflight", nonce);
	return parsed.toString();
}

async function requireAbsent(
	url: string,
	nonce: string,
	fetchImpl: typeof fetch,
): Promise<void> {
	const response = await fetchWithRetry(fetchImpl, cacheBustedUrl(url, nonce), {
		method: "HEAD",
	});
	if (response.status === 404) return;
	if (response.ok) {
		throw new Error(`Refusing to overwrite immutable release object: ${url}`);
	}
	throw new Error(
		`Could not verify immutable release object absence (${response.status}): ${url}`,
	);
}

export async function checkPublicRelease(input: {
	baseUrl?: string;
	distDir: string;
	fetch?: typeof fetch;
	nonce?: string;
	version: string;
}): Promise<{ previousVersion: string | null; version: string }> {
	const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const fetchImpl = input.fetch ?? fetch;
	const nonce = input.nonce ?? crypto.randomUUID();
	const releaseNames = readdirSync(input.distDir)
		.filter(
			(name) =>
				name.startsWith(`tedix-${input.version}-`) ||
				name === "SHA256SUMS" ||
				name === "manifest.json" ||
				name === "verification.json",
		)
		.sort();
	if (releaseNames.length !== 8) {
		throw new Error(
			`Release preflight expected 8 immutable files; got ${releaseNames.length}`,
		);
	}

	for (const name of releaseNames) {
		await requireAbsent(
			`${baseUrl}/releases/${input.version}/${name}`,
			nonce,
			fetchImpl,
		);
	}

	const latestResponse = await fetchWithRetry(
		fetchImpl,
		cacheBustedUrl(`${baseUrl}/latest.json`, nonce),
	);
	if (latestResponse.status === 404) {
		return { previousVersion: null, version: input.version };
	}
	if (!latestResponse.ok) {
		throw new Error(
			`Could not read the current latest release (${latestResponse.status})`,
		);
	}
	const latest = (await latestResponse.json()) as LatestRelease;
	if (typeof latest.version !== "string") {
		throw new Error("Current latest release does not contain a version");
	}
	if (compareVersions(input.version, latest.version) <= 0) {
		throw new Error(
			`Refusing to move latest.json from ${latest.version} to ${input.version}`,
		);
	}
	return { previousVersion: latest.version, version: input.version };
}

if (import.meta.main) {
	const packageDir = resolve(import.meta.dir, "..");
	const distDir = resolve(process.argv[2] ?? join(packageDir, "dist"));
	const pkg = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as { version: string };
	const result = await checkPublicRelease({
		distDir,
		nonce: process.env.GITHUB_SHA,
		version: pkg.version,
	});
	console.log(JSON.stringify({ distDir: basename(distDir), ...result }));
}
