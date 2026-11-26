import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { digest, verifyLedger } from "./history-ledger";

// Bundled into every pack; no repository, credentials or network required.
const [root, keysPath] = process.argv.slice(2);
if (!root || !keysPath)
	throw new Error("Usage: bun verify-ledger.js <pack> <trusted-keys.json>");
const manifest = JSON.parse(
	await readFile(join(root, "manifest.json"), "utf8"),
);
const keys = JSON.parse(await readFile(keysPath, "utf8"));
const objects = [];
for (const entry of manifest.files) {
	if (!entry.source.startsWith("change-record-evidence/v1/")) continue;
	if (basename(entry.path) !== entry.path)
		throw new Error("Unsafe ledger path");
	const bytes = new Uint8Array(await readFile(join(root, entry.path)));
	if (digest(bytes) !== entry.sha256)
		throw new Error("Ledger file digest mismatch");
	objects.push({ key: entry.source, bytes });
}
console.log(
	JSON.stringify(
		await verifyLedger(
			objects,
			manifest.organization,
			manifest.from,
			manifest.to,
			keys,
		),
	),
);
