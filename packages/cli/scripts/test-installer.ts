import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDir = join(import.meta.dir, "..");
const version = String(
	(
		JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
			version: string;
		}
	).version,
);
const os = process.platform === "darwin" ? "darwin" : process.platform;
const arch = process.arch === "arm64" ? "arm64" : "x64";
const asset = `tedix-${version}-${os}-${arch}`;
const binary = `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then echo "${version}"; else echo tedix; fi\n`;
const checksum = createHash("sha256").update(binary).digest("hex");
const files = new Map([
	["/install.sh", readFileSync(join(packageDir, "install.sh"), "utf8")],
	["/latest.json", `${JSON.stringify({ version })}\n`],
	["/beta.json", `${JSON.stringify({ version })}\n`],
	[`/releases/${version}/${asset}`, binary],
	[`/releases/${version}/SHA256SUMS`, `${checksum}  ${asset}\n`],
]);
let latestFailuresRemaining = 0;
const requests: Array<{
	cacheControl: string | null;
	path: string;
	search: string;
}> = [];
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const url = new URL(request.url);
		requests.push({
			cacheControl: request.headers.get("cache-control"),
			path: url.pathname,
			search: url.search,
		});
		if (url.pathname === "/latest.json" && latestFailuresRemaining > 0) {
			latestFailuresRemaining--;
			return new Response("temporary failure", { status: 503 });
		}
		const body = files.get(url.pathname);
		return body === undefined
			? new Response("Not Found", { status: 404 })
			: new Response(body);
	},
});

const fixtureHome = mkdtempSync(join(tmpdir(), "tedix-installer-home-"));
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

async function runInstaller(env: Record<string, string>): Promise<{
	exitCode: number;
	stderr: string;
	stdout: string;
}> {
	const installer = Bun.spawn(["sh", join(packageDir, "install.sh")], {
		env: {
			HOME: fixtureHome,
			PATH: systemPath,
			TEDIX_CLI_BASE_URL: `http://127.0.0.1:${server.port}`,
			...env,
		},
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(installer.stdout).text(),
		new Response(installer.stderr).text(),
		installer.exited,
	]);
	return { exitCode, stderr, stdout };
}

