import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	credentialDirectory,
	type CredentialStoreOpts,
} from "./credential-store";
import { withFileLockSync } from "./local-file-lock";

export interface GatewayCooldown {
	read(url: string): number;
	extend(url: string, until: number): void;
}

/** Share gateway refusals across processes, without storing credentials. */
export function fileGatewayCooldown(
	opts?: CredentialStoreOpts,
): GatewayCooldown {
	const path = (url: string) =>
		join(
			credentialDirectory(opts),
			`gateway-cooldown-${createHash("sha256").update(new URL(url).origin).digest("hex")}.json`,
		);
	const read = (url: string) => {
		try {
			const value = JSON.parse(readFileSync(path(url), "utf8"));
			return typeof value.until === "number" && Number.isFinite(value.until)
				? value.until
				: 0;
		} catch {
			return 0;
		}
	};
	return {
		read,
		extend(url, until) {
			try {
				mkdirSync(credentialDirectory(opts), { recursive: true, mode: 0o700 });
				withFileLockSync(`${path(url)}.lock`, () => {
					const temporary = `${path(url)}.${randomUUID()}.tmp`;
					writeFileSync(
						temporary,
						JSON.stringify({ until: Math.max(until, read(url)) }),
						{ mode: 0o600 },
					);
					renameSync(temporary, path(url));
				});
			} catch {
				// Local storage failure must not prevent the caller's own retry.
			}
		},
	};
}
