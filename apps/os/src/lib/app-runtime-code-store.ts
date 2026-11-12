import {
	APP_FILES_CACHE_NAME,
	clearStoredAppFiles,
} from "@/shared/app-files-cache";
import type {
	AppRuntimeCode,
	AppRuntimeFiles,
} from "@tedix/api-contract/schemas/os-app-runtime";

/**
 * App files this browser already holds, by the SHA-256 of their content.
 *
 * Every Doc shares one editor, every Sheet another. The API names a
 * revision's files by their hash, so the browser downloads each distinct set
 * once: it tells the API which hashes it holds and gets the files only when
 * it lacks them. The copies live in memory for this tab and in Cache Storage
 * across tabs and visits. A stored copy is used only while its content still
 * hashes to its name, so a damaged or altered entry is downloaded again.
 */

const CACHE_NAME = APP_FILES_CACHE_NAME;
/** Distinct file sets kept on disk; the oldest go first. */
const MAX_STORED = 24;
/** The API accepts at most this many known hashes per read. */
const MAX_KNOWN = 32;

export type AppRuntimeLoadedCode = AppRuntimeCode & { files: AppRuntimeFiles };

const memory = new Map<string, AppRuntimeFiles>();

const entryUrl = (sha256: string) => `/app-files/${sha256}`;

async function openStore(): Promise<Cache | null> {
	try {
		return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
	} catch {
		// Private windows and blocked storage: memory still works.
		return null;
	}
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Hashes of the file sets this browser can supply without a download. */
export async function knownAppRuntimeFiles(): Promise<string[]> {
	const known = new Set(memory.keys());
	const store = await openStore();
	try {
		for (const request of (await store?.keys()) ?? []) {
			const sha256 = new URL(request.url).pathname.split("/").pop();
			if (sha256 && /^[a-f0-9]{64}$/.test(sha256)) known.add(sha256);
		}
	} catch {
		// An unreadable store only costs a download.
	}
	return [...known].slice(-MAX_KNOWN);
}

async function readStoredFiles(
	sha256: string,
): Promise<AppRuntimeFiles | null> {
	const held = memory.get(sha256);
	if (held) return held;
	const store = await openStore();
	try {
		const text = await (await store?.match(entryUrl(sha256)))?.text();
		if (text === undefined) return null;
		if ((await sha256Hex(text)) !== sha256) {
			await store?.delete(entryUrl(sha256));
			return null;
		}
		const files = JSON.parse(text) as AppRuntimeFiles;
		memory.set(sha256, files);
		return files;
	} catch {
		return null;
	}
}

async function storeFiles(
	sha256: string,
	files: AppRuntimeFiles,
): Promise<void> {
	const text = JSON.stringify(files);
	// Keep only content that can be checked against its name later.
	if ((await sha256Hex(text)) !== sha256) return;
	memory.set(sha256, files);
	const store = await openStore();
	if (!store) return;
	try {
		await store.put(
			entryUrl(sha256),
			new Response(text, { headers: { "Content-Type": "application/json" } }),
		);
		const stored = await store.keys();
		for (const request of stored.slice(
			0,
			Math.max(0, stored.length - MAX_STORED),
		))
			await store.delete(request);
	} catch {
		// Out of space or blocked: the next visit downloads again.
	}
}

/**
 * Read one revision's code, downloading its files only when this browser does
 * not hold them. `read` is the API call; it takes the hashes already held.
 */
export async function loadAppRuntimeCode(
	read: (
		knownFilesSha256: string[] | undefined,
	) => Promise<{ code: AppRuntimeCode | null }>,
): Promise<{ code: AppRuntimeLoadedCode | null }> {
	const known = await knownAppRuntimeFiles();
	const { code } = await read(known.length > 0 ? known : undefined);
	if (!code) return { code: null };
	if (code.files) {
		await storeFiles(code.filesSha256, code.files);
		return { code: { ...code, files: code.files } };
	}
	const files = await readStoredFiles(code.filesSha256);
	if (files) return { code: { ...code, files } };
	// The copy went away between listing and reading it: ask for the files.
	const fresh = (await read(undefined)).code;
	if (!fresh?.files) return { code: null };
	await storeFiles(fresh.filesSha256, fresh.files);
	return { code: { ...fresh, files: fresh.files } };
}

/**
 * Remove every app file this browser holds, in memory and on disk. Called
 * when someone signs out, so the next person at this browser starts without
 * the previous person's apps.
 */
export async function clearAppRuntimeCodeStore(): Promise<void> {
	memory.clear();
	await clearStoredAppFiles();
}

/** Forget the in-memory copies; tests start from an empty browser. */
export function resetAppRuntimeCodeStore(): void {
	memory.clear();
}
