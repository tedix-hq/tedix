import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	credentialDirectory,
	type CredentialStoreOpts,
} from "./credential-store";
import { withFileLockSync } from "./local-file-lock";
import { looksLikeUuid } from "./shared";

export interface SessionReportingProject {
	workspace: string;
	org: string;
	mcpUrl: string;
	projectId: string;
	enabled: boolean;
	/** Only sessions of this coding tool; absent for every tool. */
	harness?: string;
}

/** The coding tools whose sessions can report. */
export const REPORTING_HARNESSES = [
	"claude-code",
	"codex",
	"devin",
	"opencode",
] as const;

/**
 * Whether sessions of `harness` in `projectId` report: a row for that tool
 * decides, else a row for every tool. Without a tool, any row that is on.
 */
export function reportsSessions(
	projects: SessionReportingProject[],
	projectId: string | undefined,
	harness?: string,
): boolean {
	const rows = projects.filter((row) => row.projectId === projectId);
	if (!harness) return rows.some((row) => row.enabled);
	const own = rows.find((row) => row.harness === harness);
	return own ? own.enabled : rows.some((row) => !row.harness && row.enabled);
}

type Target = Pick<SessionReportingProject, "workspace" | "org" | "mcpUrl">;

function readConfig(options?: CredentialStoreOpts): Record<string, unknown> {
	const path = join(credentialDirectory(options), "agent-status.json");
	if (!existsSync(path)) return {};
	const value = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid agent-status.json; expected an object");
	return value;
}

export function sessionReportingProjects(
	target: Target,
	options?: CredentialStoreOpts,
): SessionReportingProject[] | undefined {
	const rows = readConfig(options).sessionReporting;
	if (rows === undefined) return undefined;
	if (
		!Array.isArray(rows) ||
		rows.some(
			(row) =>
				!row ||
				typeof row.workspace !== "string" ||
				typeof row.org !== "string" ||
				typeof row.mcpUrl !== "string" ||
				!looksLikeUuid(row.projectId) ||
				typeof row.enabled !== "boolean" ||
				(row.harness !== undefined &&
					!(REPORTING_HARNESSES as readonly string[]).includes(row.harness)),
		)
	)
		throw new Error("Invalid session reporting settings");
	const matches = (rows as SessionReportingProject[]).filter(
		(row) =>
			row.workspace === target.workspace &&
			row.org === target.org &&
			row.mcpUrl === target.mcpUrl,
	);
	return matches.length ? matches : undefined;
}

export function setSessionReporting(
	target: Target,
	projectIds: string | string[],
	enabled: boolean,
	options?: CredentialStoreOpts,
	harness?: string,
): SessionReportingProject[] {
	const ids = typeof projectIds === "string" ? [projectIds] : projectIds;
	if (!ids.length || !ids.every(looksLikeUuid))
		throw new Error("Session reporting requires --project <UUID>[,<UUID>…]");
	if (
		harness !== undefined &&
		!(REPORTING_HARNESSES as readonly string[]).includes(harness)
	)
		throw new Error(`--harness takes one of ${REPORTING_HARNESSES.join(", ")}`);
	const directory = credentialDirectory(options);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	withFileLockSync(join(directory, "locks", "agent-status"), () => {
		sessionReportingProjects(target, options);
		const config = readConfig(options);
		const rows = (config.sessionReporting ?? []) as SessionReportingProject[];
		config.sessionReporting = [
			...rows.filter(
				(row) =>
					!(
						row.workspace === target.workspace &&
						row.org === target.org &&
						row.mcpUrl === target.mcpUrl &&
						ids.includes(row.projectId) &&
						row.harness === harness
					),
			),
			...ids.map((projectId) => ({
				...target,
				projectId,
				enabled,
				...(harness ? { harness } : {}),
			})),
		];
		const path = join(directory, "agent-status.json");
		const temp = `${path}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	});
	return sessionReportingProjects(target, options)!;
}
