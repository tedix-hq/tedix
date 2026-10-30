#!/usr/bin/env bun
/** Import an installation-owned provider manifest. Dry run first; never ships a vendor selection. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import {
	ConnectionProviderTemplateSchema,
	type ConnectionProviderTemplate,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import { remoteD1Execute } from "../lib/remote-d1.ts";

const ManifestSchema = z.strictObject({
	version: z.literal(1),
	providers: z.array(ConnectionProviderTemplateSchema).max(500),
});
type ProviderRow = ReturnType<typeof providerRow>;
const FIELDS = [
	"id",
	"name",
	"description",
	"icon",
	"category",
	"type",
	"descope_app_id",
	"descope_app_aliases",
	"sort_order",
	"recommended_scope",
	"supported_scopes",
	"required_scopes",
	"credential_profile",
	"oauth_config",
] as const;

export function parseProviderManifest(
	text: string,
	assetsUrl?: string,
): ConnectionProviderTemplate[] {
	if (text.includes("{ASSETS_URL}")) {
		if (!assetsUrl) throw new Error("Manifest requires ASSETS_URL");
		const url = new URL(assetsUrl);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		)
			throw new Error(
				"ASSETS_URL must be an HTTPS assets origin without credentials, query or fragment",
			);
		text = text.replaceAll("{ASSETS_URL}", assetsUrl.replace(/\/$/, ""));
	}
	const { providers } = ManifestSchema.parse(JSON.parse(text));
	if (
		new Set(providers.map((provider) => provider.id)).size !== providers.length
	)
		throw new Error("Provider ids must be unique");
	return providers;
}

function providerRow(provider: ConnectionProviderTemplate, sortOrder: number) {
	return {
		id: provider.id,
		name: provider.name,
		description: provider.description,
		icon: provider.icon,
		category: provider.category,
		type: provider.type,
		descope_app_id: provider.descopeAppId ?? null,
		descope_app_aliases: provider.descopeAppAliases
			? JSON.stringify(provider.descopeAppAliases)
			: null,
		sort_order: sortOrder,
		recommended_scope: provider.recommendedScope,
		supported_scopes: JSON.stringify(provider.supportedScopes),
		required_scopes: JSON.stringify(provider.requiredScopes),
		credential_profile: provider.credentialProfile
			? JSON.stringify(provider.credentialProfile)
			: null,
		oauth_config: provider.oauthConfig
			? JSON.stringify(provider.oauthConfig)
			: null,
	};
}
function quote(value: string | number | null): string {
	return value === null
		? "NULL"
		: typeof value === "number"
			? String(value)
			: `'${value.replaceAll("'", "''")}'`;
}
function shape(row: ProviderRow) {
	return FIELDS.map((field) => row[field]);
}
function providerSnapshot(ids: string[], existing: ProviderRow[]): string {
	const byId = new Map(existing.map((row) => [row.id, row]));
	return createHash("sha256")
		.update(
			JSON.stringify(
				[...ids]
					.sort()
					.map((id) => [id, byId.has(id) ? shape(byId.get(id)!) : null]),
			),
		)
		.digest("hex");
}
export function planProviderReconciliation(
	providers: ConnectionProviderTemplate[],
	existing: ProviderRow[],
	only?: Set<string>,
) {
	const desired = providers
		.map(providerRow)
		.filter((row) => !only || only.has(row.id));
	if (
		only &&
		[...only].some((id) => !providers.some((provider) => provider.id === id))
	)
		throw new Error("--only contains an id absent from the manifest");
	const byId = new Map(existing.map((row) => [row.id, row]));
	const changes = desired.flatMap((row) => {
		const previous = byId.get(row.id);
		if (
			previous &&
			JSON.stringify(shape(previous)) === JSON.stringify(shape(row))
		)
			return [];
		const sql = previous
			? `UPDATE connection_providers SET ${FIELDS.filter(
					(field) => field !== "id",
				)
					.map((field) => `${field}=${quote(row[field])}`)
					.join(
						",",
					)},updated_at=CURRENT_TIMESTAMP WHERE ${FIELDS.map((field) => `${field} IS ${quote(previous[field])}`).join(" AND ")} RETURNING id`
			: `INSERT OR IGNORE INTO connection_providers (${FIELDS.join(",")},created_at,updated_at) VALUES (${FIELDS.map((field) => quote(row[field])).join(",")},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) RETURNING id`;
		return [{ id: row.id, kind: previous ? "update" : "insert", sql }];
	});
	return {
		snapshot: createHash("sha256")
			.update(
				JSON.stringify({
					before: providerSnapshot(
						desired.map((row) => row.id),
						existing,
					),
					desired: desired.map(shape),
				}),
			)
			.digest("hex"),
		changes,
	};
}
async function d1<T>(sql: string): Promise<T[]> {
	const parsed = await remoteD1Execute({
		database: "DB",
		config: fileURLToPath(
			new URL("../../apps/api/wrangler.jsonc", import.meta.url),
		),
		sql,
		caller: "scripts/descope/seed-connection-providers.ts",
	});
	return (parsed[0]?.results ?? []) as T[];
}
function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index < 0) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}
async function main() {
	const manifest = option("--manifest");
	if (!manifest)
		throw new Error(
			"Pass --manifest <private installation manifest.json>; dry run prints the snapshot required by --apply",
		);
	const providers = parseProviderManifest(
		await readFile(manifest, "utf8"),
		process.env.ASSETS_URL,
	);
	const onlyText = option("--only");
	const only = onlyText
		? new Set(
				onlyText
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean),
			)
		: undefined;
	if (only && !only.size)
		throw new Error("--only requires at least one provider id");
	const existing = await d1<ProviderRow>(
		`SELECT ${FIELDS.join(",")} FROM connection_providers`,
	);
	const plan = planProviderReconciliation(providers, existing, only);
	console.log(
		JSON.stringify(
			{
				snapshot: plan.snapshot,
				changes: plan.changes.map(({ id, kind }) => ({ id, kind })),
			},
			null,
			2,
		),
	);
	if (!process.argv.includes("--apply")) return;
	if (option("--expected-snapshot") !== plan.snapshot)
		throw new Error(
			"Provider configuration changed or --expected-snapshot is missing; review a fresh dry run before applying",
		);
	for (const change of plan.changes) {
		const rows = await d1<{ id: string }>(change.sql);
		if (rows.length !== 1 || rows[0]?.id !== change.id)
			throw new Error(
				`Provider ${change.id} changed concurrently; remaining changes were not applied. Review a fresh dry run.`,
			);
	}
	const final = await d1<ProviderRow>(
		`SELECT ${FIELDS.join(",")} FROM connection_providers`,
	);
	if (planProviderReconciliation(providers, final, only).changes.length)
		throw new Error(
			"Provider readback differs from manifest; review before retrying",
		);
	console.log(`Verified ${plan.changes.length} provider changes`);
}
if (import.meta.main)
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
