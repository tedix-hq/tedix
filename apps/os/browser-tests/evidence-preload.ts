import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installBrowserEvidence, specEvidenceName } from "./failure-evidence";

const protocolDir = process.env.TEDIX_BROWSER_PROTOCOL_DIR;
if (protocolDir) {
	mkdirSync(protocolDir, { recursive: true });
	// Parallel spec processes reuse protocol request IDs. Keep their logs apart.
	process.env.DEBUG_FILE = join(
		protocolDir,
		`${specEvidenceName(process.argv[1])}-${process.pid}.log`,
	);
}

// Bun preload for every `bun <file>` in apps/os (see bunfig.toml). It arms
// browser failure evidence only when the runner exports the directory; local
// spec runs without it are unaffected.
await installBrowserEvidence();
