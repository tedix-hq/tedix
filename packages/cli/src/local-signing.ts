/**
 * Optional local code signing for the standalone macOS binary.
 *
 * Release binaries are ad-hoc signed, so their designated requirement is their
 * hash and changes with every release; a Full Disk Access grant for the
 * background supervisor would be lost on each update. When the owner has
 * created a self-signed code-signing identity named `LOCAL_SIGNING_IDENTITY`,
 * `tedix update` re-signs the installed binary with it and a fixed identifier,
 * which keeps the requirement (identifier + certificate) stable. Tedix never
 * creates the identity or changes keychain settings; that stays the owner's
 * one-time action (`LOCAL_SIGNING_GUIDE`).
 */
import { spawnSync } from "node:child_process";

export const LOCAL_SIGNING_IDENTITY = "Tedix CLI (local)";
export const LOCAL_SIGNING_IDENTIFIER = "dev.tedix.cli";
export const LOCAL_SIGNING_GUIDE =
	"https://docs.tedix.dev/supervisor-full-disk-access";

export type SigningRun = (
	command: string,
	args: string[],
) => { status: number | null; output: string };

export const systemSigningRun: SigningRun = (command, args) => {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 30_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		status: result.status,
		output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
	};
};

/** True when the keychain search list holds the owner's local identity. */
export function hasLocalSigningIdentity(
	run: SigningRun = systemSigningRun,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== "darwin") return false;
	const result = run("security", ["find-identity", "-p", "codesigning"]);
	return (
		result.status === 0 && result.output.includes(`"${LOCAL_SIGNING_IDENTITY}"`)
	);
}

/** True when `path` already carries the local signing identifier. */
export function signedLocally(
	path: string,
	run: SigningRun = systemSigningRun,
): boolean {
	const result = run("codesign", ["-d", "-r-", path]);
	return (
		result.status === 0 &&
		result.output.includes(`identifier "${LOCAL_SIGNING_IDENTIFIER}"`)
	);
}

/** Re-sign `path` with the local identity; throws with codesign's reason. */
export function signLocally(
	path: string,
	run: SigningRun = systemSigningRun,
): void {
	const result = run("codesign", [
		"--force",
		"--sign",
		LOCAL_SIGNING_IDENTITY,
		"--identifier",
		LOCAL_SIGNING_IDENTIFIER,
		path,
	]);
	if (result.status !== 0)
		throw new Error(
			`codesign with "${LOCAL_SIGNING_IDENTITY}" failed: ${result.output.trim().slice(-300)}`,
		);
}
