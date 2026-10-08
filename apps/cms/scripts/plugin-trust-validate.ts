#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
	canonicalizeDeclaredAccess,
	capabilitiesToDeclaredAccess,
	type DeclaredAccess,
} from "@emdash-cms/plugin-types";
// TypeScript 7 intentionally has no compiler API. Keep this AST-based validator
// on Microsoft's side-by-side TypeScript 6 compatibility API until TS 7.1.
import {
	type AstNode,
	childNodes,
	parseModule,
	stringValue,
} from "../../../scripts/oxc-ast.ts";

type Check = {
	detail: string;
	name: string;
	ok: boolean;
};

type PluginContract = {
	capabilities: readonly string[];
	declaredAccess: DeclaredAccess;
	format: "native" | "standard";
	id: string;
	settings: readonly string[];
	storage: readonly string[];
};

type PluginDescriptor = {
	capabilities: string[];
	format?: string;
	id: string;
	settings: string[];
	storage: string[];
};

const TEMPLATE_ASTRO_CONFIG = "apps/cms/templates/tedix/astro.config.mjs";
const MARKETING_TEMPLATE_ASTRO_CONFIG =
	"apps/cms/templates/marketing/astro.config.mjs";
const TEMPLATE_SNAPSHOT = "apps/cms/src/template-snapshot.ts";
const CMS_DOC = "docs/engineering/emdash/cms.md";
const SHARED_LOCKED_PLUGIN_FILES = [
	"src/plugins/tedix-seo-aeo/index.ts",
	"src/plugins/tedix-homepage-policy/index.ts",
	"src/lib/tedix-home-validation.ts",
	"src/lib/tedix-home-fields.json",
	"src/lib/tedix-home-copy-keys.json",
	"src/plugins/tedix-tedi-bridge/index.ts",
	"src/plugins/emdash-newsletter/index.ts",
	"src/plugins/tedix-site-builder/index.ts",
	"src/plugins/tedix-site-builder/admin.tsx",
] as const;

const MARKETING_ONLY_PLUGIN: PluginContract = {
	id: "tedix-homepage-policy",
	format: "standard",
	capabilities: ["hooks.content-policy:register"],
	declaredAccess: { content: { policy: {} } },
	settings: [],
	storage: [],
};

const LOCKED_PLUGIN_CONTRACTS: readonly PluginContract[] = [
	{
		id: "tedix-seo-aeo",
		format: "standard",
		capabilities: ["content:read"],
		declaredAccess: { content: { read: {} } },
		settings: [],
		storage: [],
	},
	{
		id: "tedix-tedi-bridge",
		format: "standard",
		capabilities: [
			"content:read",
			"taxonomies:read",
			"network:request:unrestricted",
		],
		declaredAccess: {
			content: { read: {} },
			network: { request: {} },
			taxonomies: { read: {} },
		},
		storage: [],
		settings: [
			"tedi.platformApiUrl",
			"tedi.platformApiKey",
			"tedi.id",
			"tedi.domain",
			"tedi.collections",
			"tedi.bridgeDisabled",
		],
	},
	{
		id: "emdash-newsletter",
		format: "standard",
		capabilities: ["content:read", "network:request:unrestricted"],
		declaredAccess: {
			content: { read: {} },
			network: { request: {} },
		},
		storage: ["subscribers"],
		settings: [
			"newsletter.platformApiUrl",
			"newsletter.platformApiKey",
			"newsletter.orgSlug",
			"newsletter.disabled",
			"newsletter.digestCollections",
			"newsletter.digestPageSize",
		],
	},
	{
		id: "tedix-site-builder",
		format: "native",
		capabilities: [],
		declaredAccess: {},
		settings: [],
		storage: [],
	},
] as const;

async function read(path: string): Promise<string> {
	return readFile(path, "utf8");
}

function isAstNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

