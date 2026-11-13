import { DatabaseSync } from "node:sqlite";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { osShareLinks, osShareSessions } from "../schema/os-shares";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	createOsShareLink,
	createOsShareSession,
	getOsShareLinkByTokenHash,
	restrictOsShareLink,
	revokeOsShareLink,
	updateOsShareLinkSettings,
} from "./os-shares";

const roles = ["viewer", "use", "edit", "build"] as const;
const actions = [
	"grant",
	"narrow",
	"revoke",
	"disable",
	"undo",
	"redeem",
	"staleRedeem",
] as const;
const operation = fc.record({
	action: fc.constantFrom(...actions),
	role: fc.integer({ min: 0, max: 3 }),
	foreign: fc.boolean(),
});
type Operation = {
	action: (typeof actions)[number];
	role: number;
	foreign: boolean;
};
const now = "2026-01-01T00:00:00.000Z";

async function runSequence(
	resourceType: "workspace" | "output",
	operations: Operation[],
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(osShareLinks, osShareSessions));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const model: {
		exists: boolean;
		ceiling: number;
		revoked: boolean;
		disabled: boolean;
		sessions: Map<string, boolean>;
	} = {
		exists: false,
		ceiling: 3,
		revoked: false,
		disabled: false,
		sessions: new Map(),
	};
	try {
		for (const [index, op] of operations.entries()) {
			const scope = {
				organizationId: op.foreign ? "org-other" : "org-example",
				shareLinkId: "share",
			};
			const owned = model.exists && !op.foreign;
			if (op.action === "grant") {
				// Grant is creation, not a way to resurrect a revoked capability.
				if (!model.exists) {
					await createOsShareLink(db, {
						id: "share",
						organizationId: "org-example",
						resourceType,
						resourceId: "resource",
						tokenHash: "share-hash",
						role: "build",
						createdByKind: "user",
						createdById: "owner",
						createdAt: now,
					});
					model.exists = true;
				}
			} else if (op.action === "narrow") {
				// A policy may tighten a retained revoked row; it must stay revoked.
				const allowed = owned && op.role <= model.ceiling;
				const result = await restrictOsShareLink(db, {
					...scope,
					maxRole: roles[op.role]!,
					reason: "Policy restriction",
					now,
				});
				expect(Boolean(result)).toBe(allowed);
				if (allowed) {
					if (op.role < model.ceiling)
						for (const id of model.sessions.keys())
							model.sessions.set(id, false);
					model.ceiling = op.role;
				}
			} else if (op.action === "revoke") {
				expect(Boolean(await revokeOsShareLink(db, scope))).toBe(owned);
				if (owned) {
					model.revoked = true;
					for (const id of model.sessions.keys()) model.sessions.set(id, false);
				}
			} else if (op.action === "disable" || op.action === "undo") {
				const disabled = op.action === "disable";
				const allowed = owned && !model.revoked;
				const result = await updateOsShareLinkSettings(db, {
					...scope,
					set: { disabledAt: disabled ? now : null },
					endSessions: disabled,
					now,
				});
				expect(Boolean(result)).toBe(allowed);
				if (allowed) {
					model.disabled = disabled;
					if (disabled)
						for (const id of model.sessions.keys())
							model.sessions.set(id, false);
				}
			} else {
				// Session minting takes a capability, not an organization selector.
				const expectedRole = op.action === "staleRedeem" ? 3 : op.role;
				const allowed =
					model.exists &&
					!model.revoked &&
					!model.disabled &&
					expectedRole === model.ceiling;
				const id = `session-${index}`;
				const result = await createOsShareSession(db, {
					id,
					sessionTokenHash: id,
					linkId: "share",
					expectedEffectiveRole: roles[expectedRole]!,
					createdAt: now,
					lastSeenAt: now,
					expiresAt: "2099-01-01T00:00:00.000Z",
					now,
				});
				expect(Boolean(result)).toBe(allowed);
				if (allowed) model.sessions.set(id, true);
			}
			const share = await getOsShareLinkByTokenHash(db, "share-hash");
			expect(Boolean(share)).toBe(model.exists);
			if (share) {
				expect(share.policyMaxRole ?? "build").toBe(roles[model.ceiling]);
				expect(Boolean(share.revokedAt)).toBe(model.revoked);
				expect(Boolean(share.disabledAt)).toBe(model.disabled);
			}
			const sessions = await db.select().from(osShareSessions);
			expect(sessions).toHaveLength(model.sessions.size);
			for (const session of sessions)
				expect(session.revokedAt === null).toBe(model.sessions.get(session.id));
		}
	} finally {
		sqlite.close();
	}
}

describe("workspace and file sharing sequences", () => {
	it.each(["workspace", "output"] as const)(
		"never restores stale access after narrowing, revocation or undo: %s",
		async (resourceType) => {
			const op = (
				action: Operation["action"],
				role = 3,
				foreign = false,
			): Operation => ({ action, role, foreign });
			await fc.assert(
				fc.asyncProperty(
					fc.array(operation, { minLength: 1, maxLength: 30 }),
					(sequence) => runSequence(resourceType, sequence),
				),
				{
					seed: 20261113,
					numRuns: 100,
					examples: [
						[
							[
								op("grant"),
								op("redeem"),
								op("narrow", 0),
								op("staleRedeem"),
								op("redeem", 0),
								op("disable"),
								op("undo"),
								op("redeem", 0),
								op("revoke"),
								op("undo"),
								op("redeem", 0),
							],
						],
						[
							[
								op("grant"),
								op("narrow", 1),
								op("narrow", 3),
								op("narrow", 0, true),
								op("revoke", 0, true),
								op("redeem", 1),
							],
						],
					],
				},
			);
		},
	);
});
