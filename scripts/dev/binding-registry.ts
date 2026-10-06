#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolveLocalRegistryPath } from "../dev-local";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalWranglerConfig } from "../dev-local";

/**
 * Wrangler's cross-process dev registry is a DIRECTORY of JSON files, one per
 * live `wrangler dev`, named after the Worker. Miniflare treats an entry whose
 * file mtime is older than its heartbeat window as dead, so mtime — not file
 * existence — is what makes an entry authoritative.
 * Source: miniflare `src/shared/dev-registry.ts` (`getWorkerRegistry`,
 * `WORKER_STALE_MS`) and wrangler's `WRANGLER_REGISTRY_PATH` factory.
 */
const WORKER_STALE_MS = 90_000;
/**
 * Miniflare writes its own storage-arbitration entries into the same directory
 * under this prefix. They are not Workers and must never satisfy a binding.
 */
const STORAGE_CANDIDATE_PREFIX = "__miniflare_storage_candidate__-";

/** `process.env` is augmented repo-wide; a narrow shape keeps callers injectable. */
export type EnvironmentLike = Record<string, string | undefined>;

export type RegistrySkipReason = "malformed" | "stale" | "unreadable";

export type RegistrySkip = {
	file: string;
	reason: RegistrySkipReason;
};

/**
 * Only the fields miniflare actually serialises today, all optional: the shape
 * has already changed once (the old `protocol`/`mode`/`port`/`host` definition
 * became `debugPortAddress`/`defaultEntrypointService`), so nothing here may be
 * load-bearing beyond the file's existence and freshness.
 */
export type RegistryWorker = {
	name: string;
	debugPortAddress?: string;
	defaultEntrypointService?: string;
	userWorkerService?: string;
	queueConsumers?: string[];
	storageScope?: string;
	instanceId?: string;
	heartbeatAgeMs: number;
};

export type RegistrySnapshot = {
	directory: string;
	/** False when no `wrangler dev` has ever written here; not a binding failure. */
	present: boolean;
	workers: Map<string, RegistryWorker>;
	skipped: RegistrySkip[];
};

export type BindingKind = "durable_object" | "service";

export type BindingTarget = {
	binding: string;
	target: string;
	kind: BindingKind;
};

export type BindingCheck = BindingTarget & {
	registered: boolean;
	detail: string;
};

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Mirrors wrangler's `xdgAppPaths(".wrangler").config()` per platform. */
function xdgConfigDirectory(
	env: EnvironmentLike,
	platform: string,
	home: string,
): string {
	const override = env.XDG_CONFIG_HOME?.trim();
	if (override) return override;
	if (platform === "darwin") return join(home, "Library", "Preferences");
	if (platform.startsWith("win")) {
		const appData = env.APPDATA?.trim();
		return join(appData || join(home, "AppData", "Roaming"), "xdg.config");
	}
	return join(home, ".config");
}

/**
 * WRANGLER_REGISTRY_PATH wins; otherwise `getGlobalConfigPath()/registry`.
 * Wrangler still prefers a legacy `~/.wrangler` when that directory exists, so
 * probing the XDG path alone would read an empty registry on those machines.
 */
export function resolveRegistryDirectory(
	env: EnvironmentLike = process.env,
	platform: string = process.platform,
	home: string = homedir(),
	// Injectable so the precedence chain below stays testable: the real checkout
	// path exists on this machine and would otherwise shadow every fallback case.
	checkoutRegistry: string = resolveLocalRegistryPath(
		join(import.meta.dir, "..", "..", "apps", "_"),
	),
): string {
	const override = env.WRANGLER_REGISTRY_PATH?.trim();
	if (override) return override;
	// This checkout scopes its own registry (scripts/dev-local.ts sets
	// WRANGLER_REGISTRY_PATH/MINIFLARE_REGISTRY_PATH for every dev child) so that
	// parallel worktrees cannot resolve each other's Workers. dev-health.sh runs
	// this probe from a plain shell WITHOUT those variables, so it has to look in
	// the same place the dev children write, or every binding reads as missing.
	if (statSync(checkoutRegistry, { throwIfNoEntry: false })?.isDirectory())
		return checkoutRegistry;
	const legacy = join(home, ".wrangler");
	if (statSync(legacy, { throwIfNoEntry: false })?.isDirectory()) {
		return join(legacy, "registry");
	}
	return join(xdgConfigDirectory(env, platform, home), ".wrangler", "registry");
}