/** A static property key, or `undefined` when the key is computed. */
function propertyNameText(property: AstNode): string | undefined {
	if (property.computed === true) return undefined;
	const name = property.key;
	if (!isAstNode(name)) return undefined;
	if (name.type === "Identifier") {
		return typeof name.name === "string" ? name.name : undefined;
	}
	if (name.type === "Literal") {
		if (typeof name.value === "string") return name.value;
		if (typeof name.value === "number") return String(name.value);
	}
	return undefined;
}

/** Properties that carry a value: neither a spread nor a method. */
function valueProperties(object: AstNode): AstNode[] {
	return ((object.properties ?? []) as unknown[]).filter(
		(property): property is AstNode =>
			isAstNode(property) &&
			property.type === "Property" &&
			property.method !== true,
	);
}

function stringLiteralValue(node: unknown): string | undefined {
	return stringValue(node);
}

function readStringArray(node: unknown): string[] {
	if (!isAstNode(node) || node.type !== "ArrayExpression") return [];
	return ((node.elements ?? []) as unknown[]).flatMap((element) => {
		const value = stringValue(element);
		return value === undefined ? [] : [value];
	});
}

function propertyInitializer(
	object: AstNode,
	key: string,
): AstNode | undefined {
	for (const property of valueProperties(object)) {
		// A shorthand carries no initializer of its own; TypeScript modelled it
		// as a different node and this lookup skipped it.
		if (property.shorthand === true) continue;
		if (propertyNameText(property) !== key) continue;
		const value = property.value;
		if (isAstNode(value)) return value;
	}
	return undefined;
}

function storageKeys(object: AstNode): string[] {
	const storage = propertyInitializer(object, "storage");
	if (!storage || storage.type !== "ObjectExpression") return [];

	const collections = propertyInitializer(storage, "collections");
	if (collections && collections.type === "ObjectExpression") {
		return keysOf(collections);
	}
	return keysOf(storage);
}

/** The static keys an object literal declares, shorthand included. */
function keysOf(object: AstNode): string[] {
	return valueProperties(object).flatMap((property) => {
		const name = propertyNameText(property);
		return name ? [name] : [];
	});
}

function objectKeys(node: AstNode | undefined): string[] {
	if (!node || node.type !== "ObjectExpression") return [];
	return keysOf(node);
}

export function extractPluginDescriptors(
	path: string,
	source: string,
): Map<string, PluginDescriptor> {
	const descriptors = new Map<string, PluginDescriptor>();
	const file = parseModule(path, source);

	const visit = (node: AstNode) => {
		if (node.type === "ObjectExpression") {
			const id = stringLiteralValue(propertyInitializer(node, "id"));
			if (id) {
				descriptors.set(id, {
					id,
					format: stringLiteralValue(propertyInitializer(node, "format")),
					capabilities: readStringArray(
						propertyInitializer(node, "capabilities"),
					),
					settings: objectKeys(propertyInitializer(node, "settingsSchema")),
					storage: storageKeys(node),
				});
			}
		}
		for (const child of childNodes(node)) visit(child);
	};

	visit(file);
	return descriptors;
}

/** The literal behind `{ … }` or `Object.freeze({ … })`. */
function frozenObject(node: unknown): AstNode | undefined {
	if (!isAstNode(node)) return undefined;
	if (node.type === "ObjectExpression") return node;
	if (node.type === "CallExpression") {
		const firstArgument = (node.arguments as unknown[])[0];
		if (isAstNode(firstArgument) && firstArgument.type === "ObjectExpression") {
			return firstArgument;
		}
	}
	return undefined;
}

export function extractSnapshotFile(
	source: string,
	templateSlug: string,
	path: string,
): string {
	const file = parseModule(TEMPLATE_SNAPSHOT, source);
	let content: string | undefined;

	const visit = (node: AstNode) => {
		if (
			node.type === "Property" &&
			node.method !== true &&
			node.shorthand !== true &&
			propertyNameText(node) === templateSlug
		) {
			const template = frozenObject(node.value);
			const fileProperty = template
				? valueProperties(template).find(
						(property) =>
							property.shorthand !== true &&
							propertyNameText(property) === path,
					)
				: undefined;
			const value = stringValue(fileProperty?.value);
			if (value !== undefined) content = value;
		}
		if (!content) for (const child of childNodes(node)) visit(child);
	};

	visit(file);
	if (!content) {
		throw new Error(
			`${TEMPLATE_SNAPSHOT} does not embed ${templateSlug}:${path}`,
		);
	}
	return content;
}

