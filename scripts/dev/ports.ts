#!/usr/bin/env bun

/**
 * The one derived inventory of ports a root `bun dev` reserves.
 *
 * The table used to live in four hand-kept copies (each `wrangler.jsonc` dev
 * block, each package.json `clear-port` args, cleanup-dev.sh's PORTS arrays,
 * and a docs table). Adding an app meant editing four places, and a missed one
 * showed up as a mystery "address already in use" mid-startup. Everything here
 * is read back out of the file that actually decides the port, so there is one
 * copy plus the small DECLARED_ADAPTER_PORTS table below.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";

export type DevPortKind = "service" | "inspector" | "adapter";

export type DevPortReservation = {
	/** Directory name under apps/, which is how cleanup and docs name it. */
	app: string;
	port: number;
	kind: DevPortKind;
	/** Repo-relative file the value was read from, for conflict messages. */
	source: string;
};

/**
 * Ports no config file states in a machine-readable way.
 *
 * The Astro Cloudflare adapter's inspector port is computed inside
 * `apps/<app>/astro.config.mjs` as `Number(process.env.<X>_INSPECTOR_PORT ?? N)`
 * — an expression, not data, so it cannot be read without executing the
 * config. The literal `N` lives there; this is the single mirror of it, and
 * `ports.test.ts` asserts the two still agree. Note these apps ALSO declare a
 * `dev.inspector_port` in their `wrangler.jsonc`, which is NOT reserved during
 * `bun dev` because their dev script runs `astro dev`, never `wrangler dev`.
 */
const DECLARED_ADAPTER_PORTS: Readonly<Record<string, number>> = {
	landing: 9233,
	"mcp-ui": 9231,
};

type PackageScripts = Record<string, string>;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readScripts(packagePath: string): PackageScripts | undefined {
	const parsed = readJson(packagePath);
	if (!parsed || typeof parsed !== "object") return undefined;
	const scripts = (parsed as { scripts?: unknown }).scripts;
	if (!scripts || typeof scripts !== "object") return undefined;
	const output: PackageScripts = {};
	for (const [key, value] of Object.entries(scripts)) {
		if (typeof value === "string") output[key] = value;
	}
	return output;
}

/**
 * Flatten `bun run <other-script>` indirection so the port survives it.
 * `apps/os` hides its real command two hops down: `dev` -> `dev:fixtures` ->
 * `vp dev --port 3010`.
 */
export function expandScript(
	scripts: PackageScripts,
	name: string,
	seen = new Set<string>(),
): string {
	const body = scripts[name];
	if (body === undefined || seen.has(name)) return "";
	seen.add(name);
	return body.replace(
		/\bbun\s+(?:--bun\s+)?run\s+([\w:.-]+)/g,
		(match, referenced: string) => {
			const expanded = expandScript(scripts, referenced, seen);
			return expanded === "" ? match : ` ${expanded} `;
		},
	);
}