async function install(env: Record<string, string>): Promise<string> {
	const result = await runInstaller(env);
	if (result.exitCode !== 0) {
		throw new Error(
			`Installer exited ${result.exitCode}:\n${result.stdout}${result.stderr}`,
		);
	}
	return result.stdout;
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

try {
	// The installed binary is the release the manifest names.
	const installDir = mkdtempSync(join(tmpdir(), "tedix-installer-"));
	const onPath = await install({
		PATH: `${installDir}:${systemPath}`,
		TEDIX_INSTALL_DIR: installDir,
	});
	const installed = Bun.spawnSync([join(installDir, "tedix"), "--version"], {
		stderr: "inherit",
		stdout: "pipe",
	});
	const reported = installed.stdout.toString().trim();
	if (installed.exitCode !== 0 || reported !== version) {
		throw new Error(`Installed CLI reported ${reported}; expected ${version}`);
	}
	assert(
		!onPath.includes("not on your PATH"),
		"Installer warned about PATH for a directory already on PATH",
	);
	const latestRequest = requests.find(
		(request) => request.path === "/latest.json",
	);
	assert(
		latestRequest?.cacheControl === "no-cache" &&
			latestRequest.search.startsWith("?t=") &&
			latestRequest.search.length > 3,
		"Installer did not cache-bust latest.json with Cache-Control: no-cache",
	);
	const immutableRequests = requests.filter(
		(request) => request.path !== "/latest.json",
	);
	assert(
		immutableRequests.every(
			(request) => request.cacheControl === null && request.search === "",
		),
		"Installer added mutable-alias cache controls to immutable release objects",
	);

	// A transient release-metadata failure is retried without user intervention.
	const retryInstallDir = mkdtempSync(join(tmpdir(), "tedix-installer-retry-"));
	const retryRequestStart = requests.length;
	latestFailuresRemaining = 1;
	await install({
		PATH: `${retryInstallDir}:${systemPath}`,
		TEDIX_CLI_RETRY_DELAY_SECONDS: "0",
		TEDIX_INSTALL_DIR: retryInstallDir,
	});
	assert(
		requests
			.slice(retryRequestStart)
			.filter((request) => request.path === "/latest.json").length === 2,
		"Installer did not retry a transient latest.json failure",
	);

	// An exact version bypasses the mutable latest alias entirely.
	const exactInstallDir = mkdtempSync(join(tmpdir(), "tedix-installer-exact-"));
	const exactRequestStart = requests.length;
	await install({
		PATH: `${exactInstallDir}:${systemPath}`,
		TEDIX_CLI_VERSION: version,
		TEDIX_INSTALL_DIR: exactInstallDir,
	});
	assert(
		requests
			.slice(exactRequestStart)
			.every((request) => request.path !== "/latest.json"),
		"Exact installer version unexpectedly resolved latest.json",
	);

	// The beta channel resolves beta.json instead of the stable pointer.
	const betaInstallDir = mkdtempSync(join(tmpdir(), "tedix-installer-beta-"));
	const betaRequestStart = requests.length;
	await install({
		PATH: `${betaInstallDir}:${systemPath}`,
		TEDIX_CLI_CHANNEL: "beta",
		TEDIX_INSTALL_DIR: betaInstallDir,
	});
	const betaPaths = requests.slice(betaRequestStart).map(({ path }) => path);
	assert(
		betaPaths.includes("/beta.json") && !betaPaths.includes("/latest.json"),
		"Beta channel did not resolve beta.json",
	);
	const unknownChannel = await runInstaller({
		PATH: `${betaInstallDir}:${systemPath}`,
		TEDIX_CLI_CHANNEL: "nightly",
		TEDIX_INSTALL_DIR: betaInstallDir,
	});
	assert(unknownChannel.exitCode !== 0, "Unknown channel was accepted");

	// Other verified files cannot stand in for the executable being installed.
	const latestBody = files.get("/latest.json")!;
	const latestChecksum = createHash("sha256").update(latestBody).digest("hex");
	const checksumPath = `/releases/${version}/SHA256SUMS`;
	const validChecksums = files.get(checksumPath)!;
	for (const [name, sums] of [
		["missing asset", `${latestChecksum}  latest.json\n`],
		["duplicate asset", `${validChecksums}${validChecksums}`],
		["duplicate malformed asset", `${validChecksums}invalid  ${asset}\n`],
		["malformed asset", `invalid  ${asset}\n`],
		["non-hex checksum", `${"g".repeat(64)}  ${asset}\n`],
		["extra fields", `${checksum}  ${asset} unexpected\n`],
		["wrong checksum", `${"0".repeat(64)}  ${asset}\n`],
	]) {
		files.set(checksumPath, sums!);
		const failureDir = mkdtempSync(
			join(tmpdir(), "tedix-installer-integrity-"),
		);
		const existingPath = join(failureDir, "tedix");
		const existing = "previous installed executable\n";
		writeFileSync(existingPath, existing, { mode: 0o755 });
		const failed = await runInstaller({
			PATH: `${failureDir}:${systemPath}`,
			TEDIX_INSTALL_DIR: failureDir,
		});
		assert(failed.exitCode !== 0, `Installer accepted ${name}`);
		assert(
			readFileSync(existingPath, "utf8") === existing,
			`Installer replaced the existing executable after ${name}`,
		);
	}
	files.set(checksumPath, `${latestChecksum}  latest.json\n${validChecksums}`);
	await install({
		PATH: `${exactInstallDir}:${systemPath}`,
		TEDIX_CLI_VERSION: version,
		TEDIX_INSTALL_DIR: exactInstallDir,
	});
	files.set(checksumPath, validChecksums);
	files.set(checksumPath, `${checksum} *${asset}\n`);
	await install({
		PATH: `${exactInstallDir}:${systemPath}`,
		TEDIX_INSTALL_DIR: exactInstallDir,
	});
	files.set(checksumPath, validChecksums);

	// The public piped command passes version and destination overrides to sh.
	const pipedInstallDir = mkdtempSync(join(tmpdir(), "tedix-installer-pipe-"));
	const pipedRequestStart = requests.length;
	const piped = Bun.spawn(
		[
			"sh",
			"-c",
			'curl -fsSL "$TEDIX_TEST_INSTALLER_URL" | TEDIX_CLI_BASE_URL="$TEDIX_TEST_BASE_URL" TEDIX_CLI_VERSION="$TEDIX_TEST_VERSION" TEDIX_INSTALL_DIR="$TEDIX_TEST_INSTALL_DIR" sh',
		],
		{
			env: {
				HOME: fixtureHome,
				PATH: systemPath,
				TEDIX_TEST_BASE_URL: `http://127.0.0.1:${server.port}`,
				TEDIX_TEST_INSTALLER_URL: `http://127.0.0.1:${server.port}/install.sh`,
				TEDIX_TEST_INSTALL_DIR: pipedInstallDir,
				TEDIX_TEST_VERSION: version,
			},
			stderr: "pipe",
			stdout: "pipe",
		},
	);
	const [pipedStdout, pipedStderr, pipedExitCode] = await Promise.all([
		new Response(piped.stdout).text(),
		new Response(piped.stderr).text(),
		piped.exited,
	]);
	assert(
		pipedExitCode === 0 && existsSync(join(pipedInstallDir, "tedix")),
		`Public piped install failed:\n${pipedStdout}${pipedStderr}`,
	);
	assert(
		requests
			.slice(pipedRequestStart)
			.every((request) => request.path !== "/latest.json"),
		"Public piped exact-version install ignored TEDIX_CLI_VERSION",
	);

	// Checksum verification is isolated from a malformed user locale.
	const checksumTools = mkdtempSync(join(tmpdir(), "tedix-installer-tools-"));
	const fakeShasum = join(checksumTools, "shasum");
	writeFileSync(
		fakeShasum,
		'#!/bin/sh\nif [ "${LC_ALL:-}" != "C" ]; then echo "checksum locale was not normalized" >&2; exit 91; fi\nPATH=/usr/bin:/bin:/usr/sbin:/sbin exec shasum "$@"\n',
	);
	chmodSync(fakeShasum, 0o755);
	const localeInstallDir = mkdtempSync(
		join(tmpdir(), "tedix-installer-locale-"),
	);
	await install({
		LANG: "en_US@rg=dezzzz.UTF-8",
		PATH: `${checksumTools}:${systemPath}`,
		TEDIX_INSTALL_DIR: localeInstallDir,
	});

	// Existing non-writable directories fail with an actionable preflight error.
	const blockedHome = mkdtempSync(join(tmpdir(), "tedix-installer-blocked-"));
	const blockedInstallDir = join(blockedHome, ".local", "bin");
	mkdirSync(blockedInstallDir, { recursive: true });
	chmodSync(blockedInstallDir, 0o555);
	try {
		const blocked = await runInstaller({
			HOME: blockedHome,
			TEDIX_INSTALL_DIR: blockedInstallDir,
		});
		assert(
			blocked.exitCode !== 0,
			"Installer accepted a non-writable directory",
		);
		assert(
			blocked.stderr.includes("install directory is not writable") &&
				blocked.stderr.includes("sudo chown") &&
				!blocked.stderr.includes("INS@"),
			`Installer did not explain the destination failure:\n${blocked.stderr}`,
		);
	} finally {
		chmodSync(blockedInstallDir, 0o755);
	}

	// An install directory outside PATH is added to the shell profile, once.
	const home = mkdtempSync(join(tmpdir(), "tedix-home-"));
	const homeDir = join(home, ".local", "bin");
	const zshrc = join(home, ".zshrc");
	const added = await install({
		HOME: home,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: homeDir,
	});
	assert(added.includes("not on your PATH"), "Installer did not report PATH");
	assert(added.includes(zshrc), "Installer did not name the shell profile");
	const profile = readFileSync(zshrc, "utf8");
	assert(
		profile.includes(`export PATH='${homeDir}':"$PATH"`),
		`Shell profile is missing the PATH export:\n${profile}`,
	);
	const repeated = await install({
		HOME: home,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: homeDir,
	});
	assert(
		repeated.includes("already adds it"),
		"Installer did not detect the existing PATH entry",
	);
	assert(
		readFileSync(zshrc, "utf8") === profile,
		"Installer wrote the PATH export to the shell profile twice",
	);

	// TEDIX_NO_MODIFY_PATH prints the line instead of writing any profile.
	const untouched = mkdtempSync(join(tmpdir(), "tedix-home-"));
	const untouchedDir = join(untouched, ".local", "bin");
	const printed = await install({
		HOME: untouched,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: untouchedDir,
		TEDIX_NO_MODIFY_PATH: "1",
	});
	assert(
		printed.includes(`export PATH='${untouchedDir}':"$PATH"`),
		"Installer did not print the PATH export",
	);
	assert(
		!existsSync(join(untouched, ".zshrc")),
		"Installer wrote a shell profile despite TEDIX_NO_MODIFY_PATH",
	);

	// Profile snippets treat install paths as data, not shell commands.
	const unusualHome = mkdtempSync(join(tmpdir(), "tedix-home-quoted-"));
	const sentinel = join(unusualHome, "executed");
	const unusualDir = join(
		unusualHome,
		"spaces ' quote \\ $HOME `touch executed` $(touch executed)",
	);
	await install({
		HOME: unusualHome,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: unusualDir,
	});
	const evaluated = Bun.spawnSync(
		[
			"sh",
			"-c",
			'. "$1"; printf "%s" "$PATH"',
			"sh",
			join(unusualHome, ".zshrc"),
		],
		{
			cwd: unusualHome,
			env: { PATH: systemPath },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	assert(
		evaluated.exitCode === 0 &&
			evaluated.stdout.toString() === `${unusualDir}:${systemPath}`,
		`Quoted profile changed the path: ${evaluated.stderr.toString()}`,
	);
	assert(
		!existsSync(sentinel),
		"Sourcing the profile executed an install-path command",
	);
	const unusualProfile = readFileSync(join(unusualHome, ".zshrc"), "utf8");
	await install({
		HOME: unusualHome,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: unusualDir,
	});
	assert(
		readFileSync(join(unusualHome, ".zshrc"), "utf8") === unusualProfile,
		"Installer duplicated the escaped PATH entry",
	);
	const unusualPrinted = await install({
		HOME: unusualHome,
		SHELL: "/bin/zsh",
		TEDIX_INSTALL_DIR: unusualDir,
		TEDIX_NO_MODIFY_PATH: "1",
	});
	assert(
		unusualPrinted.includes(unusualProfile.trim().split("\n").at(-1)!),
		"Printed shell snippet altered escape characters",
	);
	const fishHome = mkdtempSync(join(tmpdir(), "tedix-home-fish-"));
	await install({
		HOME: fishHome,
		SHELL: "/usr/bin/fish",
		TEDIX_INSTALL_DIR: unusualDir,
	});
	const fishProfile = readFileSync(
		join(fishHome, ".config", "fish", "config.fish"),
		"utf8",
	);
	const fishQuoted = unusualDir.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
	assert(
		fishProfile.includes(`fish_add_path '${fishQuoted}'`),
		`Fish profile did not quote the literal path: ${fishProfile}`,
	);

	console.log(`installer ${version} ok (${os}-${arch})`);
} finally {
	server.stop(true);
}
