import { installBrowserEvidence } from "./failure-evidence";

// Bun preload for every `bun <file>` in apps/os (see bunfig.toml). It arms
// browser failure evidence only when the runner exports the directory; local
// spec runs without it are unaffected.
await installBrowserEvidence();
