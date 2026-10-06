import { changeInstallationState } from "../src/github-app";

const [action, rawInstallationId] = process.argv.slice(2);
const installationId = Number(rawInstallationId);

if (
	(action !== "suspend" && action !== "uninstall") ||
	!Number.isSafeInteger(installationId) ||
	installationId <= 0
) {
	throw new Error(
		"usage: bun run github-app:incident -- <suspend|uninstall> <installation-id>",
	);
}

const appId = process.env.GITHUB_APP_ID;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY_PKCS8;
if (!appId || !privateKey) {
	throw new Error("GitHub App incident credentials are unavailable");
}

await changeInstallationState(
	{
		GITHUB_APP_ENABLED: "true",
		GITHUB_APP_ID: appId,
		GITHUB_APP_PRIVATE_KEY_PKCS8: privateKey,
	},
	installationId,
	action,
);

console.log(
	`GitHub installation ${installationId} ${action} request succeeded`,
);
