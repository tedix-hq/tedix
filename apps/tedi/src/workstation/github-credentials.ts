import type { TediConfig } from "../types";
import { workstationExec, type WorkstationRuntimeBody } from "./computer-body";
import {
	WORKSTATION_GH_HOSTS_PATH,
	WORKSTATION_GIT_CREDENTIALS_PATH,
	WORKSTATION_HOME,
} from "./paths";

type GitHubCredentialPaths = {
	configDir: string;
	ghHostsPath: string;
	gitCredentialsPath: string;
};

const WORKSTATION_CREDENTIAL_HYDRATION_TIMEOUT_MS = 30_000;

export type GitHubCredentialHydrationResult =
	| { configured: false; status: "missing" }
	| {
			configured: true;
			status: "brokered";
			probe?: GitHubCredentialProbeResult;
	  };

export type GitHubCredentialProbeResult = {
	status: "valid" | "invalid" | "rate_limited" | "forbidden" | "unavailable";
	httpStatus?: number;
	responseHeaders?: Record<string, string>;
};

function githubCredentialProbe(repository: string): string {
	const endpointLiteral = JSON.stringify(`repos/${repository}`);
	return String.raw`
const cp = require("node:child_process");
const result = cp.spawnSync(
	"gh",
	["api", "--include", "--silent", ${endpointLiteral}],
	{ encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 25000 },
);
const combined = String(result.stdout || "") + "\n" + String(result.stderr || "");
const statuses = [...combined.matchAll(/^HTTP\/\S+\s+(\d{3})(?:\s|$)/gim)];
const httpStatus = statuses.length
	? Number(statuses[statuses.length - 1][1])
	: /bad credentials|HTTP 401/i.test(combined)
		? 401
		: /HTTP 403/i.test(combined)
			? 403
			: /HTTP 429/i.test(combined)
				? 429
				: undefined;
const responseHeaders = {};
const safeHeaders = {
	"retry-after": (value) => /^\d{1,10}$/.test(value),
	"server": (value) => /^(github\.com|cloudflare)$/i.test(value),
	"x-github-request-id": (value) => /^[A-Z0-9:-]{1,80}$/i.test(value),
	"x-ratelimit-limit": (value) => /^\d{1,10}$/.test(value),
	"x-ratelimit-remaining": (value) => /^\d{1,10}$/.test(value),
	"x-ratelimit-reset": (value) => /^\d{1,16}$/.test(value),
};
for (const [name, isSafe] of Object.entries(safeHeaders)) {
	const match = new RegExp("^" + name + ":\\s*([^\\r\\n]+)$", "im").exec(combined);
	const value = match?.[1]?.trim() ?? "";
	if (isSafe(value)) responseHeaders[name] = value;
}
const status = result.status === 0 && (!httpStatus || httpStatus < 400)
	? "valid"
	: httpStatus === 401
		? "invalid"
		: httpStatus === 429
			? "rate_limited"
			: httpStatus === 403
				? "forbidden"
				: "unavailable";
process.stdout.write(JSON.stringify({
	status,
	...(httpStatus ? { httpStatus } : {}),
	...(Object.keys(responseHeaders).length ? { responseHeaders } : {}),
}));
`;
}

export type GitIdentityHydrationResult = { email: string; name: string };

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Give the container the tedi's own Git identity.
 *
 * A workstation without `user.name`/`user.email` cannot commit, so an agent
 * reaches for the nearest identity it can find — `git log -1 --format=%an` —
 * and signs a commit it wrote with a human's name. That is a false attribution
 * in an immutable ledger. The identity here is the tedi's first-class Descope
 * identity from `docs/platform/auth.md`: login `tedi:{slug}`, alias
 * `{slug}@tedix.tech`.
 *
 * Written globally (`~/.gitconfig`), not per-repository, so it holds for every
 * checkout in the lease and is set whether or not brokered GitHub authority is
 * available: identity is who the tedi is, credentials are what it may push.
 */
