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
				typeof row.enabled !== "boolean",
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
	projectId: string,
	enabled: boolean,
	options?: CredentialStoreOpts,
): SessionReportingProject[] {
	if (!looksLikeUuid(projectId))
		throw new Error("Session reporting requires --project <UUID>");
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
						row.projectId === projectId
					),
			),
			{ ...target, projectId, enabled },
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