/** `--port 3010` and `--port=3010` are both in use across these scripts. */
function explicitPortFlag(command: string): number | undefined {
	const match = command.match(/--port[\s=]+(\d+)/);
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

function parseJsonc(path: string): unknown {
	const errors: ParseError[] = [];
	// Several wrangler.jsonc files carry comments AND trailing commas, so a
	// plain JSON.parse throws on them.
	const parsed = parse(readFileSync(path, "utf8"), errors, {
		allowTrailingComma: true,
	}) as unknown;
	return errors.length > 0 ? undefined : parsed;
}

function devBlockPort(config: unknown, field: string): number | undefined {
	if (!config || typeof config !== "object") return undefined;
	const dev = (config as { dev?: unknown }).dev;
	if (!dev || typeof dev !== "object") return undefined;
	const value = (dev as Record<string, unknown>)[field];
	return typeof value === "number" && Number.isInteger(value)
		? value
		: undefined;
}

/**
 * For a `vp dev` app the vite config, not wrangler.jsonc, decides both ports:
 * Vite binds `server.port` and the Cloudflare plugin binds the `inspectorPort`
 * passed to `cloudflare({ ... })`. Neither reads the wrangler `dev` block —
 * `vite-plus` does not mention wrangler at all, and the plugin defaults its
 * inspector to 9229 when the option is absent. These apps mirror both numbers
 * into wrangler.jsonc for deploy shape, so they agree today; read them here
 * anyway so a conflict message points at the file that actually binds.
 */
function viteConfigPorts(path: string): {
	service?: number;
	inspector?: number;
} {
	if (!existsSync(path)) return {};
	const source = readFileSync(path, "utf8");
	// `[^{}]` keeps the scan inside the `server` block: a server block with no
	// port of its own must not reach past its own brace and adopt a later
	// block's port (`preview: { port: 4173 }` would otherwise be read as the
	// dev port). Falling back to the wrangler mirror is the safe answer there.
	const service = source.match(/\bserver\s*:\s*\{[^{}]*?\bport\s*:\s*(\d+)/);
	const inspector = source.match(/\binspectorPort\s*:\s*(\d+)/);
	return {
		service: service?.[1] === undefined ? undefined : Number(service[1]),
		inspector: inspector?.[1] === undefined ? undefined : Number(inspector[1]),
	};
}

function collectApp(root: string, app: string): DevPortReservation[] {
	const appDir = join(root, "apps", app);
	const scripts = readScripts(join(appDir, "package.json"));
	// Only a `dev` script starts under `vp run -r --parallel dev`; an app
	// without one reserves nothing during a root `bun dev`.
	if (!scripts?.dev) return [];

	const command = expandScript(scripts, "dev");
	// `wrangler dev` reads the committed wrangler.jsonc dev block. `astro dev`
	// does not, so an Astro app's wrangler dev block is deploy-shape config,
	// not a live reservation. `vp dev` does not read it either (see
	// `viteConfigPorts`) — the Cloudflare plugin's own options decide the ports
	// — but every `vp dev` app mirrors them into its vite config, so the
	// wrangler block stays a fallback for an app that ships none.
	//
	// An app with neither is a real defect, not a reservation: `vp dev` with no
	// vite config silently starts a bare Vite server on the default 5173 with
	// no Cloudflare plugin, so the Worker never runs and its bindings do not
	// exist. artifact-gateway and session-broker were both in that state and
	// raced each other for 5173/5174; both now ship a vite config.
	const runsVite = /\bvp\s+dev\b/.test(command);
	const readsWranglerConfig = /\bwrangler\s+dev\b/.test(command) || runsVite;
	const wranglerPath = join(appDir, "wrangler.jsonc");
	const wrangler =
		readsWranglerConfig && existsSync(wranglerPath)
			? parseJsonc(wranglerPath)
			: undefined;
	const vite = runsVite ? viteConfigPorts(join(appDir, "vite.config.ts")) : {};

	const reservations: DevPortReservation[] = [];
	// An explicit `--port` beats the config files; `apps/os` passes one (with
	// `--strictPort`) and Vite honours the flag over `server.port`.
	const flagPort = explicitPortFlag(command);
	const service = flagPort ?? vite.service ?? devBlockPort(wrangler, "port");
	if (service !== undefined) {
		reservations.push({
			app,
			port: service,
			kind: "service",
			source:
				flagPort !== undefined
					? `apps/${app}/package.json`
					: vite.service !== undefined
						? `apps/${app}/vite.config.ts`
						: `apps/${app}/wrangler.jsonc`,
		});
	}

	const inspector = vite.inspector ?? devBlockPort(wrangler, "inspector_port");
	if (inspector !== undefined) {
		reservations.push({
			app,
			port: inspector,
			kind: "inspector",
			source:
				vite.inspector !== undefined
					? `apps/${app}/vite.config.ts`
					: `apps/${app}/wrangler.jsonc`,
		});
	}

	const adapter = DECLARED_ADAPTER_PORTS[app];
	if (adapter !== undefined) {
		reservations.push({
			app,
			port: adapter,
			kind: "adapter",
			source: "scripts/dev/ports.ts",
		});
	}
	return reservations;
}

const KIND_ORDER: Readonly<Record<DevPortKind, number>> = {
	service: 0,
	inspector: 1,
	adapter: 2,
};

/** Every port a root `bun dev` reserves, sorted by app then kind then port. */
export function collectDevPorts(root: string): DevPortReservation[] {
	const appsDir = join(root, "apps");
	if (!existsSync(appsDir)) return [];
	const inventory: DevPortReservation[] = [];
	for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		inventory.push(...collectApp(root, entry.name));
	}
	return inventory.sort(
		(a, b) =>
			a.app.localeCompare(b.app) ||
			KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
			a.port - b.port,
	);
}

/** Two apps on one port fail at startup; name both owners, not just the port. */
export function assertNoPortConflicts(
	inventory: readonly DevPortReservation[],
): void {
	const owners = new Map<number, DevPortReservation>();
	for (const reservation of inventory) {
		const existing = owners.get(reservation.port);
		if (existing) {
			throw new Error(
				`Local dev port ${reservation.port} is claimed twice: ` +
					`${existing.app} (${existing.kind}, ${existing.source}) and ` +
					`${reservation.app} (${reservation.kind}, ${reservation.source})`,
			);
		}
		owners.set(reservation.port, reservation);
	}
}

/** The flat, sorted, deduplicated list a shell script can splat into args. */
export function toPortList(inventory: readonly DevPortReservation[]): number[] {
	return [...new Set(inventory.map((reservation) => reservation.port))].sort(
		(a, b) => a - b,
	);
}

/**
 * One app's reserved ports, for `clear-port.sh --app <name>`.
 *
 * Throws rather than returning `[]`: an empty list would make clear-port sweep
 * nothing and report success, so a typo'd or newly added app would silently
 * skip the ownership-checked sweep and fail later as a mystery "address already
 * in use". A misspelled app and an app that declares no port are the same
 * defect from the caller's side, so both raise here.
 */
export function portsForApp(
	inventory: readonly DevPortReservation[],
	app: string,
): number[] {
	const ports = toPortList(
		inventory.filter((reservation) => reservation.app === app),
	);
	if (ports.length === 0) {
		const known = [...new Set(inventory.map((one) => one.app))].sort();
		throw new Error(
			`No local dev port is reserved for app "${app}". ` +
				`Apps with reserved ports: ${known.join(", ") || "(none)"}.`,
		);
	}
	return ports;
}

/** Markdown for docs, so the published table is generated, never hand-kept. */
export function renderPortTable(
	inventory: readonly DevPortReservation[],
): string {
	const apps = new Map<string, DevPortReservation[]>();
	for (const reservation of inventory) {
		const rows = apps.get(reservation.app);
		if (rows) rows.push(reservation);
		else apps.set(reservation.app, [reservation]);
	}
	const rows = [...apps.entries()]
		.map(([app, reservations]) => {
			const service = reservations.find((one) => one.kind === "service");
			const others = reservations
				.filter((one) => one.kind !== "service")
				.map((one) => String(one.port));
			return {
				app,
				service: service ? String(service.port) : "—",
				others: others.length > 0 ? others.join(", ") : "—",
				order: service?.port ?? Number.MAX_SAFE_INTEGER,
			};
		})
		.sort((a, b) => a.order - b.order || a.app.localeCompare(b.app));
	return [
		"| App | Local service | Inspector / adapter port |",
		"| --- | --- | --- |",
		...rows.map((row) => `| ${row.app} | ${row.service} | ${row.others} |`),
	].join("\n");
}

/** `--app api` and `--app=api` are both natural to type from a shell script. */
function requestedApp(argv: readonly string[]): string | undefined {
	for (const [index, argument] of argv.entries()) {
		if (argument.startsWith("--app=")) return argument.slice("--app=".length);
		if (argument === "--app") return argv[index + 1];
	}
	return undefined;
}

if (import.meta.main) {
	const root = join(import.meta.dir, "../..");
	const inventory = collectDevPorts(root);
	assertNoPortConflicts(inventory);
	const argv = process.argv.slice(2);
	if (argv.includes("--app") || argv.some((one) => one.startsWith("--app="))) {
		const app = requestedApp(argv);
		if (app === undefined || app === "" || app.startsWith("-")) {
			console.error("--app requires an app directory name, e.g. --app api");
			process.exit(2);
		}
		try {
			// Same single space-separated line the bare invocation prints, so
			// clear-port.sh can splat it straight into its argument list.
			console.log(portsForApp(inventory, app).join(" "));
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	} else if (process.argv.includes("--json")) {
		console.log(JSON.stringify(inventory, null, "\t"));
	} else if (process.argv.includes("--table")) {
		console.log(renderPortTable(inventory));
	} else {
		// Consumed by cleanup-dev.sh through command substitution, so it must
		// stay a single space-separated line.
		console.log(toPortList(inventory).join(" "));
	}
}
