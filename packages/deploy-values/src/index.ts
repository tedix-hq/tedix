// Configs that import this package need Node types even when their own
// tsconfig loads none (Worker apps set `"types": []`).
/// <reference types="node" />
import { readFileSync } from "node:fs";

// Worker configs (`cloudflare.config.ts`) call this to read live deploy values,
// such as account, database and bucket names, that must stay out of this
// public repository. The values come from a file or inline JSON named by
// TEDIX_DEPLOY_VALUES. Without it, or outside a production build, every
// accessor returns the placeholder the config passes in.
//
// Keep this file to erasable TypeScript (no enums, namespaces or parameter
// properties): `cf` loads configs under Node, which only strips types.

export const DEPLOY_VALUES_ENV = "TEDIX_DEPLOY_VALUES";
export const DEPLOY_VALUES_SCHEMA_VERSION = 1;

export type D1Value = { id: string; name: string };
export type R2Value = { name: string; jurisdiction?: string };
export type RouteValue = { pattern: string; zone: string };

export type DeployValues = {
	/** True when live values are loaded and missing keys throw. */
	readonly active: boolean;
	account(fallback: string): string;
	worker(surface: string, fallback: string): string;
	container(surface: string, fallback: string): string;
	d1(name: string, fallback: D1Value): D1Value;
	kv(name: string, fallback: string): string;
	r2(bucketKey: string, fallback: R2Value): R2Value;
	aiSearch(key: string, fallback: string): string;
	analytics(key: string, fallback: string): string;
	artifacts(key: string, fallback: string): string;
	aiGateway(key: string, fallback: string): string;
	host(key: string, fallback: string): string;
	routes(surface: string, fallback: RouteValue[]): RouteValue[];
	domains(surface: string, fallback: string[]): string[];
	vars(surface: string, name: string, fallback: string): string;
};

export type DeployValuesOptions = {
	mode: string | undefined;
	/** Defaults to `process.env`; tests pass their own. */
	env?: Record<string, string | undefined>;
};

type Json = Record<string, unknown>;

function processEnv(): Record<string, string | undefined> {
	return (
		(
			globalThis as typeof globalThis & {
				process?: { env?: Record<string, string | undefined> };
			}
		).process?.env ?? {}
	);
}

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(`${DEPLOY_VALUES_ENV}: ${message}`);
}

function parseValues(source: string): Json {
	let text: string;
	if (source.startsWith("{")) {
		text = source;
	} else if (source.startsWith("/")) {
		try {
			text = readFileSync(source, "utf8");
		} catch (error) {
			fail(`cannot read ${source}: ${(error as Error).message}`);
		}
	} else {
		fail("must be an absolute file path or inline JSON starting with '{'");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		fail(`is not valid JSON: ${(error as Error).message}`);
	}
	if (!isObject(parsed)) fail("must contain a JSON object");
	if (parsed.schemaVersion !== DEPLOY_VALUES_SCHEMA_VERSION) {
		fail(
			`schemaVersion must be ${DEPLOY_VALUES_SCHEMA_VERSION}, got ${JSON.stringify(parsed.schemaVersion)}`,
		);
	}
	return parsed;
}

export function deployValues(options: DeployValuesOptions): DeployValues {
	const source = (options.env ?? processEnv())[DEPLOY_VALUES_ENV]?.trim();
	const values =
		options.mode === "production" && source ? parseValues(source) : undefined;

	// Returns the value at `path`, or throws naming the key when live values
	// are loaded and it is missing. Returns undefined only without live values.
	const lookup = (path: string[]): unknown => {
		if (!values) return undefined;
		let current: unknown = values;
		for (const key of path) {
			current = isObject(current) ? current[key] : undefined;
		}
		if (current === undefined || current === null) {
			fail(`missing key "${path.join(".")}"`);
		}
		return current;
	};

	const string = (path: string[], fallback: string): string => {
		if (!values) return fallback;
		const value = lookup(path);
		if (typeof value !== "string" || value === "") {
			fail(`key "${path.join(".")}" must be a non-empty string`);
		}
		return value;
	};

	const stringList = (path: string[], fallback: string[]): string[] => {
		if (!values) return fallback;
		const value = lookup(path);
		if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
			fail(`key "${path.join(".")}" must be a list of strings`);
		}
		return value as string[];
	};

	return {
		active: values !== undefined,
		account: (fallback) => string(["account", "id"], fallback),
		worker: (surface, fallback) => string(["workers", surface], fallback),
		container: (surface, fallback) => string(["containers", surface], fallback),
		d1: (name, fallback) =>
			values
				? {
						id: string(["d1", name, "id"], fallback.id),
						name: string(["d1", name, "name"], fallback.name),
					}
				: fallback,
		kv: (name, fallback) => string(["kv", name, "id"], fallback),
		r2: (bucketKey, fallback) => {
			if (!values) return fallback;
			const name = string(["r2", "buckets", bucketKey], fallback.name);
			const r2 = isObject(values.r2) ? values.r2 : {};
			const jurisdiction = r2.jurisdiction;
			if (jurisdiction !== undefined && typeof jurisdiction !== "string") {
				fail('key "r2.jurisdiction" must be a string');
			}
			return jurisdiction ? { name, jurisdiction } : { name };
		},
		aiSearch: (key, fallback) => string(["aiSearch", key], fallback),
		analytics: (key, fallback) => string(["analytics", key], fallback),
		artifacts: (key, fallback) => string(["artifacts", key], fallback),
		aiGateway: (key, fallback) => string(["aiGateway", key], fallback),
		host: (key, fallback) => string(["hostnames", key], fallback),
		routes: (surface, fallback) => {
			if (!values) return fallback;
			const path = ["routes", surface];
			const value = lookup(path);
			const valid =
				Array.isArray(value) &&
				value.every(
					(route) =>
						isObject(route) &&
						typeof route.pattern === "string" &&
						typeof route.zone === "string",
				);
			if (!valid) {
				fail(`key "${path.join(".")}" must be a list of {pattern, zone}`);
			}
			return (value as RouteValue[]).map(({ pattern, zone }) => ({
				pattern,
				zone,
			}));
		},
		domains: (surface, fallback) => stringList(["domains", surface], fallback),
		vars: (surface, name, fallback) => {
			if (!values) return fallback;
			const vars = isObject(values.vars) ? values.vars : {};
			const own = isObject(vars[surface]) ? vars[surface] : {};
			if (own[name] !== undefined) return string(["vars", surface, name], "");
			const shared = isObject(vars.shared) ? vars.shared : {};
			if (shared[name] !== undefined) {
				return string(["vars", "shared", name], "");
			}
			fail(`missing key "vars.${surface}.${name}" or "vars.shared.${name}"`);
		},
	};
}
