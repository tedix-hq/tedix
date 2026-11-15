import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deployValues } from "@tedix/deploy-values";
import {
	configWithImageReference,
	digestReference,
	dockerCopySources,
	IMAGE_BUILD_FLAGS,
	imageInputTag,
	imageReference,
} from "../src/deploy-image";

/**
 * Deploy docs like `vp build --mode production && cf deploy --prebuilt`, but
 * keyed on the image inputs. When the Dockerfile and the files it copies are
 * unchanged, the image already in the account registry is referenced directly
 * and `vp build` performs no Docker build at all. Any failure in the reuse
 * path falls back to the stock Dockerfile build so a release is never blocked
 * by the optimization.
 *
 * `--build-only` (the package `build` script) stops after `vp build`. Ship
 * builds each migrating surface before applying D1 migrations; without this
 * that check docker-built the whole image again. Without a Cloudflare token
 * it is a plain `vp build`.
 */

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfilePath = join(appDir, "Dockerfile");
const configPath = join(appDir, "cloudflare.config.ts");
const registryHost = "registry.cloudflare.com";
const releaseSha = process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "unknown";
const buildOnly = process.argv.includes("--build-only");

function run(command: string, args: string[], input?: string): void {
	const result = spawnSync(command, args, {
		cwd: appDir,
		stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
		input,
		env: process.env,
	});
	if (result.status !== 0)
		throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

function imageFiles(dockerfile: Buffer): { path: string; contents: Buffer }[] {
	const files = [{ path: "Dockerfile", contents: dockerfile }];
	const pending = dockerCopySources(dockerfile.toString("utf8")).map((source) =>
		join(appDir, source),
	);
	while (pending.length) {
		const absolute = pending.pop();
		if (absolute === undefined) break;
		const stat = statSync(absolute);
		if (stat.isDirectory()) {
			for (const entry of readdirSync(absolute))
				pending.push(join(absolute, entry));
			continue;
		}
		if (stat.isFile())
			files.push({
				path: relative(appDir, absolute),
				contents: readFileSync(absolute),
			});
	}
	return files;
}

async function registryCredentials(
	accountId: string,
	apiToken: string,
): Promise<{ username: string; password: string }> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/registries/${registryHost}/credentials`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${apiToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				permissions: ["push", "pull"],
				expiration_minutes: 5,
			}),
		},
	);
	if (!response.ok) throw new Error(`registry credentials: ${response.status}`);
	const body = (await response.json()) as {
		result?: { username?: string; password?: string };
	};
	const { username, password } = body.result ?? {};
	if (typeof username !== "string" || username === "")
		throw new Error("registry credentials: empty username");
	if (typeof password !== "string" || password === "")
		throw new Error("registry credentials: empty password");
	return { username, password };
}

/** The pushed image's digest reference, or undefined when the tag is missing. */
function pushedImage(reference: string): string | undefined {
	const result = spawnSync("docker", ["manifest", "inspect", "-v", reference], {
		cwd: appDir,
		stdio: ["ignore", "pipe", "ignore"],
		env: process.env,
		encoding: "utf8",
	});
	if (result.status !== 0) return undefined;
	return digestReference(reference, result.stdout);
}

/**
 * The pushed image for these inputs, or undefined when reuse is impossible.
 * Rebuild-and-push happens only when the tag is missing.
 */
async function ensureImage(): Promise<string | undefined> {
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
	if (buildOnly && !apiToken) return undefined;
	// Ship sets only the token; the account comes from the deploy values,
	// as it does for cloudflare.config.ts.
	const accountId =
		process.env.CLOUDFLARE_ACCOUNT_ID ||
		process.env.CF_ACCOUNT_ID ||
		deployValues({ mode: "production" }).account("");
	if (!accountId || !apiToken) {
		console.warn(
			"docs deploy: no Cloudflare account credentials; building the image with the Dockerfile",
		);
		return undefined;
	}
	const dockerfile = readFileSync(dockerfilePath);
	const reference = imageReference(
		accountId,
		imageInputTag(imageFiles(dockerfile)),
	);
	const credentials = await registryCredentials(accountId, apiToken);
	run(
		"docker",
		[
			"login",
			registryHost,
			"--username",
			credentials.username,
			"--password-stdin",
		],
		`${credentials.password}\n`,
	);
	const existing = pushedImage(reference);
	if (existing !== undefined) {
		console.log(`docs deploy: reusing image ${existing}`);
		return existing;
	}
	console.log(`docs deploy: building image ${reference}`);
	run("docker", [
		"build",
		...IMAGE_BUILD_FLAGS,
		"--file",
		dockerfilePath,
		"--tag",
		reference,
		appDir,
	]);
	run("docker", ["push", reference]);
	const pushed = pushedImage(reference);
	if (pushed === undefined)
		throw new Error(`pushed ${reference} is not readable`);
	return pushed;
}

let reference: string | undefined;
try {
	reference = await ensureImage();
} catch (error) {
	console.warn(
		`docs deploy: image reuse failed (${error instanceof Error ? error.message : error}); building with the Dockerfile`,
	);
}

const buildArgs = buildOnly ? ["build"] : ["build", "--mode", "production"];
const deployArgs = [
	"deploy",
	"--mode",
	"production",
	"--prebuilt",
	"--message",
	releaseSha,
];

function deployFromDockerfile(): void {
	run("vp", buildArgs);
	if (!buildOnly) run("cf", deployArgs);
}

function deployWithReference(reference: string): void {
	const original = readFileSync(configPath, "utf8");
	writeFileSync(configPath, configWithImageReference(original, reference));
	try {
		run("vp", buildArgs);
	} finally {
		writeFileSync(configPath, original);
	}
	if (!buildOnly) run("cf", deployArgs);
}

if (reference === undefined) {
	deployFromDockerfile();
} else {
	try {
		deployWithReference(reference);
	} catch (error) {
		console.warn(
			`docs deploy: ${buildOnly ? "building" : "deploying"} ${reference} failed (${error instanceof Error ? error.message : error}); building with the Dockerfile`,
		);
		deployFromDockerfile();
	}
}
