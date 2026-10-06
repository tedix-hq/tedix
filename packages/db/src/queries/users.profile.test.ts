import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "../client";
import { principalIdentities } from "../schema/principal-identities";
import { users } from "../schema/users";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	getUserById,
	updateUserProfile,
	upsertUserForExternalIdentity,
} from "./users";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const identity = {
	provider: "descope",
	issuer: "https://auth.example.test",
	subject: "descope-user-1",
};

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(users, principalIdentities));
	const db = createDbClient(createD1Facade(sqlite));
	return { sqlite, db };
}

describe("canonical user profiles", () => {
	it("keeps provider synchronization fill-only for managed profile fields", async () => {
		const { db } = fixture();
		await db.insert(users).values({
			id: USER_ID,
			email: "owner@example.com",
			name: "Managed Name",
			avatarUrl: "https://images.example.test/managed",
		});
		await db.insert(principalIdentities).values({
			id: crypto.randomUUID(),
			principalType: "user",
			principalId: USER_ID,
			provider: identity.provider,
			issuer: identity.issuer,
			subject: identity.subject,
		});

		await upsertUserForExternalIdentity(db, {
			identity,
			email: "owner@example.com",
			name: "JWT Name",
			avatarUrl: "https://images.example.test/jwt",
		});

		expect(await getUserById(db, USER_ID)).toMatchObject({
			name: "Managed Name",
			avatarUrl: "https://images.example.test/managed",
		});
	});

	it("increments a profile revision exactly once and rejects a stale CAS", async () => {
		const { db } = fixture();
		await db.insert(users).values({
			id: USER_ID,
			email: "owner@example.com",
		});
		expect(
			await updateUserProfile(db, {
				userId: USER_ID,
				name: "First",
				expectedRevision: 1,
			}),
		).toMatchObject({ name: "First", profileRevision: 2 });
		expect(
			await updateUserProfile(db, {
				userId: USER_ID,
				name: "Stale",
				expectedRevision: 1,
			}),
		).toBeUndefined();
	});
});