export async function hydrateGitIdentity(
	sandbox: WorkstationRuntimeBody,
	tediConfig: TediConfig,
): Promise<GitIdentityHydrationResult> {
	const name = tediConfig.displayName.trim() || tediConfig.slug;
	const email = `${tediConfig.slug}@tedix.tech`;
	await checkedExec(
		sandbox,
		[
			`git config --global user.name ${shellSingleQuote(name)}`,
			`git config --global user.email ${shellSingleQuote(email)}`,
		].join(" && "),
		{ timeout: WORKSTATION_CREDENTIAL_HYDRATION_TIMEOUT_MS },
	);
	return { email, name };
}

export async function hydrateGitHubCliCredentials(
	sandbox: WorkstationRuntimeBody,
	tediConfig: TediConfig,
	paths: GitHubCredentialPaths = {
		configDir: `${WORKSTATION_HOME}/.config/gh`,
		ghHostsPath: WORKSTATION_GH_HOSTS_PATH,
		gitCredentialsPath: WORKSTATION_GIT_CREDENTIALS_PATH,
	},
): Promise<GitHubCredentialHydrationResult> {
	// GitHub authority belongs at the Worker egress boundary, never on a
	// Sandbox filesystem. The broker mints a repository-scoped GitHub App token
	// only for the upstream request. Always remove artifacts written by older
	// bodies, including shell-only and no-repository leases: container disk is
	// not a credential boundary and can outlive the task that wrote it.
	await checkedExec(sandbox, `mkdir -p ${shellSingleQuote(paths.configDir)}`, {
		timeout: WORKSTATION_CREDENTIAL_HYDRATION_TIMEOUT_MS,
	});
	await checkedExec(
		sandbox,
		[
			`rm -f -- ${shellSingleQuote(paths.gitCredentialsPath)} ${shellSingleQuote(paths.ghHostsPath)}`,
			"git config --global --unset-all credential.helper || true",
			"git config --global --unset-all http.https://github.com/.proactiveAuth || true",
			"git config --global credential.interactive false",
			"git config --global http.lowSpeedLimit 1",
			"git config --global http.lowSpeedTime 30",
		].join(" && "),
		{ timeout: WORKSTATION_CREDENTIAL_HYDRATION_TIMEOUT_MS },
	);
	if (!tediConfig.repoConfig?.repoUrl) {
		return { configured: false, status: "missing" };
	}
	return { configured: true, status: "brokered" };
}

/**
 * Validate the already-hydrated GitHub credential without exposing it or any
 * GitHub response body. The workstation owner calls this only after repository
 * sync fails, so healthy readiness polling spends no extra GitHub API request.
 */
export async function probeGitHubCliCredentials(
	sandbox: WorkstationRuntimeBody,
	repository: string,
): Promise<GitHubCredentialProbeResult> {
	const result = await workstationExec(
		sandbox,
		`bun -e ${shellSingleQuote(githubCredentialProbe(repository))}`,
		{ timeout: WORKSTATION_CREDENTIAL_HYDRATION_TIMEOUT_MS },
	);
	if (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.signal !== undefined ||
		result.truncated
	)
		return { status: "unavailable" };
	try {
		const parsed = JSON.parse(
			result.stdout ?? "",
		) as GitHubCredentialProbeResult;
		if (
			![
				"valid",
				"invalid",
				"rate_limited",
				"forbidden",
				"unavailable",
			].includes(parsed.status)
		)
			return { status: "unavailable" };
		return parsed;
	} catch {
		return { status: "unavailable" };
	}
}

async function checkedExec(
	sandbox: WorkstationRuntimeBody,
	command: string,
	options: { timeout: number },
) {
	const result = await workstationExec(sandbox, command, options);
	if (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.signal !== undefined ||
		result.truncated
	)
		throw new Error("Workstation credential configuration failed");
}
