import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { detachedGitEnv } from "../../../scripts/oss/git-env";

export interface LocalInstallation {
	version: 1;
	root: string;
	runnerArgs: string[];
}

export function localInstallationDirectory(): string {
	return process.env.TEDIX_CONFIG_DIR ?? join(homedir(), ".tedix");
}

export function findSourceRoot(cwd: string): string | undefined {
	let candidate = resolve(cwd);
	for (;;) {
		if (existsSync(join(candidate, "scripts/run-local.ts"))) {
			try {
				if (
					JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"))
						.name === "tedix"
				)
					return candidate;
			} catch {
				/* Continue searching ancestors. */
			}
		}
		const parent = dirname(candidate);
		if (parent === candidate) return undefined;
		candidate = parent;
	}
}

export function readLocalInstallation(
	configDir = localInstallationDirectory(),
): LocalInstallation | undefined {
	const path = join(configDir, "local-installation.json");
	if (!existsSync(path)) return undefined;
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as LocalInstallation;
		if (
			value.version !== 1 ||
			typeof value.root !== "string" ||
			!isAbsolute(value.root) ||
			!Array.isArray(value.runnerArgs)
		)
			throw new Error("invalid registration");
		const args = value.runnerArgs;
		if (
			!(
				args.length === 0 ||
				((args.length === 2 ||
					(args.length === 3 &&
						/^--ai-gateway=[a-z0-9][a-z0-9-]{0,63}$/.test(args[2]!))) &&
					args[0] === "--inference=workers-ai" &&
					/^--workers-ai-account=[a-f\d]{32}$/i.test(args[1]!))
			)
		)
			throw new Error("invalid mode");
		if (findSourceRoot(value.root) !== value.root)
			throw new Error("source directory is missing");
		return value;
	} catch {
		throw new Error(
			`Local installation registration is invalid or its source was moved. Run tedix setup --directory <existing-checkout> to repair it. Registration: ${path}`,
		);
	}
}

export function saveLocalInstallation(
	root: string,
	runnerArgs: string[],
	configDir = localInstallationDirectory(),
): void {
	mkdirSync(configDir, { recursive: true });
	const path = join(configDir, "local-installation.json");
	const temporary = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(
			temporary,
			JSON.stringify({ version: 1, root: resolve(root), runnerArgs }, null, 2) +
				"\n",
			{ flag: "wx", mode: 0o600 },
		);
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export interface SourceAcquisition {
	version: string;
	destination: string;
	fetchManifest?: (version: string) => Promise<unknown>;
	runGit?: (args: string[], cwd: string) => Promise<string>;
}

async function fetchManifest(version: string): Promise<unknown> {
	const response = await fetch(
		`https://downloads.tedix.dev/releases/${version}/manifest.json`,
		{ signal: AbortSignal.timeout(30_000) },
	);
	if (!response.ok)
		throw new Error(
			`CLI source release ${version} is unavailable (${response.status}). Run tedix update or use an existing checkout with tedix setup --directory <path>.`,
		);
	return response.json();
}

async function runGit(args: string[], cwd: string): Promise<string> {
	const result = Bun.spawn(["git", ...args], {
		cwd,
		env: detachedGitEnv(),
		stdin: "inherit",
		stdout: "pipe",
		stderr: "inherit",
	});
	const [output, code] = await Promise.all([
		new Response(result.stdout).text(),
		result.exited,
	]);
	if (code !== 0)
		throw new Error(
			"Could not acquire the Tedix source release. Check the Git error above for a network or repository-access failure, then retry. You can also use an existing checkout with tedix setup --directory <path>.",
		);
	return output.trim();
}

export async function acquireLocalSource(
	input: SourceAcquisition,
): Promise<string> {
	if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(input.version))
		throw new Error("Invalid CLI release version");
	const destination = resolve(input.destination);
	if (existsSync(destination))
		throw new Error(
			`Destination already exists: ${destination}. Choose an empty path with tedix setup --directory <path>, or use a Tedix checkout.`,
		);
	const manifest = (await (input.fetchManifest ?? fetchManifest)(
		input.version,
	)) as { version?: unknown; sourceSha?: unknown; tag?: unknown };
	if (
		!manifest ||
		manifest.version !== input.version ||
		manifest.tag !== `cli-v${input.version}` ||
		typeof manifest.sourceSha !== "string" ||
		!/^[a-f\d]{40}$/.test(manifest.sourceSha)
	)
		throw new Error(
			"Invalid CLI source release manifest; no source was executed",
		);
	mkdirSync(dirname(destination), { recursive: true });
	const temporary = mkdtempSync(join(dirname(destination), ".tedix-setup-"));
	const checkout = join(temporary, "source");
	const git = input.runGit ?? runGit;
	try {
		console.log(`Downloading Tedix ${input.version} to ${destination}…`);
		await git(
			[
				"clone",
				"--progress",
				"--depth",
				"1",
				"--branch",
				`cli-v${input.version}`,
				"--",
				"https://github.com/tedix-hq/tedix.git",
				checkout,
			],
			temporary,
		);
		const head = await git(["rev-parse", "HEAD"], checkout);
		if (head !== manifest.sourceSha || findSourceRoot(checkout) !== checkout)
			throw new Error(
				"Downloaded source does not match the CLI release; no source was executed",
			);
		// Recheck after the network operation; never replace a pre-existing destination.
		if (existsSync(destination))
			throw new Error(`Destination appeared during setup: ${destination}`);
		renameSync(checkout, destination);
		return destination;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

export function localPrerequisites(): void {
	if (!Bun.which("bun"))
		throw new Error(
			"Bun is missing from PATH. Install Bun, then rerun tedix setup. The standalone CLI does not install a development toolchain.",
		);
	const result = spawnSync(
		"node",
		[
			"-p",
			"JSON.stringify({ node: process.versions.node, bun: process.versions.bun ?? null })",
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	let node: { node?: string; bun?: unknown } = {};
	try {
		node = JSON.parse(result.stdout ?? "{}");
	} catch {
		/* Report actionable prerequisite below. */
	}
	if (
		result.status !== 0 ||
		node.bun !== null ||
		typeof node.node !== "string" ||
		!/^\d+\.\d+\.\d+/.test(node.node) ||
		Number(node.node.split(".")[0]) < 22
	) {
		throw new Error(
			'Tedix needs genuine Node.js 22+ on PATH for Wrangler. Check node -v. If Homebrew installed node@22, add its bin directory to PATH: export PATH="$(brew --prefix node@22)/bin:$PATH". Then rerun the command.',
		);
	}
}
