import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	handoffDelivered,
	parseHandoff,
	runCommitHandoff,
	verifyHandoff,
	writeHandoffReceipt,
} from "./commit-handoff";
import type { ReadJson } from "./hooks/hook-io";

const WORK = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const RECEIVER = "44444444-4444-4444-8444-444444444444";
const SESSION = "codex:33333333-3333-4333-8333-333333333333";
const roots: string[] = [];
const originalGitEnv = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
afterEach(() => {
	for (const [key, value] of Object.entries(originalGitEnv))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const env = { ...process.env };
	for (const key of Object.keys(env))
		if (key.startsWith("GIT_")) delete env[key];
	// Fixture repos must not read the developer's global or system Git config.
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	return execFileSync("git", args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function fixture() {
	// The production Git calls under test keep these and skip host config.
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	const root = mkdtempSync(join(tmpdir(), "tedix-commit-handoff-"));
	roots.push(root);
	const origin = join(root, "origin.git");
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(root, "init", "--bare", "--initial-branch=main", origin);
	git(repo, "init", "--initial-branch=main");
	git(repo, "config", "user.name", "Mac Fixture");
	git(repo, "config", "user.email", "mac@example.invalid");
	git(repo, "remote", "add", "origin", origin);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ scripts: { push: "git push origin HEAD:main" } }),
	);
	writeFileSync(join(repo, "example.txt"), "before\n");
	git(repo, "add", ".");
	git(repo, "commit", "-m", "base");
	git(repo, "push", "origin", "HEAD:main");
	const source = join(root, "source");
	const receiver = join(root, "receiver");
	git(repo, "worktree", "add", "-b", "cloud-fixture", source);
	git(repo, "worktree", "add", "-b", "mac-fixture", receiver);
	writeFileSync(
		join(source, "example.txt"),
		"validated cloud change: café\r\n",
	);
	const binary = randomBytes(65_000);
	writeFileSync(join(source, "binary.bin"), binary);
	git(source, "add", ".");
	git(
		source,
		"-c",
		"user.name=Cloud Fixture",
		"-c",
		"user.email=cloud@example.invalid",
		"commit",
		"-m",
		`Validated fixture\n\nWork-Item: ${WORK}\nAgent-Session: ${SESSION}`,
	);
	const files = new Map<string, string>();
	const comments: string[] = [];
	const read: ReadJson = async (args, _timeout, input) => {
		if (args.includes("auth"))
			return {
				wouldUse: "external-agent:fixture",
				externalAgent: { principalId: RECEIVER },
			};
		if (args.includes("context"))
			return { id: WORK, projectId: PROJECT, disposition: "accepted" };
		if (args.includes("attempts"))
			return {
				data: [
					{
						id: "fixture-attempt",
						executorId: RECEIVER,
						externalSessionKey: SESSION,
						runtimeState: "running",
						expiresAt: new Date(Date.now() + 300_000).toISOString(),
					},
				],
			};
		if (args.includes("comment")) {
			comments.push(args[args.indexOf("comment") + 2]!);
			return { ok: true };
		}
		if (args.includes("interaction-create")) {
			const payload = JSON.parse(
				readFileSync(args[args.indexOf("--input") + 1]!.slice(1), "utf8"),
			);
			const id = randomUUID();
			const request = {
				...payload,
				id,
				version: 1,
				state: "open",
				requestedFromType: payload.requestedFrom.type,
				requestedFromId: payload.requestedFrom.id,
			};
			files.set(id, JSON.stringify(request));
			return request;
		}
		if (
			args.includes("interaction-cancel") ||
			args.includes("interaction-respond")
		) {
			const payload = JSON.parse(
				readFileSync(args[args.indexOf("--input") + 1]!.slice(1), "utf8"),
			);
			const request = JSON.parse(files.get(payload.requestId)!);
			request.state = args.includes("interaction-cancel")
				? "cancelled"
				: "resolved";
			request.version++;
			files.set(payload.requestId, JSON.stringify(request));
			return request;
		}
		if (args.includes("interaction-get"))
			return {
				request: JSON.parse(
					files.get(args[args.indexOf("interaction-get") + 1]!)!,
				),
			};
		throw new Error(`Unexpected read: ${args.join(" ")}`);
	};
	const args = [
		WORK,
		"--to",
		RECEIVER,
		"--workspace",
		"fixture",
		"--organization",
		"org_fixture",
	];
	return {
		root,
		repo,
		source,
		receiver,
		origin,
		files,
		comments,
		read,
		args,
		binary,
	};
}

