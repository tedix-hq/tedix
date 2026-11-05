import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll } from "vite-plus/test";

let clientPromise: Promise<PGlite> | undefined;

afterAll(async () => {
	const client = await clientPromise;
	clientPromise = undefined;
	await client?.close();
});

/** An independent in-memory Postgres database for parity tests. */
export async function createPostgresTestDb() {
	clientPromise ??= (async () => {
		const client = new PGlite();
		await client.waitReady;
		return client;
	})();
	const client = await clientPromise;
	await client.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
	return drizzle({ client });
}
