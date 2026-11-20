/** How the person can set up Tedix on the computer they are using now. */

/** The link the Tedix desktop app answers by opening "Set up this Mac". */
export const DESKTOP_SETUP_LINK = "tedix://setup";

/** What the desktop app's "Set up this Mac" window does, in one sentence. */
export const MAC_SETUP_SUMMARY =
	"It installs the Tedix command-line tool, signs you in on this Mac, finds Claude Code, Codex, Devin and OpenCode, adds the Tedix plugin to each, and lets Tedix run tasks on this Mac.";
/** The app is not yet signed by Apple, so macOS asks once. */
export const MAC_FIRST_OPEN_NOTE =
	"The first time you open it, macOS asks you to confirm: go to System Settings → Privacy & Security and choose Open Anyway.";

const DESKTOP_LATEST_URL = "https://downloads.tedix.dev/desktop/latest.json";

export type ThisComputer = "desktop-app" | "mac" | "other";

export function thisComputer(): ThisComputer {
	if (navigator.userAgent.includes("TedixDesktop/")) return "desktop-app";
	// iPads report a Mac platform; they have touch points and cannot run the app.
	return /Mac/.test(navigator.platform) && navigator.maxTouchPoints < 2
		? "mac"
		: "other";
}

export interface MacDownload {
	version: string;
	appleSilicon: string;
	intel: string;
	/** The one download for this Mac, when the browser says which chip it has. */
	forThisMac: string | null;
}

/** Only Chromium browsers say which chip a Mac has; Safari and Firefox do not. */
async function macChip(): Promise<"arm" | "x86" | null> {
	const data = (
		navigator as Navigator & {
			userAgentData?: {
				getHighEntropyValues(
					hints: string[],
				): Promise<{ architecture?: string }>;
			};
		}
	).userAgentData;
	const architecture = (
		await data?.getHighEntropyValues(["architecture"]).catch(() => null)
	)?.architecture;
	return architecture === "arm" || architecture === "x86" ? architecture : null;
}

export async function latestMacDownload(): Promise<MacDownload> {
	const response = await fetch(DESKTOP_LATEST_URL);
	if (!response.ok) throw new Error("The download is not available right now.");
	const { version } = (await response.json()) as { version?: unknown };
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+[\w.-]*$/.test(version))
		throw new Error("The download is not available right now.");
	const file = (chip: string) =>
		`https://downloads.tedix.dev/desktop/releases/${version}/Tedix-${version}-darwin-${chip}.zip`;
	const chip = await macChip();
	const appleSilicon = file("arm64");
	const intel = file("x64");
	return {
		version,
		appleSilicon,
		intel,
		forThisMac: chip === "arm" ? appleSilicon : chip === "x86" ? intel : null,
	};
}
