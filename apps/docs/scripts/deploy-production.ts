import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	configWithImageReference,
	dockerCopySources,
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
 */

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dockerfilePath = join(appDir, "Dockerfile");
const configPath = join(appDir, "cloudflare.config.ts");
const registryHost = "registry.cloudflare.com";
const releaseSha = process.env.GIT_SHA ?? process.env.GITHUB_SHA ?? "unknown";

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

async function registryPassword(
	accountId: string,
	apiToken: string,
): Promise<string> {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/registry/credentials`,
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
		result?: { password?: string };
	};
	const password = body.result?.password;
	if (typeof password !== "string" || password === "")
		throw new Error("registry credentials: empty password");
	return password;
}

function imageExists(reference: string): boolean {
	return (
		spawnSync("docker", ["manifest", "inspect", reference], {
			cwd: appDir,
			stdio: "ignore",
			env: process.env,
		}).status === 0
	);
}

/**
 * The pushed image for these inputs, or undefined when reuse is impossible.
 * Rebuild-and-push happens only when the tag is missing.
 */
async function ensureImage(): Promise<string | undefined> {
	const accountId =
		process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
	const apiToken = process.env.CLOUDFLARE_API_TOKEN;
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
	run(
		"docker",
		["login", registryHost, "--username", "v1", "--password-stdin"],
		`${await registryPassword(accountId, apiToken)}\n`,
	);
	if (imageExists(reference)) {
		console.log(`docs deploy: reusing image ${reference}`);
		return reference;
	}
	console.log(`docs deploy: building image ${reference}`);
	run("docker", [
		"build",
		"--platform",
		"linux/amd64",
		"--file",
		dockerfilePath,
		"--tag",
		reference,
		appDir,
	]);
	run("docker", ["push", reference]);
	return reference;
}

let reference: string | undefined;
try {
	reference = await ensureImage();
} catch (error) {
	console.warn(
		`docs deploy: image reuse failed (${error instanceof Error ? error.message : error}); building with the Dockerfile`,
	);
}

if (reference === undefined) {
	run("vp", ["build", "--mode", "production"]);
} else {
	const original = readFileSync(configPath, "utf8");
	let substituted: string;
	try {
		substituted = configWithImageReference(original, reference);
	} catch (error) {
		console.warn(
			`docs deploy: ${error instanceof Error ? error.message : error}; building with the Dockerfile`,
		);
		run("vp", ["build", "--mode", "production"]);
		substituted = "";
	}
	if (substituted !== "") {
		writeFileSync(configPath, substituted);
		try {
			run("vp", ["build", "--mode", "production"]);
		} finally {
			writeFileSync(configPath, original);
		}
	}
}
run("cf", [
	"deploy",
	"--mode",
	"production",
	"--prebuilt",
	"--message",
	releaseSha,
]);
