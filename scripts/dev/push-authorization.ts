import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { detachedGitEnv } from "../oss/git-env";

export type PushUpdate = { ref: string; before: string; after: string };
type Row = Record<string, unknown>;
type Read = (args: string[]) => unknown;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ZERO = "0".repeat(40);

function row(value: unknown): Row {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Malformed Tedix authorization response");
	return value as Row;
}

function git(root: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: root,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw new Error(`Cannot read push authorization input: git ${args[0]}`);
	return result.stdout.trim();
}

function trailer(root: string, sha: string, name: string): string {
	const body = git(root, ["show", "-s", "--format=%B", sha]);
	const parsed = spawnSync("git", ["interpret-trailers", "--parse"], {
		cwd: root,
		env: detachedGitEnv(),
		encoding: "utf8",
		input: body,
	});
	if (parsed.status !== 0) throw new Error("Cannot parse commit trailers");
	const values = parsed.stdout
		.split("\n")
		.filter((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
	if (values.length !== 1)
		throw new Error(`${sha}: expected exactly one ${name} trailer`);
	return values[0]!.slice(name.length + 1).trim();
}

/** No local Attempt cache, bot exemption, or offline fallback can authorize a push. */
export function authorizePush(
	root: string,
	updates: PushUpdate[],
	read: Read,
	now = Date.now,
): string[] {
	const auth = row(read(["auth", "status", "--json"]));
	const personal = auth.wouldUse === "stored-login";
	const identity = personal ? {} : row(auth.externalAgent);
	const currentSession = personal ? {} : row(identity.currentSession);
	if (
		!personal &&
		(!identity.configured ||
			!identity.principalId ||
			!identity.organizationId ||
			auth.wouldUse !== `external-agent:${identity.key}`)
	)
		throw new Error("Push requires authenticated external-agent credentials");
	const receipts: string[] = [];
	const expiries: number[] = [];
	for (const update of updates) {
		if (
			![update.before, update.after].every((sha) =>
				/^[0-9a-f]{40}$/.test(sha),
			) ||
			!(
				update.ref === "refs/heads/main" ||
				/^refs\/tags\/(?:v|cli-v|plugin-v)/.test(update.ref)
			)
		)
			throw new Error("Invalid push authorization update");
		if (update.after === ZERO)
			throw new Error(
				"Work authorization does not permit deleting published refs",
			);
		if (update.ref.startsWith("refs/tags/") && update.before !== ZERO)
			throw new Error(
				"Work authorization does not permit rewriting release tags",
			);
		const tip = git(root, [
			"rev-parse",
			"--verify",
			`${update.after}^{commit}`,
		]);
		if (update.ref === "refs/heads/main" && update.before !== ZERO)
			git(root, ["merge-base", "--is-ancestor", update.before, tip]);
		const commits = update.ref.startsWith("refs/tags/")
			? [tip]
			: git(root, [
					"rev-list",
					update.before === ZERO ? tip : `${update.before}..${tip}`,
				])
					.split("\n")
					.filter(Boolean);
		for (const sha of commits) {
			const workId = trailer(root, sha, "Work-Item");
			const session = trailer(root, sha, "Agent-Session");
			if (!UUID.test(workId) || !/^[a-z][a-z0-9-]*:\S+$/.test(session))
				throw new Error(`${sha}: invalid Work or session trailer`);
			const version = (revision: string) => {
				const result = spawnSync(
					"git",
					["show", `${revision}:packages/cli/package.json`],
					{
						cwd: root,
						env: detachedGitEnv(),
						encoding: "utf8",
					},
				);
				return result.status === 0
					? row(JSON.parse(result.stdout)).version
					: undefined;
			};
			const release =
				update.ref.startsWith("refs/tags/cli-v") ||
				/^chore\(cli\): release\b/.test(
					git(root, ["show", "-s", "--format=%s", sha]),
				) ||
				version(sha) !== version(`${sha}^`);
			if (personal) {
				if (!release || trailer(root, sha, "Release-Work-Item") !== workId)
					throw new Error(
						"Personal pushes require a dedicated CLI release Work",
					);
				const authorization = row(
					read([
						"work",
						"authorize-release",
						workId,
						"--input",
						JSON.stringify({
							commitSha: sha,
							ref: update.ref,
							version: version(sha),
						}),
						"--json",
					]),
				);
				if (
					authorization.commitSha !== sha ||
					authorization.ref !== update.ref ||
					!UUID.test(String(authorization.attemptId)) ||
					!UUID.test(String(authorization.orgId)) ||
					typeof authorization.userId !== "string" ||
					!authorization.userId.trim() ||
					session !== `human:${workId}` ||
					!(Date.parse(String(authorization.expiresAt)) > now())
				)
					throw new Error(
						"Personal release requires a live matching Work Attempt for this human and release",
					);
				expiries.push(Date.parse(String(authorization.expiresAt)));
				receipts.push(
					`${update.ref} ${sha}: authorized personal CLI release by Attempt ${authorization.attemptId}`,
				);
				continue;
			}
			const work = row(read(["work", "context", workId, "--json"]));
			const ledger = row(
				read(["work", "attempts", workId, "--limit", "1", "--json"]),
			);
			if (!Array.isArray(ledger.data) || ledger.data.length !== 1)
				throw new Error(`${workId}: no current Attempt`);
			const attempt = row(ledger.data[0]);
			if (
				work.id !== workId ||
				work.orgId !== identity.organizationId ||
				work.disposition !== "accepted" ||
				attempt.runtimeState !== "running" ||
				attempt.outcome !== null ||
				attempt.finishedAt !== null ||
				attempt.executorType !== "external_agent" ||
				attempt.executorId !== identity.principalId ||
				attempt.externalSessionKey !== session ||
				currentSession.externalSessionKey !== session ||
				!(Date.parse(String(attempt.expiresAt)) > now())
			)
				throw new Error(
					`${workId}: push requires a live matching Work Attempt for ${session}`,
				);
			if (
				release &&
				(work.workKind !== "operations" ||
					trailer(root, sha, "Release-Work-Item") !== workId)
			)
				throw new Error(
					`${workId}: CLI release requires dedicated operations Work and matching Release-Work-Item trailer`,
				);
			expiries.push(Date.parse(String(attempt.expiresAt)));
			receipts.push(
				`${update.ref} ${sha}: authorized ${release ? "CLI release" : "push"} by Attempt ${attempt.id}`,
			);
		}
	}
	if (expiries.some((expiry) => expiry <= now()))
		throw new Error("A matching Work Attempt expired during authorization");
	return receipts;
}

if (import.meta.main) {
	try {
		const root = process.cwd();
		const config = (key: string) =>
			spawnSync("git", ["config", "--get", key], {
				cwd: root,
				env: detachedGitEnv(),
				encoding: "utf8",
			}).stdout.trim();
		const organization =
			process.env.TEDIX_PUSH_ORGANIZATION || config("tedix.pushOrganization");
		const workspace =
			process.env.TEDIX_PUSH_WORKSPACE || config("tedix.pushWorkspace");
		if (!organization || !workspace)
			throw new Error(
				"Set tedix.pushOrganization and tedix.pushWorkspace for live push authorization",
			);
		const args = process.argv.slice(2);
		if (!args.length || args.length % 3)
			throw new Error("Expected <remote-ref> <before-sha> <after-sha> updates");
		const updates: PushUpdate[] = [];
		for (let i = 0; i < args.length; i += 3)
			updates.push({
				ref: args[i]!,
				before: args[i + 1]!,
				after: args[i + 2]!,
			});
		const read: Read = (command) => {
			const result = spawnSync(
				"tedix",
				["--organization", organization, "--workspace", workspace, ...command],
				{
					cwd: homedir(),
					env: detachedGitEnv(),
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			if (result.status !== 0)
				throw new Error(
					`Tedix ${command.slice(0, 2).join(" ")} unavailable; push refused`,
				);
			return JSON.parse(result.stdout);
		};
		for (const receipt of authorizePush(root, updates, read))
			console.error(`pre-push: ${receipt}`);
	} catch (error) {
		console.error(
			`pre-push: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}
}