/**
 * Read-only counterpart to miniflare's `getWorkerRegistry`: it deletes stale
 * files, a health check must not. A half-written or corrupt file is reported as
 * skipped rather than throwing, so one bad entry cannot abort the health run.
 */
export function readWorkerRegistry(
	directory: string = resolveRegistryDirectory(),
	now: number = Date.now(),
): RegistrySnapshot {
	const snapshot: RegistrySnapshot = {
		directory,
		present: existsSync(directory),
		workers: new Map(),
		skipped: [],
	};
	if (!snapshot.present) return snapshot;

	let files: string[];
	try {
		files = readdirSync(directory);
	} catch {
		snapshot.present = false;
		return snapshot;
	}

	for (const file of files) {
		if (file.startsWith(STORAGE_CANDIDATE_PREFIX)) continue;
		const path = join(directory, file);
		let mtimeMs: number;
		let raw: string;
		try {
			const stats = statSync(path, { throwIfNoEntry: false });
			if (stats === undefined || !stats.isFile()) continue;
			mtimeMs = stats.mtimeMs;
			raw = readFileSync(path, "utf8");
		} catch {
			snapshot.skipped.push({ file, reason: "unreadable" });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			snapshot.skipped.push({ file, reason: "malformed" });
			continue;
		}
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			snapshot.skipped.push({ file, reason: "malformed" });
			continue;
		}
		const age = now - mtimeMs;
		if (age > WORKER_STALE_MS) {
			snapshot.skipped.push({ file, reason: "stale" });
			continue;
		}
		const definition = parsed as Record<string, unknown>;
		const queueConsumers = Array.isArray(definition.queueConsumers)
			? definition.queueConsumers.filter(
					(value): value is string => typeof value === "string",
				)
			: undefined;
		snapshot.workers.set(file, {
			name: file,
			debugPortAddress: stringOrUndefined(definition.debugPortAddress),
			defaultEntrypointService: stringOrUndefined(
				definition.defaultEntrypointService,
			),
			userWorkerService: stringOrUndefined(definition.userWorkerService),
			queueConsumers,
			storageScope: stringOrUndefined(definition.storageScope),
			instanceId: stringOrUndefined(definition.instanceId),
			heartbeatAgeMs: age,
		});
	}
	return snapshot;
}

/**
 * Targets as the LOCAL stack names them. `scripts/dev-local.ts` rewrites Worker
 * identity for local runs (`tedix-api` becomes `public-installation-api`, and
 * every API_SERVICE binding is retargeted to match), so resolving against the
 * committed names would report every API_SERVICE binding as missing. Reuse
 * `createLocalWranglerConfig` instead of restating that rule here.
 * Cross-script Durable Object bindings are included: `tedi ->
 * TEDI_WORKSTATION_RUNTIME_SANDBOX` and `email -> TEDI_AGENT` are DO bindings,
 * not `services` entries, and are checked by dev-health today. An app without
 * wrangler.jsonc is read from its `cloudflare.config.ts` instead.
 */
export function localBindingTargets(appDirectory: string): BindingTarget[] {
	const cfConfigPath = join(appDirectory, "cloudflare.config.ts");
	if (
		!existsSync(join(appDirectory, "wrangler.jsonc")) &&
		existsSync(cfConfigPath)
	) {
		return cloudflareBindingTargets(cfConfigPath);
	}
	const config = createLocalWranglerConfig(
		join(appDirectory, "wrangler.jsonc"),
	);
	const targets: BindingTarget[] = [];
	if (Array.isArray(config.services)) {
		for (const entry of config.services) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const service = entry as Record<string, unknown>;
			const binding = stringOrUndefined(service.binding);
			const target = stringOrUndefined(service.service);
			if (binding && target) targets.push({ binding, target, kind: "service" });
		}
	}
	const durableObjects = config.durable_objects;
	if (
		durableObjects &&
		typeof durableObjects === "object" &&
		!Array.isArray(durableObjects)
	) {
		const bindings = (durableObjects as Record<string, unknown>).bindings;
		if (Array.isArray(bindings)) {
			for (const entry of bindings) {
				if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
					continue;
				}
				const object = entry as Record<string, unknown>;
				const binding = stringOrUndefined(object.name);
				// A binding without `script_name` is same-script and needs no peer.
				const target = stringOrUndefined(object.script_name);
				if (binding && target) {
					targets.push({ binding, target, kind: "durable_object" });
				}
			}
		}
	}
	return targets;
}

