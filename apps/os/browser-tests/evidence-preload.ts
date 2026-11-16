import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installBrowserEvidence, specEvidenceName } from "./failure-evidence";

// Linux WebKit draws through Mesa's software rasterizer, which compiles its
// drawing code for the CPU it runs on. On CI runners with an Intel Xeon
// Platinum 8573C the AVX-512 code it compiles reads far outside a texture and
// the page process dies of a segmentation fault; the spec then sees a frozen
// page and a click timeout. "avx" turns off only the AVX-512 code, leaving
// what the runners without AVX-512 already run. Browsers inherit this
// environment when a spec launches them; an explicit value wins.
process.env.GALLIUM_OVERRIDE_CPU_CAPS ||= "avx";

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
