import type { DbClient } from "@tedix/db/client";
import { readD1MigrationPublicationRevision } from "@tedix/db/queries/migration-inspection";

export async function reconcileToolMetadataPublication(
	db: DbClient,
	env: CloudflareEnv,
	options: {
		changed: boolean;
		reconcileRelease: boolean;
		expectedMigration?: { id: number; name: string };
	},
) {
	let receiptKey: string | undefined;
	let migration:
		| Awaited<ReturnType<typeof readD1MigrationPublicationRevision>>
		| undefined;
	if (options.reconcileRelease) {
		if (!env.R2_BUCKET) throw new Error("Tool publication requires R2_BUCKET");
		migration = await readD1MigrationPublicationRevision(db);
		if (
			options.expectedMigration &&
			(migration?.id !== options.expectedMigration.id ||
				migration.name !== options.expectedMigration.name)
		) {
			throw new Error("Tool publication migration revision changed");
		}
		const revision = JSON.stringify(migration);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(revision),
		);
		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		receiptKey = `tool-metadata-publication/v1/${hash}`;
		if (!options.changed) {
			const stored = await env.R2_BUCKET.get(receiptKey);
			if (stored) {
				const receipt = await stored
					.json<{ activationEpoch?: unknown }>()
					.catch(() => null);
				if (
					typeof receipt?.activationEpoch === "string" &&
					receipt.activationEpoch
				) {
					return {
						published: false,
						activationEpoch: receipt.activationEpoch,
						migration,
					};
				}
			}
		}
	}
	if (!env.MCP_SERVICE) {
		throw new Error("Tool publication requires MCP_SERVICE");
	}
	const response = await env.MCP_SERVICE.fetch(
		new Request("https://internal/__internal/purge-aggregate-cache", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			body: JSON.stringify({ reason: "tool-schema-sync" }),
		}),
	);
	const body = (await response.json().catch(() => null)) as {
		ok?: boolean;
		activationEpoch?: string;
	} | null;
	if (
		!response.ok ||
		body?.ok !== true ||
		typeof body.activationEpoch !== "string" ||
		!body.activationEpoch
	) {
		throw new Error(
			`Tool metadata publication failed (HTTP ${response.status})`,
		);
	}
	// A failed purge or receipt write remains retryable. Immutable migration keys
	// keep acknowledgments for older migrations separate from newer ones.
	if (receiptKey) {
		await env.R2_BUCKET.put(
			receiptKey,
			JSON.stringify({
				releaseSha: env.GIT_SHA,
				activationEpoch: body.activationEpoch,
			}),
		);
	}
	return { published: true, activationEpoch: body.activationEpoch, migration };
}