type CfPeerBinding = { type?: unknown; worker?: unknown };

/**
 * Peer targets of a `cloudflare.config.ts` Worker as `vp dev` resolves them:
 * the development mode, whose Worker names the config already spells locally.
 */
function cloudflareBindingTargets(configPath: string): BindingTarget[] {
	const evaluate = (value: unknown): unknown =>
		typeof value === "function" ? value({ mode: "development" }) : value;
	const { default: authored } = require(configPath) as { default: unknown };
	const root = evaluate(authored) as { worker?: unknown } | undefined;
	const worker = evaluate(root?.worker) as
		| { env?: Record<string, CfPeerBinding> }
		| undefined;
	const targets: BindingTarget[] = [];
	for (const [binding, declaration] of Object.entries(worker?.env ?? {})) {
		const target = stringOrUndefined(declaration.worker);
		if (!target) continue;
		if (declaration.type === "worker")
			targets.push({ binding, target, kind: "service" });
		else if (declaration.type === "durable-object")
			targets.push({ binding, target, kind: "durable_object" });
	}
	return targets;
}

export function checkBindings(
	targets: readonly BindingTarget[],
	snapshot: RegistrySnapshot,
): BindingCheck[] {
	return targets.map((target) => {
		const worker = snapshot.workers.get(target.target);
		const address = worker?.debugPortAddress;
		// A registry file that exists for this exact target but was skipped names
		// the reason the probe missed it: a dev process whose heartbeat stopped
		// reads as "stale", a file caught mid-write as "malformed". Without it a
		// dead-but-present entry is indistinguishable from a Worker that was never
		// started, which is the ambiguity the log grep already had.
		const skip = snapshot.skipped.find((entry) => entry.file === target.target);
		return {
			...target,
			registered: worker !== undefined,
			detail: worker
				? `env.${target.binding} -> ${target.target} [registered]${address ? ` ${address}` : ""}`
				: `env.${target.binding} -> ${target.target} [not registered] (dev registry${skip ? `: entry ${skip.reason}` : ""})`,
		};
	});
}

/**
 * Exit codes are a contract with `scripts/dev-health.sh`:
 * 0 ok, 1 a binding target is not running, 2 usage/config error,
 * 3 the registry cannot answer at all (caller degrades to its log fallback).
 */
export function resolveAppBindings(
	appDirectory: string,
	binding?: string,
	registryDirectory: string = resolveRegistryDirectory(),
): { checks: BindingCheck[]; snapshot: RegistrySnapshot } {
	const snapshot = readWorkerRegistry(registryDirectory);
	const targets = localBindingTargets(appDirectory);
	const selected = binding
		? targets.filter((target) => target.binding === binding)
		: targets;
	return { checks: checkBindings(selected, snapshot), snapshot };
}

if (import.meta.main) {
	const [appPath, binding] = process.argv.slice(2);
	if (!appPath) {
		console.error("usage: binding-registry.ts <app-directory> [BINDING]");
		process.exit(2);
	}
	const appDirectory = resolve(appPath);
	let result: ReturnType<typeof resolveAppBindings>;
	try {
		result = resolveAppBindings(appDirectory, binding);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(2);
	}
	const { checks, snapshot } = result;
	if (!snapshot.present) {
		console.log(`dev registry unavailable at ${snapshot.directory}`);
		process.exit(3);
	}
	if (binding && checks.length === 0) {
		console.error(`binding ${binding} is not declared in ${appDirectory}`);
		process.exit(2);
	}
	for (const skip of snapshot.skipped) {
		if (skip.reason === "stale") continue;
		console.error(`registry entry ${skip.file} skipped (${skip.reason})`);
	}
	if (binding) {
		// Single-binding mode prints only the detail so dev-health.sh keeps
		// ownership of its own status/label columns.
		console.log(checks[0]!.detail);
	} else {
		for (const check of checks) {
			console.log(
				`${(check.registered ? "ok" : "FAIL").padEnd(7)} ${check.binding.padEnd(24)} ${check.detail}`,
			);
		}
	}
	process.exit(checks.some((check) => !check.registered) ? 1 : 0);
}
