import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cliRead, type ReadJson, UUID } from "./hooks/hook-io";

const CHUNK_BYTES = 18_000;
const MAX_BYTES = 3_000_000;
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TRANSFER_SCHEMA = "commit-handoff-v1";
const PART_SCHEMA = "commit-handoff-part-v1";

export interface CommitHandoff {
	version: 1;
	workItemId: string;
	projectId: string;
	repository: string;
	sourceCommit: string;
	sha256: string;
	size: number;
	parts: number;
	checks: string;
}

export interface HandoffRoute {
	workspace: string;
	organization: string;
	receiverId: string;
	projectId: string;
	repository: string;
	session: string;
	cwd: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHandoff(value: unknown): CommitHandoff {
	if (
		!object(value) ||
		value.version !== 1 ||
		typeof value.workItemId !== "string" ||
		!UUID.test(value.workItemId) ||
		typeof value.projectId !== "string" ||
		!UUID.test(value.projectId) ||
		typeof value.repository !== "string" ||
		!value.repository ||
		value.repository.length > 500 ||
		typeof value.sourceCommit !== "string" ||
		!SHA.test(value.sourceCommit) ||
		typeof value.sha256 !== "string" ||
		!DIGEST.test(value.sha256) ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 1 ||
		value.size > MAX_BYTES ||
		value.parts !== Math.ceil(value.size / CHUNK_BYTES) ||
		typeof value.checks !== "string" ||
		!value.checks.trim() ||
		value.checks.length > 4000
	)
		throw new Error("Invalid commit handoff manifest");
	return value as unknown as CommitHandoff;
}

export function verifyHandoff(handoff: CommitHandoff, parts: string[]): Buffer {
	if (parts.length !== handoff.parts)
		throw new Error("Missing commit handoff part");
	const chunks = parts.map((part, index) => {
		const bytes = Buffer.from(part, "base64");
		if (
			bytes.toString("base64") !== part ||
			bytes.length !== Math.min(CHUNK_BYTES, handoff.size - index * CHUNK_BYTES)
		)
			throw new Error("Invalid commit handoff part");
		return bytes;
	});
	const bytes = Buffer.concat(chunks);
	if (createHash("sha256").update(bytes).digest("hex") !== handoff.sha256)
		throw new Error("Commit handoff SHA-256 mismatch");
	if (
		!bytes
			.subarray(0, 80)
			.toString()
			.startsWith(`From ${handoff.sourceCommit} Mon Sep 17 00:00:00 2001\n`)
	)
		throw new Error("Commit handoff source commit mismatch");
	if (
		(
			bytes
				.toString()
				.match(/^From [a-f0-9]{40} Mon Sep 17 00:00:00 2001$/gm) ?? []
		).length !== 1
	)
		throw new Error("Commit handoff must contain exactly one commit");
	return bytes;
}

function selectors(
	route: Pick<HandoffRoute, "workspace" | "organization">,
): string[] {
	return ["--workspace", route.workspace, "--organization", route.organization];
}

async function interactionInput(
	read: ReadJson,
	route: Pick<HandoffRoute, "workspace" | "organization">,
	input: Record<string, unknown>,
	verb = "interaction-create",
): Promise<Record<string, unknown>> {
	const dir = mkdtempSync(join(tmpdir(), "tedix-commit-upload-"));
	const path = join(dir, "input.json");
	try {
		writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
		return await read(
			[
				...selectors(route),
				"work",
				verb,
				...(verb === "interaction-respond" ? ["--no-deliver"] : []),
				"--input",
				`@${path}`,
				"--json",
			],
			30_000,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function readTransfer(
	read: ReadJson,
	route: HandoffRoute,
	requestId: string,
): Promise<{
	manifest: CommitHandoff;
	partIds: string[];
	version: number;
	open: boolean;
}> {
	if (!UUID.test(requestId)) throw new Error("Invalid commit handoff request");
	const detail = await read(
		[...selectors(route), "work", "interaction-get", requestId, "--json"],
		30_000,
	);
	const request = detail.request;
	if (
		!object(request) ||
		request.id !== requestId ||
		request.kind !== "handoff" ||
		typeof request.version !== "number" ||
		request.requestedFromType !== "external_agent" ||
		request.requestedFromId !== route.receiverId ||
		!object(request.metadata) ||
		request.metadata.schema !== TRANSFER_SCHEMA
	)
		throw new Error("Invalid commit handoff request");
	const manifest = parseHandoff(request.metadata.manifest);
	const partIds = request.metadata.partIds;
	if (
		request.workItemId !== manifest.workItemId ||
		manifest.repository !== route.repository ||
		manifest.projectId !== route.projectId ||
		!Array.isArray(partIds) ||
		partIds.length !== manifest.parts ||
		!partIds.every((id: unknown) => typeof id === "string" && UUID.test(id)) ||
		new Set(partIds).size !== partIds.length
	)
		throw new Error("Handoff repository, project or parts mismatch");
	return {
		manifest,
		partIds: partIds as string[],
		version: request.version,
		open: request.state === "open",
	};
}

export function readHandoffRoutes(env: NodeJS.ProcessEnv): HandoffRoute[] {
	const path = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"commit-handoffs.json",
	);
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	if (!Array.isArray(value) || value.length > 10)
		throw new Error("Invalid commit handoff routes");
	return value.map((row) => {
		if (
			!object(row) ||
			![
				"workspace",
				"organization",
				"receiverId",
				"projectId",
				"repository",
				"session",
				"cwd",
			].every((key) => typeof row[key] === "string" && row[key]) ||
			!UUID.test(String(row.projectId)) ||
			!UUID.test(String(row.session)) ||
			!UUID.test(String(row.receiverId))
		)
			throw new Error("Invalid commit handoff route");
		return row as unknown as HandoffRoute;
	});
}

export async function pendingHandoffs(
	read: ReadJson,
	route: HandoffRoute,
): Promise<Array<{ path: string; manifest: CommitHandoff }>> {
	const rows: Array<{ path: string; manifest: CommitHandoff }> = [];
	let cursor: unknown;
	for (let page = 0; page < 10; page++) {
		const input = {
			projectId: route.projectId,
			kinds: ["handoff"],
			states: ["open"],
			limit: 100,
			...(cursor ? { cursor } : {}),
		};
		const result = await read(
			[
				...selectors(route),
				"work",
				"interaction-audit-list",
				"--input",
				JSON.stringify(input),
				"--json",
			],
			30_000,
		);
		if (!Array.isArray(result.data)) throw new Error("Invalid handoff inbox");
		for (const row of result.data) {
			if (!object(row) || !object(row.request)) continue;
			const request = row.request;
			if (
				request.requestedFromType !== "external_agent" ||
				request.requestedFromId !== route.receiverId ||
				!object(request.metadata) ||
				request.metadata.schema !== TRANSFER_SCHEMA
			)
				continue;
			const { manifest } = await readTransfer(read, route, String(request.id));
			rows.push({ path: String(request.id), manifest });
		}
		if (!result.hasMore) return rows;
		if (!result.nextCursor) throw new Error("Incomplete handoff inbox cursor");
		cursor = result.nextCursor;
	}
	throw new Error("Handoff inbox exceeds ten pages; archive finished handoffs");
}

function git(cwd: string, args: string[], input?: Buffer): Buffer {
	const env = { ...process.env };
	// Keep explicit config isolation (lane identity file, /dev/null in tests);
	// drop inherited repository state so handoff Git stays predictable.
	for (const key of Object.keys(env))
		if (
			key.startsWith("GIT_") &&
			![
				"GIT_CONFIG_GLOBAL",
				"GIT_CONFIG_NOSYSTEM",
				"GIT_CONFIG_SYSTEM",
			].includes(key)
		)
			delete env[key];
	const result = spawnSync("git", args, {
		cwd,
		env,
		input,
		maxBuffer: MAX_BYTES + 64_000,
		timeout: 30_000,
	});
	if (result.status !== 0)
		throw new Error(
			`Git ${args[0]} failed (exit ${result.status ?? "unknown"})`,
		);
	return result.stdout;
}

async function pushWithGates(cwd: string): Promise<void> {
	await new Promise<void>((done, reject) => {
		const child = spawn("bun", ["run", "push"], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let tail = "";
		const output = (target: NodeJS.WriteStream) => (chunk: Buffer) => {
			target.write(chunk);
			tail = (tail + chunk.toString()).slice(-64_000);
		};
		child.stdout.on("data", output(process.stdout));
		child.stderr.on("data", output(process.stderr));
		child.once("error", () =>
			reject(new Error("Could not launch bun run push")),
		);
		child.once("close", (status) => {
			if (status === 0) return done();
			const gates = [...tail.matchAll(/^✗ ([a-zA-Z0-9 :/_-]{1,80}) \(/gm)].map(
				(match) => match[1],
			);
			reject(
				new Error(
					`bun run push failed (exit ${status}); gates: ${gates.join(", ") || "push hook or queue; see receiver log"}`,
				),
			);
		});
	});
}

export async function runCommitHandoff(
	args: string[],
	read: ReadJson = cliRead,
): Promise<number> {
	if (!args.length || args.includes("--help")) {
		console.log(
			"tedix commit-handoff submit <work-id> --to <receiver-principal-uuid> --checks <validation summary> [--commit HEAD] [--repo <path>] --workspace <profile> --organization <org>\ntedix commit-handoff apply <work-id> --to <receiver-principal-uuid> --request <handoff-request-uuid> [--repo <isolated worktree>] --workspace <profile> --organization <org>\nThe receiver needs its own current admitted Attempt. Routine failures are commented on Work. No Attempt is started or settled by these commands.",
		);
		return 0;
	}
	const [action, workItemId] = args;
	if (
		!["submit", "apply"].includes(action ?? "") ||
		!UUID.test(workItemId ?? "")
	)
		throw new Error("Expected submit|apply and a Work UUID");
	const flags: Record<string, string> = {};
	for (let i = 2; i < args.length; i += 2) {
		const key = args[i]!;
		const value = args[i + 1];
		if (
			![
				"--to",
				"--checks",
				"--commit",
				"--repo",
				"--workspace",
				"--organization",
				"--request",
			].includes(key) ||
			flags[key] ||
			!value ||
			value.startsWith("--")
		)
			throw new Error(`Invalid handoff option: ${key}`);
		flags[key] = value;
	}
	if (
		!flags["--workspace"] ||
		!flags["--organization"] ||
		!UUID.test(flags["--to"] ?? "")
	)
		throw new Error(
			"Handoff requires explicit workspace, organization and receiver principal",
		);
	const cwd = resolve(flags["--repo"] || process.cwd());
	const route: HandoffRoute = {
		workspace: flags["--workspace"]!,
		organization: flags["--organization"]!,
		receiverId: flags["--to"]!,
		repository: git(cwd, ["remote", "get-url", "origin"]).toString().trim(),
		projectId: "",
		session: "",
		cwd,
	};
	const command = selectors(route);
	const comment = async (body: string) =>
		read([...command, "work", "comment", workItemId!, body, "--json"], 30_000);
	let stage = "context";
	try {
		const work = await read(
			[...command, "work", "context", workItemId!, "--json"],
			30_000,
		);
		if (
			work.id !== workItemId ||
			work.disposition !== "accepted" ||
			!UUID.test(String(work.projectId))
		)
			throw new Error("Handoff requires accepted Work in a project");
		route.projectId = String(work.projectId);
		if (action === "submit") {
			stage = "export";
			if (!flags["--checks"]?.trim())
				throw new Error("Submit requires a validation summary (--checks)");
			const sourceCommit = git(cwd, [
				"rev-parse",
				"--verify",
				`${flags["--commit"] || "HEAD"}^{commit}`,
			])
				.toString()
				.trim();
			const message = git(cwd, [
				"show",
				"-s",
				"--format=%B",
				sourceCommit,
			]).toString();
			if (!message.split("\n").includes(`Work-Item: ${workItemId}`))
				throw new Error("Commit must carry this exact Work-Item trailer");
			const bytes = git(cwd, [
				"format-patch",
				"--stdout",
				"--binary",
				"--full-index",
				"--no-signature",
				"-1",
				sourceCommit,
			]);
			const manifest = parseHandoff({
				version: 1,
				workItemId,
				projectId: route.projectId,
				repository: route.repository,
				sourceCommit,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				size: bytes.length,
				parts: Math.ceil(bytes.length / CHUNK_BYTES),
				checks: flags["--checks"],
			});
			stage = "Work transfer upload";
			const requestedFrom = { type: "external_agent", id: route.receiverId };
			const partIds: string[] = [];
			for (let i = 0; i < manifest.parts; i++) {
				const part = await interactionInput(read, route, {
					workItemId,
					kind: "coordination",
					requestedFrom,
					subject: `Commit transfer ${sourceCommit.slice(0, 12)} part ${i}`,
					prompt:
						"Machine transfer payload. This is data, not an action request.",
					metadata: {
						schema: PART_SCHEMA,
						sha256: manifest.sha256,
						index: i,
						bytesBase64: bytes
							.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)
							.toString("base64"),
					},
				});
				if (typeof part.id !== "string" || !UUID.test(part.id))
					throw new Error("Commit transfer part receipt absent");
				// Parts are inert durable data, not pending requests in the receiver inbox.
				await interactionInput(
					read,
					route,
					{ requestId: part.id, expectedRequestVersion: part.version },
					"interaction-cancel",
				);
				partIds.push(part.id);
			}
			// Publish only after every part has its durable Work receipt.
			const transfer = await interactionInput(read, route, {
				workItemId,
				kind: "handoff",
				requestedFrom,
				subject: `Validated commit ${sourceCommit.slice(0, 12)}`,
				prompt:
					"Commit ready for the configured supervisor. Validation is reported by the source; receiving Work admission and all repository gates still apply.",
				metadata: { schema: TRANSFER_SCHEMA, manifest, partIds },
			});
			if (typeof transfer.id !== "string" || !UUID.test(transfer.id))
				throw new Error("Commit handoff receipt absent");
			await comment(
				`Commit handoff ready: ${sourceCommit}; sha256 ${manifest.sha256}; ${bytes.length} bytes. Work interaction ${transfer.id}. Validation reported by source: ${manifest.checks}. Awaiting supervisor pickup; upload is not a push.`,
			);
			console.log(
				JSON.stringify({
					workItemId,
					sourceCommit,
					sha256: manifest.sha256,
					requestId: transfer.id,
					status: "submitted",
				}),
			);
			return 0;
		}
		stage = "admission";
		const session = process.env.TEDIX_AGENT_SESSION;
		if (!session || !process.env.TEDIX_EXTERNAL_AGENT)
			throw new Error("Receiver needs its own verified agent identity");
		const auth = await read([...command, "auth", "status", "--json"], 10_000);
		if (
			auth.wouldUse !== `external-agent:${process.env.TEDIX_EXTERNAL_AGENT}` ||
			!object(auth.externalAgent) ||
			typeof auth.externalAgent.principalId !== "string"
		)
			throw new Error(
				"Receiver credential does not match its selected external agent",
			);
		const principal = auth.externalAgent.principalId;
		if (principal !== route.receiverId)
			throw new Error("Handoff is addressed to another receiver");
		let attemptId: string | undefined;
		const checkAdmission = async () => {
			const attempts = await read(
				[
					...command,
					"work",
					"attempts",
					workItemId!,
					"--json",
					"--limit",
					"100",
				],
				30_000,
			);
			const owned = Array.isArray(attempts.data)
				? attempts.data.filter(
						(row: unknown) =>
							object(row) &&
							row.executorId === principal &&
							row.externalSessionKey === session &&
							row.runtimeState === "running" &&
							Date.parse(String(row.expiresAt)) > Date.now(),
					)
				: [];
			if (
				owned.length !== 1 ||
				typeof owned[0].id !== "string" ||
				(attemptId && owned[0].id !== attemptId)
			)
				throw new Error("Receiver has no matching current admitted Attempt");
			attemptId = owned[0].id;
		};
		await checkAdmission();
		stage = "download and digest";
		const requestId = flags["--request"] ?? "";
		const { manifest, partIds, version, open } = await readTransfer(
			read,
			route,
			requestId,
		);
		const closeTransfer = async (landed: string) => {
			if (open)
				await interactionInput(
					read,
					route,
					{
						requestId,
						expectedRequestVersion: version,
						responseKind: "handoff_accepted",
						body: `Landed ${landed}; source ${manifest.sourceCommit}; sha256 ${manifest.sha256}.`,
						resolvesRequest: true,
						metadata: { delivery: "none" },
					},
					"interaction-respond",
				);
		};
		if (manifest.workItemId !== workItemId)
			throw new Error("Handoff Work mismatch");
		const parts: string[] = [];
		for (let i = 0; i < manifest.parts; i++) {
			const detail = await read(
				[...command, "work", "interaction-get", partIds[i]!, "--json"],
				30_000,
			);
			const part = detail.request;
			if (
				!object(part) ||
				part.id !== partIds[i] ||
				part.workItemId !== workItemId ||
				part.requestedFromType !== "external_agent" ||
				part.requestedFromId !== route.receiverId ||
				!object(part.metadata) ||
				part.metadata.schema !== PART_SCHEMA ||
				part.metadata.sha256 !== manifest.sha256 ||
				part.metadata.index !== i ||
				typeof part.metadata.bytesBase64 !== "string"
			)
				throw new Error("Invalid commit transfer part");
			parts.push(part.metadata.bytesBase64);
		}
		const bytes = verifyHandoff(manifest, parts);
		await checkAdmission();
		stage = "isolated worktree";
		if (
			git(cwd, ["rev-parse", "--git-dir"]).toString().trim() ===
			git(cwd, ["rev-parse", "--git-common-dir"]).toString().trim()
		)
			throw new Error("Apply requires an isolated worktree");
		if (git(cwd, ["status", "--porcelain"]).length)
			throw new Error("Receiver worktree is dirty");
		git(cwd, ["fetch", "origin", "main"]);
		const marker = `Handoff-Digest: ${manifest.sha256}`;
		const prior = git(cwd, [
			"log",
			"FETCH_HEAD",
			"--format=%H",
			"--fixed-strings",
			`--grep=${marker}`,
			"-1",
		])
			.toString()
			.trim();
		if (prior) {
			await closeTransfer(prior);
			await comment(
				`Supervisor verified already-landed ${prior} on main for source ${manifest.sourceCommit}; sha256 ${manifest.sha256}. Duplicate handoff not reapplied.`,
			);
			console.log(
				JSON.stringify({ workItemId, landed: prior, status: "already_pushed" }),
			);
			return 0;
		}
		stage = "git am -3";
		const currentMessage = git(cwd, [
			"show",
			"-s",
			"--format=%B",
			"HEAD",
		]).toString();
		if (!currentMessage.split("\n").includes(marker)) {
			try {
				git(cwd, ["am", "--keep-cr", "-3"], bytes);
			} catch (error) {
				git(cwd, ["am", "--abort"]);
				throw error;
			}
			git(cwd, ["commit", "--amend", "--no-edit", "--trailer", marker]);
		}
		stage = "pre-push gates";
		await checkAdmission();
		// Never bypass the repository queue or its private pre-push hooks.
		await pushWithGates(cwd);
		const landed = git(cwd, ["rev-parse", "HEAD"]).toString().trim();
		stage = "remote verification";
		git(cwd, ["fetch", "origin", "main"]);
		git(cwd, ["merge-base", "--is-ancestor", landed, "FETCH_HEAD"]);
		await closeTransfer(landed);
		await comment(
			`Supervisor landed ${landed} on main from source ${manifest.sourceCommit}; sha256 ${manifest.sha256}. git am -3 preserved authorship; bun run push passed. Remote main verified at ${landed}.`,
		);
		console.log(
			JSON.stringify({
				workItemId,
				sourceCommit: manifest.sourceCommit,
				landed,
				status: "pushed",
			}),
		);
		return 0;
	} catch (error) {
		// Gate logs can contain private rules or matched source: keep them off Work.
		await comment(
			`Commit handoff failed at ${stage}. No completion claimed. Receiver diagnostics: ${error instanceof Error ? error.message : "unknown failure"}. Routine failure recorded here; no human relay requested.`,
		);
		return 2;
	}
}

export function writeHandoffReceipt(env: NodeJS.ProcessEnv, key: string): void {
	const dir = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"commit-handoff-receipts",
	);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(
		dir,
		`${createHash("sha256").update(key).digest("hex")}.json`,
	);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(
		temporary,
		JSON.stringify({ key, deliveredAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
	renameSync(temporary, path);
}

export function handoffDelivered(env: NodeJS.ProcessEnv, key: string): boolean {
	const path = join(
		env.TEDIX_CONFIG_DIR || join(homedir(), ".tedix"),
		"commit-handoff-receipts",
		`${createHash("sha256").update(key).digest("hex")}.json`,
	);
	try {
		return JSON.parse(readFileSync(path, "utf8")).key === key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
