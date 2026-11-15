import type { DbClient } from "@tedix/db/client";
import { readD1MigrationPublicationRevision } from "@tedix/db/queries/migration-inspection";

export async function reconcileToolMetadataPublication(
	db: DbClient,
	env: CloudflareEnv,
	options: { changed: boolean; reconcileRelease: boolean },
): Promise<{ published: boolean }> {
	let receiptKey: string | undefined;
	if (options.reconcileRelease) {
		if (!env.R2_BUCKET) throw new Error("Tool publication requires R2_BUCKET");
		const migration = await readD1MigrationPublicationRevision(db);
		const revision = JSON.stringify([env.GIT_SHA, migration]);
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(revision),
		);
		const hash = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		receiptKey = `tool-metadata-publication/v1/${hash}`;
		if (!options.changed && (await env.R2_BUCKET.get(receiptKey))) {
			return { published: false };
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
	// A failed purge or receipt write remains retryable. Immutable revision keys
	// prevent an older concurrent release from overwriting a newer receipt.
	if (receiptKey) {
		await env.R2_BUCKET.put(
			receiptKey,
			JSON.stringify({ activationEpoch: body.activationEpoch }),
		);
	}
	return { published: true };
}
