import { createConnection, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { createCoreStore, coreTable } from "./client";
import { workDue } from "../schema/work-due";
import { workDue as pgWorkDue } from "../schema-pg/core";
import { pgTableDdl } from "../test/pg-schema-ddl";

// Opt-in, local PostgreSQL only. PGlite cannot prove protocol exchanges.
const connectionString = process.env.TEST_POSTGRES_URL;
it.skipIf(!connectionString)(
	"sends one protocol round trip per atomic batch over real PostgreSQL",
	async () => {
		const target = new URL(connectionString!);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
			throw new Error("TEST_POSTGRES_URL must be loopback");
		const schema = `wire_${randomUUID().replaceAll("-", "")}`;
		const admin = postgres(target.href, {
			ssl: false,
			max: 1,
			fetch_types: false,
		});
		const frontend: string[] = [];
		const backend: string[] = [];
		const sockets = new Set<Socket>();
		// Decode messages across arbitrary TCP chunk boundaries; count Sync/ReadyForQuery,
		// not TCP writes, which the OS may split or coalesce.
		function decoder(types: string[], startup = false) {
			let buffer = Buffer.alloc(0);
			return (chunk: Buffer) => {
				buffer = Buffer.concat([buffer, chunk]);
				while (buffer.length >= (startup ? 4 : 5)) {
					const length =
						buffer.readUInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
					if (buffer.length < length) break;
					if (startup) startup = false;
					else types.push(String.fromCharCode(buffer[0]!));
					buffer = buffer.subarray(length);
				}
			};
		}
		const proxy = createServer((client) => {
			const upstream = createConnection({
				host: target.hostname.replaceAll(/[\[\]]/g, ""),
				port: Number(target.port || 5432),
			});
			for (const socket of [client, upstream]) {
				sockets.add(socket);
				socket.on("close", () => sockets.delete(socket));
				socket.on("error", () => {
					client.destroy();
					upstream.destroy();
				});
			}
			client.on("data", decoder(frontend, true));
			upstream.on("data", decoder(backend));
			client.pipe(upstream).pipe(client);
		});
		let core: ReturnType<typeof createCoreStore> | undefined;
		try {
			await admin.unsafe(`CREATE SCHEMA "${schema}"`);
			proxy.listen(0, "127.0.0.1");
			await once(proxy, "listening");
			const address = proxy.address();
			if (!address || typeof address === "string")
				throw new Error("Missing proxy port");
			const url = new URL(target);
			url.hostname = "127.0.0.1";
			url.port = String(address.port);
			url.searchParams.set("ssl", "false");
			url.searchParams.set("options", `-c search_path=${schema}`);
			core = createCoreStore({
				CORE_STORE: "postgres",
				DB: undefined as unknown as D1Database,
				CORE_HYPERDRIVE: { connectionString: url.href },
			});
			const db = core.db;
			for (const ddl of pgTableDdl(pgWorkDue)) await db.run(sql.raw(ddl));
			const table = coreTable(db, workDue);
			const row = (id: string) => ({
				orgId: "org",
				kind: "approval-expiry" as const,
				objectId: id,
				dueAt: "2026-11-25",
			});
			frontend.length = backend.length = 0;
			const results = await db.batch([
				db.insert(table).values(row("first")).returning({ id: table.objectId }),
				db
					.update(table)
					.set({ dueAt: "2026-11-26" })
					.where(eq(table.objectId, "first"))
					.returning({ dueAt: table.dueAt }),
				db.select({ id: table.objectId, dueAt: table.dueAt }).from(table),
			]);
			expect(results).toEqual([
				[{ id: "first" }],
				[{ dueAt: "2026-11-26" }],
				[{ id: "first", dueAt: "2026-11-26" }],
			]);
			expect(frontend.filter((type) => type === "E")).toHaveLength(3);
			expect(frontend.filter((type) => type === "S")).toHaveLength(1);
			expect(backend.filter((type) => type === "Z")).toHaveLength(1);
			frontend.length = backend.length = 0;
			await expect(
				db.batch([
					db.insert(table).values(row("rollback")),
					db.insert(table).values(row("first")),
					db.insert(table).values(row("skipped")),
				]),
			).rejects.toThrow();
			expect(frontend.filter((type) => type === "S")).toHaveLength(1);
			expect(backend.filter((type) => type === "Z")).toHaveLength(1);
			expect(await db.select({ id: table.objectId }).from(table)).toEqual([
				{ id: "first" },
			]);
		} finally {
			await core?.close();
			for (const socket of sockets) socket.destroy();
			if (proxy.listening)
				await new Promise<void>((resolve, reject) =>
					proxy.close((error) => (error ? reject(error) : resolve())),
				);
			try {
				await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			} finally {
				await admin.end();
			}
		}
	},
	30000,
);
