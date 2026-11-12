import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	clearAppRuntimeCodeStore,
	knownAppRuntimeFiles,
	loadAppRuntimeCode,
	resetAppRuntimeCodeStore,
} from "./app-runtime-code-store";

const files = { "client.js": "render()", "server.js": "export {}" };

async function sha256(text: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** A Cache Storage stand-in: one named cache of URL -> text. */
function fakeCaches() {
	const entries = new Map<string, string>();
	const url = (key: string | Request) =>
		new URL(typeof key === "string" ? key : key.url, "https://os.test").href;
	const cache = {
		keys: async () => [...entries.keys()].map((href) => ({ url: href })),
		match: async (key: string) =>
			entries.has(url(key)) ? new Response(entries.get(url(key))) : undefined,
		put: async (key: string, response: Response) => {
			entries.set(url(key), await response.text());
		},
		delete: async (key: string | Request) => entries.delete(url(key)),
	};
	return { entries, caches: { open: async () => cache } };
}

describe("app files kept by content hash", () => {
	let store: ReturnType<typeof fakeCaches>;
	beforeEach(() => {
		store = fakeCaches();
		vi.stubGlobal("caches", store.caches);
		resetAppRuntimeCodeStore();
	});
	afterEach(() => vi.unstubAllGlobals());

	const code = async (withFiles: boolean) => ({
		revisionId: "00000000-0000-4000-8000-000000000001",
		revision: 1,
		filesSha256: await sha256(JSON.stringify(files)),
		...(withFiles ? { files } : {}),
		codeLength: 17,
		createdAt: "2026-11-11T00:00:00.000Z",
	});

	it("downloads a file set once and reuses it for the next app and the next visit", async () => {
		const full = await code(true);
		const first = vi.fn(async () => ({ code: full }));
		expect((await loadAppRuntimeCode(first)).code?.files).toEqual(files);
		expect(first).toHaveBeenCalledWith(undefined);

		// A second app with the same files: the API is told the hash and
		// answers without them.
		const second = vi.fn(async (known: string[] | undefined) => ({
			code: known?.includes(full.filesSha256) ? await code(false) : full,
		}));
		expect((await loadAppRuntimeCode(second)).code?.files).toEqual(files);
		expect(second).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledWith([full.filesSha256]);

		// A new visit has no memory, only the stored copy.
		resetAppRuntimeCodeStore();
		expect(await knownAppRuntimeFiles()).toEqual([full.filesSha256]);
		expect((await loadAppRuntimeCode(second)).code?.files).toEqual(files);
		expect(second).toHaveBeenCalledTimes(2);
	});

	it("downloads again when the stored copy no longer matches its hash", async () => {
		const full = await code(true);
		await loadAppRuntimeCode(async () => ({ code: full }));
		resetAppRuntimeCodeStore();
		for (const key of store.entries.keys())
			store.entries.set(key, JSON.stringify({ "client.js": "tampered()" }));
		const read = vi.fn(async (known: string[] | undefined) => ({
			code: known ? await code(false) : full,
		}));
		expect((await loadAppRuntimeCode(read)).code?.files).toEqual(files);
		expect(read).toHaveBeenCalledTimes(2);
		expect(read).toHaveBeenLastCalledWith(undefined);
	});

	it("does not keep files whose content does not match the given hash", async () => {
		const full = { ...(await code(true)), filesSha256: "b".repeat(64) };
		expect(
			(await loadAppRuntimeCode(async () => ({ code: full }))).code?.files,
		).toEqual(files);
		expect(await knownAppRuntimeFiles()).toEqual([]);
	});

	it("forgets every stored file on sign-out, in memory and on disk", async () => {
		const full = await code(true);
		await loadAppRuntimeCode(async () => ({ code: full }));
		const deleted: string[] = [];
		vi.stubGlobal("caches", {
			...store.caches,
			delete: async (name: string) => {
				deleted.push(name);
				store.entries.clear();
				return true;
			},
		});
		await clearAppRuntimeCodeStore();
		expect(deleted).toEqual(["tedix-app-files-v1"]);
		expect(await knownAppRuntimeFiles()).toEqual([]);
		// Without Cache Storage there is only memory to clear.
		vi.stubGlobal("caches", undefined);
		await loadAppRuntimeCode(async () => ({ code: full }));
		await clearAppRuntimeCodeStore();
		expect(await knownAppRuntimeFiles()).toEqual([]);
	});

	it("works without Cache Storage and passes on a revision with no code", async () => {
		vi.stubGlobal("caches", undefined);
		expect(await loadAppRuntimeCode(async () => ({ code: null }))).toEqual({
			code: null,
		});
		const full = await code(true);
		await loadAppRuntimeCode(async () => ({ code: full }));
		expect(await knownAppRuntimeFiles()).toEqual([full.filesSha256]);
	});
});