function normalized(values: readonly string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function sameValues(
	actual: readonly string[],
	expected: readonly string[],
): boolean {
	return (
		JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected))
	);
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function compareDescriptor(
	descriptors: Map<string, PluginDescriptor>,
	contract: PluginContract,
	id = contract.id,
	expectedSettings: readonly string[] = contract.settings,
): string[] {
	const descriptor = descriptors.get(id);
	if (!descriptor) return [`missing ${id}`];

	const failures: string[] = [];
	if (descriptor.format !== contract.format) {
		failures.push(`${id} format=${descriptor.format ?? "<missing>"}`);
	}
	if (!sameValues(descriptor.capabilities, contract.capabilities)) {
		failures.push(
			`${id} capabilities=${JSON.stringify(normalized(descriptor.capabilities))}`,
		);
	}
	if (!sameValues(descriptor.storage, contract.storage)) {
		failures.push(
			`${id} storage=${JSON.stringify(normalized(descriptor.storage))}`,
		);
	}
	if (!sameValues(descriptor.settings, expectedSettings)) {
		failures.push(
			`${id} settings=${JSON.stringify(normalized(descriptor.settings))}`,
		);
	}
	return failures;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			help: { default: false, type: "boolean" },
			json: { default: false, type: "boolean" },
		},
		strict: false,
	});

	if (values.help) {
		console.log(`Usage: bun run cms:plugin-trust:validate [--json]

	Validates the locked Tedix Emdash plugin trust surface:
	  - starter astro.config.mjs grants only the reviewed capabilities.
	  - the embedded template snapshot carries the same grants.
	  - docs describe the release gate for plugin declaredAccess reviews.
	`);
		process.exit(0);
	}

	const [starterSource, marketingSource, snapshotSource, cmsDoc] =
		await Promise.all([
			read(TEMPLATE_ASTRO_CONFIG),
			read(MARKETING_TEMPLATE_ASTRO_CONFIG),
			read(TEMPLATE_SNAPSHOT),
			read(CMS_DOC),
		]);

	const starterDescriptors = extractPluginDescriptors(
		TEMPLATE_ASTRO_CONFIG,
		starterSource,
	);
	const marketingDescriptors = extractPluginDescriptors(
		MARKETING_TEMPLATE_ASTRO_CONFIG,
		marketingSource,
	);
	const snapshotDescriptors = extractPluginDescriptors(
		"snapshot:astro.config.mjs",
		extractSnapshotFile(snapshotSource, "tedix", "astro.config.mjs"),
	);
	const marketingSnapshotDescriptors = extractPluginDescriptors(
		"snapshot:marketing:astro.config.mjs",
		extractSnapshotFile(snapshotSource, "marketing", "astro.config.mjs"),
	);
	const missingMarketingSnapshotPlugins = SHARED_LOCKED_PLUGIN_FILES.filter(
		(path) => {
			try {
				extractSnapshotFile(snapshotSource, "marketing", path);
				return false;
			} catch {
				return true;
			}
		},
	);
	const starterFailures = LOCKED_PLUGIN_CONTRACTS.flatMap((contract) =>
		compareDescriptor(starterDescriptors, contract),
	);
	const marketingFailures = LOCKED_PLUGIN_CONTRACTS.flatMap((contract) =>
		compareDescriptor(marketingDescriptors, contract),
	);
	const snapshotFailures = LOCKED_PLUGIN_CONTRACTS.flatMap((contract) =>
		compareDescriptor(snapshotDescriptors, contract),
	);
	const marketingSnapshotFailures = LOCKED_PLUGIN_CONTRACTS.flatMap(
		(contract) => compareDescriptor(marketingSnapshotDescriptors, contract),
	);
	marketingFailures.push(
		...compareDescriptor(marketingDescriptors, MARKETING_ONLY_PLUGIN),
	);
	marketingSnapshotFailures.push(
		...compareDescriptor(marketingSnapshotDescriptors, MARKETING_ONLY_PLUGIN),
	);
	if (starterDescriptors.has(MARKETING_ONLY_PLUGIN.id))
		starterFailures.push(
			"homepage policy must not be registered in the Tedix starter",
		);
	if (snapshotDescriptors.has(MARKETING_ONLY_PLUGIN.id))
		snapshotFailures.push(
			"homepage policy must not be registered in the Tedix snapshot",
		);
	const declaredAccessFailures = LOCKED_PLUGIN_CONTRACTS.flatMap((contract) => {
		const derived = capabilitiesToDeclaredAccess(contract.capabilities, []);
		return stable(canonicalizeDeclaredAccess(derived)) ===
			stable(canonicalizeDeclaredAccess(contract.declaredAccess))
			? []
			: [`${contract.id} derives ${stable(derived)}`];
	});
	const homepageAccess = capabilitiesToDeclaredAccess(
		MARKETING_ONLY_PLUGIN.capabilities,
		[],
	);
	if (
		stable(canonicalizeDeclaredAccess(homepageAccess)) !==
		stable(canonicalizeDeclaredAccess(MARKETING_ONLY_PLUGIN.declaredAccess))
	)
		declaredAccessFailures.push(
			`${MARKETING_ONLY_PLUGIN.id} derives ${stable(homepageAccess)}`,
		);

	const checks: Check[] = [
		{
			name: "starter locked plugin grants",
			ok: starterFailures.length === 0 && marketingFailures.length === 0,
			detail:
				starterFailures.length === 0 && marketingFailures.length === 0
					? "both starter configs match the reviewed Tedix plugin trust contract."
					: [...starterFailures, ...marketingFailures].join("; "),
		},
		{
			name: "snapshot locked plugin grants",
			ok:
				snapshotFailures.length === 0 && marketingSnapshotFailures.length === 0,
			detail:
				snapshotFailures.length === 0 && marketingSnapshotFailures.length === 0
					? `${TEMPLATE_SNAPSHOT} embeds the same plugin trust contract for both starters.`
					: [...snapshotFailures, ...marketingSnapshotFailures].join("; "),
		},
		{
			name: "marketing snapshot plugin sources",
			ok: missingMarketingSnapshotPlugins.length === 0,
			detail:
				missingMarketingSnapshotPlugins.length === 0
					? "the marketing snapshot materializes every shared locked-plugin source file."
					: `missing marketing snapshot files: ${missingMarketingSnapshotPlugins.join(", ")}`,
		},
		{
			name: "declaredAccess derivation",
			ok: declaredAccessFailures.length === 0,
			detail:
				declaredAccessFailures.length === 0
					? "Expected structured declaredAccess matches the capabilities Emdash currently accepts in plugin definitions."
					: declaredAccessFailures.join("; "),
		},
		{
			name: "operator docs",
			ok:
				cmsDoc.includes("cms:plugin-trust:validate") &&
				cmsDoc.includes("declaredAccess"),
			detail:
				"docs/engineering/emdash/cms.md should document the plugin trust release gate.",
		},
	];

	const ok = checks.every((check) => check.ok);
	const result = {
		checks,
		ok,
		plugins: [...LOCKED_PLUGIN_CONTRACTS, MARKETING_ONLY_PLUGIN].map(
			(contract) => ({
				id: contract.id,
				capabilities: contract.capabilities,
				declaredAccess: contract.declaredAccess,
				storage: contract.storage,
			}),
		),
	};

	if (values.json) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		for (const check of checks) {
			console.log(`${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`);
		}
	}

	if (!ok) process.exit(1);
}

if (import.meta.main) await main();
