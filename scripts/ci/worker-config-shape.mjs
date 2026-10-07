/**
 * Worker configuration SHAPE drift: the pre-push warning for a change to the
 * set of bindings, vars or secrets a product Worker declares.
 *
 * WHY. Tedix Cloud deploys these Workers through a production overlay that
 * lives in the separate tedix-cloud-ops repository. When a product
 * `apps/<name>/wrangler.jsonc` adds, removes or retypes a binding, var or
 * required secret and the overlay is not edited to match, Ship fails at plan
 * for every surface. It happened twice on 2026-10-07. This repository cannot
 * see the ops repository, so the check is a warning that names the shape
 * change, never a block.
 *
 * Values are ignored on purpose: a changed var VALUE or a renamed resource
 * keeps the shape and needs no overlay edit; a new, removed or retyped NAME
 * does.
 */

import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { detachedGitEnv } from "../oss/git-env.ts";

/** Product Worker configs the production overlay mirrors; templates are not. */
const WORKER_CONFIG = /^apps\/[^/]+\/wrangler\.jsonc$/;

/** Binding kinds whose entries are named by `name` rather than `binding`. */
const NAME_KEYED = new Set(["send_email", "ratelimits"]);

export function isWorkerConfigPath(path) {
	return WORKER_CONFIG.test(path);
}

function bindingNames(kind, value) {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const name = NAME_KEYED.has(kind)
				? (entry.name ?? entry.binding)
				: entry.binding;
			return typeof name === "string" ? [name] : [];
		});
	}
	if (!value || typeof value !== "object") return [];
	if (typeof value.binding === "string") return [value.binding];
	// durable_objects: { bindings: [{ name }] }; queues: { producers: [{ binding }] }.
	const nested = [
		...(Array.isArray(value.bindings) ? value.bindings : []),
		...(Array.isArray(value.producers) ? value.producers : []),
	];
	return nested.flatMap((entry) => {
		const name = entry?.binding ?? entry?.name;
		return typeof name === "string" ? [name] : [];
	});
}

function scopeShape(config, prefix, into) {
	if (!config || typeof config !== "object") return;
	for (const [kind, value] of Object.entries(config)) {
		if (kind === "env") continue;
		if (kind === "vars") {
			if (value && typeof value === "object") {
				for (const key of Object.keys(value)) into.add(`${prefix}var ${key}`);
			}
			continue;
		}
		if (kind === "secrets") {
			for (const key of Array.isArray(value?.required) ? value.required : []) {
				if (typeof key === "string") into.add(`${prefix}secret ${key}`);
			}
			continue;
		}
		for (const name of bindingNames(kind, value)) {
			into.add(`${prefix}binding ${name} (${kind})`);
		}
	}
}

/**
 * The shape of one parsed wrangler config: every binding name with its kind,
 * every var key and every required secret, top level and per `env.<name>`.
 */
export function workerConfigShape(config) {
	const shape = new Set();
	scopeShape(config, "", shape);
	const envs = config && typeof config.env === "object" ? config.env : {};
	for (const [env, envConfig] of Object.entries(envs ?? {})) {
		scopeShape(envConfig, `env.${env} `, shape);
	}
	return shape;
}

/** Parses JSONC source to a shape; missing or unparsable source is empty. */
export function shapeOfSource(source) {
	if (source == null) return new Set();
	return workerConfigShape(parse(source, [], { allowTrailingComma: true }));
}

/** Sorted `+ ...` / `- ...` lines for one config, empty when the shape held. */
export function diffShapes(before, after) {
	const added = [...after].filter((entry) => !before.has(entry)).sort();
	const removed = [...before].filter((entry) => !after.has(entry)).sort();
	return [
		...added.map((entry) => `+ ${entry}`),
		...removed.map((entry) => `- ${entry}`),
	];
}

/** The warning text for shape changes keyed by config path, or null. */
export function shapeWarning(changes) {
	const paths = Object.keys(changes)
		.filter((path) => changes[path].length)
		.sort();
	if (!paths.length) return null;
	const list = paths
		.map((path) => `${path}: ${changes[path].join(", ")}`)
		.join("; ");
	return (
		`This changes Worker configuration shape (${list}). ` +
		"Land the matching tedix-cloud-ops production overlay edit in the same change, " +
		"or Ship will fail at plan for every surface."
	);
}

function showFile(repoRoot, revision, path) {
	const result = spawnSync("git", ["show", `${revision}:${path}`], {
		cwd: repoRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	return result.status === 0 ? result.stdout : null;
}

function mergeBase(repoRoot, base, head) {
	const result = spawnSync("git", ["merge-base", base, head], {
		cwd: repoRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Compares each changed product Worker config at `head` against the merge
 * base with `base`. Returns the warning text, or null when no shape changed or
 * the comparison cannot be made (the warning never blocks, so an unreadable
 * revision is silence rather than an error).
 */
export function workerConfigShapeWarning(repoRoot, files, ranges) {
	const configs = (files ?? []).filter(isWorkerConfigPath);
	if (!configs.length || !ranges.length) return null;
	const changes = {};
	for (const { base, head } of ranges) {
		const from = /^0+$/.test(base) ? null : mergeBase(repoRoot, base, head);
		if (!from) continue;
		for (const path of configs) {
			try {
				const lines = diffShapes(
					shapeOfSource(showFile(repoRoot, from, path)),
					shapeOfSource(showFile(repoRoot, head, path)),
				);
				if (lines.length) changes[path] = lines;
			} catch {
				// Unparsable config: the format and type gates report it.
			}
		}
	}
	return shapeWarning(changes);
}