describe("commit handoff", () => {
	test("rejects changed bytes, missing parts and malformed manifests", () => {
		const bytes = Buffer.from(
			`From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nbody\n`,
		);
		const manifest = parseHandoff({
			version: 1,
			workItemId: WORK,
			projectId: PROJECT,
			repository: "https://example.invalid/repo.git",
			sourceCommit: "a".repeat(40),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
			parts: 1,
			checks: "unit tests passed",
		});
		expect(verifyHandoff(manifest, [bytes.toString("base64")])).toEqual(bytes);
		expect(() => verifyHandoff(manifest, [])).toThrow("Missing");
		const changed = Buffer.from(bytes);
		changed[changed.length - 1] = 0;
		expect(() => verifyHandoff(manifest, [changed.toString("base64")])).toThrow(
			"SHA-256",
		);
		expect(() => parseHandoff({ ...manifest, parts: 2 })).toThrow("Invalid");
		expect(() =>
			verifyHandoff(manifest, [`${bytes.toString("base64")}\n`]),
		).toThrow("Invalid");
	});

	test("binary commit survives upload, failing gate, retry and duplicate delivery", async () => {
		const f = fixture();
		const savedSession = process.env.TEDIX_AGENT_SESSION;
		const savedAgent = process.env.TEDIX_EXTERNAL_AGENT;
		process.env.TEDIX_AGENT_SESSION = SESSION;
		process.env.TEDIX_EXTERNAL_AGENT = "fixture";
		try {
			const submitted = await runCommitHandoff(
				[
					"submit",
					...f.args,
					"--repo",
					f.source,
					"--checks",
					"fixture binary validated",
				],
				f.read,
			);
			expect({
				code: submitted,
				comment: submitted ? f.comments.at(-1) : undefined,
			}).toEqual({ code: 0, comment: undefined });
			const path = [...f.files.keys()].find(
				(id) => JSON.parse(f.files.get(id)!).kind === "handoff",
			)!;
			const manifest = parseHandoff(
				JSON.parse(f.files.get(path)!).metadata.manifest,
			);
			expect(manifest.parts).toBeGreaterThan(1);
			const hook = join(f.repo, ".git", "hooks", "pre-push");
			writeFileSync(
				hook,
				`#!/bin/sh\nif ! test -f '${f.root}/gate-ready'; then\n  echo '✗ private scan (fixture)' >&2\n  exit 1\nfi\n`,
			);
			chmodSync(hook, 0o755);
			const apply = [
				"apply",
				...f.args,
				"--repo",
				f.receiver,
				"--request",
				path,
			];
			expect(await runCommitHandoff(apply, f.read)).toBe(2);
			expect(f.comments.at(-1)).toContain("private scan");
			const imported = git(f.receiver, "rev-parse", "HEAD");
			writeFileSync(join(f.root, "gate-ready"), "ready");
			expect(await runCommitHandoff(apply, f.read)).toBe(0);
			expect(git(f.receiver, "rev-parse", "HEAD")).toBe(imported);
			expect(git(f.receiver, "show", "-s", "--format=%an <%ae>")).toBe(
				"Cloud Fixture <cloud@example.invalid>",
			);
			expect(readFileSync(join(f.receiver, "binary.bin"))).toEqual(f.binary);
			expect(readFileSync(join(f.receiver, "example.txt"), "utf8")).toBe(
				"validated cloud change: café\r\n",
			);
			expect(f.comments.at(-1)).toContain(`Supervisor landed ${imported}`);
			expect(await runCommitHandoff(apply, f.read)).toBe(0);
			expect(f.comments.at(-1)).toContain("already-landed");
			expect(git(f.origin, "rev-parse", "main")).toBe(imported);
		} finally {
			if (savedSession === undefined) delete process.env.TEDIX_AGENT_SESSION;
			else process.env.TEDIX_AGENT_SESSION = savedSession;
			if (savedAgent === undefined) delete process.env.TEDIX_EXTERNAL_AGENT;
			else process.env.TEDIX_EXTERNAL_AGENT = savedAgent;
		}
	}, 30_000);

	test("delivery receipt survives supervisor restart without claiming a push", () => {
		const root = mkdtempSync(join(tmpdir(), "tedix-handoff-receipt-"));
		roots.push(root);
		const env = { TEDIX_CONFIG_DIR: root };
		expect(handoffDelivered(env, "route/one")).toBe(false);
		writeHandoffReceipt(env, "route/one");
		expect(handoffDelivered({ ...env }, "route/one")).toBe(true);
		expect(handoffDelivered(env, "route/two")).toBe(false);
	});
});
