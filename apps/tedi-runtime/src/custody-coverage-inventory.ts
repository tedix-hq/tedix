/** Passive metadata inventory. No value enumeration, lifecycle or archive writes. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	encryptTediSecret,
	decryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import {
	NativePreservationTableNames,
	SessionPreservationTableNames,
	SdkPreservationTableNames,
	CutoverInspectionHopSchema,
	type TediRuntimeCustodyCoverageResponse,
} from "@tedix/api-contract/schemas/tedi";
import { HISTORICAL_CAPTURE_SELECTORS } from "./historical-liability-custody";
const BYTES = 8 * 1024 * 1024,
	CELL = 65536,
	PAGE = 200,
	TTL = 300000;
const PURPOSE = "custody-coverage-metadata-page-v1";
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const IdentitySchema = z.strictObject({
	rootPhysicalId: HASH,
	targetPhysicalId: HASH,
	organizationId: z.string().uuid(),
	tediId: z.string().uuid(),
	operationId: z.string().min(1).max(256),
	namespaceClass: z.string().min(1).max(128),
	targetName: z.string().min(1).max(1024),
	targetPath: z.array(CutoverInspectionHopSchema).max(16),
	generation: z.number().int().positive().safe(),
	receiver: z.literal("raw-cutover-v1"),
});
export type CustodyCoverageIdentity = z.infer<typeof IdentitySchema>;
const CursorSchema = z.strictObject({
	version: z.literal(1),
	purpose: z.literal(PURPOSE),
	identity: IdentitySchema,
	issuedAt: z.number().int().nonnegative().safe(),
	expiresAt: z.number().int().nonnegative().safe(),
	sqlMetadataHash: HASH,
	registryHash: HASH,
	coverageHash: HASH,
	classificationVersion: z.literal(1),
	kvStatus: z.literal("unsupported_metadata_only_enumeration_unavailable"),
	nextDomain: z.enum(["sql", "registry"]),
	nextOffset: z.number().int().nonnegative().safe(),
});
const prior = [
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
	"native_preservation_snapshot",
	"native_preservation_parts",
	"session_preservation_snapshot",
	"session_preservation_parts",
	"sdk_work_preservation_snapshot",
	"sdk_work_preservation_parts",
];
const selectors = {
	native23: NativePreservationTableNames,
	session8: SessionPreservationTableNames,
	sdk43: SdkPreservationTableNames,
	historical: [
		...HISTORICAL_CAPTURE_SELECTORS.factTables,
		...HISTORICAL_CAPTURE_SELECTORS.historyTables,
		...HISTORICAL_CAPTURE_SELECTORS.sdkTables,
	],
	prior_archive: prior,
};
const kv = {
	status: "unsupported_metadata_only_enumeration_unavailable",
	enumeration: "not_queried",
	complete: false,
	keyCount: null,
	keyIdentityHash: null,
	valueCoverage: "not_queried",
	payloadAuthenticity: "not_queried",
} as const;
const refusal = (): never => {
	throw Error("Custody coverage unavailable");
};
function safe(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) refusal();
	return v as number;
}
type SqlItem = TediRuntimeCustodyCoverageResponse["items"][number] & {
	domain: "sql";
};
type RegistryItem = TediRuntimeCustodyCoverageResponse["items"][number] & {
	domain: "registry";
};
export function prepareCustodyCoverage(input: {
	storage: Pick<DurableObjectStorage, "sql">;
	identity: CustodyCoverageIdentity;
	namespace: Pick<DurableObjectNamespace, "idFromName">;
	masterKey: string;
	deadline: number;
	signal?: AbortSignal;
	recheck: () => void;
	verifyCanonical: () => Promise<void>;
	continuation?: string;
	coverageHash?: string;
}) {
	// Capture the carrier before invoking caller code or crossing an await.
	input = Object.freeze({
		...input,
		storage: Object.freeze({
			sql: Object.freeze({
				exec: input.storage.sql.exec.bind(input.storage.sql),
			}),
		}) as Pick<DurableObjectStorage, "sql">,
		identity: IdentitySchema.parse(input.identity),
		namespace: Object.freeze({
			idFromName: input.namespace.idFromName.bind(input.namespace),
		}),
		recheck: input.recheck,
		verifyCanonical: input.verifyCanonical,
	});
	const identity = input.identity,
		frozenIdentity = JSON.stringify(identity);
	let retained = 0;
	const charge = (n: number) => {
		n = safe(n);
		if (!Number.isSafeInteger(retained + n) || retained + n > BYTES) refusal();
		retained += n;
		guard();
	};
	const release = (n: number) => {
		retained -= n;
		if (retained < 0) refusal();
	};
	let first: unknown,
		failed = false,
		ready = false,
		issuedAt = Date.now(),
		expiresAt = issuedAt + TTL;
	const guard = () => {
		try {
			input.recheck();
			if (
				input.signal?.aborted ||
				performance.now() >= input.deadline ||
				Date.now() >= expiresAt
			)
				refusal();
		} catch (e) {
			if (!failed) {
				failed = true;
				first = e;
			}
		}
		if (failed) throw first;
	};
	const checked = async <T>(p: Promise<T>) => {
		const observed = Promise.resolve(p);
		void observed.catch(() => {});
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort: (() => void) | undefined;
		try {
			continuity();
			return await Promise.race([
				observed,
				new Promise<never>((_, reject) => {
					abort = () => reject(Error("Custody coverage unavailable"));
					input.signal?.addEventListener("abort", abort, { once: true });
					timer = setTimeout(
						() => reject(Error("Custody coverage unavailable")),
						Math.max(
							0,
							Math.min(
								input.deadline - performance.now(),
								expiresAt - Date.now(),
							),
						),
					);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (abort) input.signal?.removeEventListener("abort", abort);
			continuity();
		}
	};
	function snapshot() {
		guard();
		const text = (v: unknown, nullable = false) => {
			if (nullable && v === null) return null;
			if (typeof v !== "string") refusal();
			const s = v as string,
				n = Buffer.byteLength(s);
			if (n > CELL) refusal();
			charge(n);
			return s;
		};
		// Compute a conservative escaped-JSON allocation bound without constructing
		// a JSON string or collections. Each individual descriptor remains <=64KiB.
		const jsonBound = (v: unknown, depth = 0): number => {
			guard();
			if (depth > 128) refusal();
			let n = 0;
			if (v === null) n = 4;
			else if (typeof v === "string") {
				n = 2;
				for (let i = 0; i < v.length; i++) {
					if (i % 16384 === 0) guard();
					const c = v.charCodeAt(i);
					if (
						c === 34 ||
						c === 92 ||
						c === 8 ||
						c === 9 ||
						c === 10 ||
						c === 12 ||
						c === 13
					)
						n += 2;
					else if (c < 32) n += 6;
					else if (c < 128) n++;
					else if (c < 2048) n += 2;
					else if (
						c >= 0xd800 &&
						c <= 0xdbff &&
						i + 1 < v.length &&
						v.charCodeAt(i + 1) >= 0xdc00 &&
						v.charCodeAt(i + 1) <= 0xdfff
					) {
						n += 4;
						i++;
					} else if (c >= 0xd800 && c <= 0xdfff) n += 6;
					else n += 3;
					if (n > CELL) refusal();
				}
			} else if (typeof v === "number") n = 32;
			else if (typeof v === "boolean") n = 5;
			else if (Array.isArray(v)) {
				n = 2;
				for (const x of v) {
					n += jsonBound(x, depth + 1) + 1;
					if (!Number.isSafeInteger(n) || n > CELL) refusal();
				}
			} else if (typeof v === "object") {
				n = 2;
				for (const k in v) {
					if (Object.prototype.hasOwnProperty.call(v, k)) {
						n +=
							jsonBound(k, depth + 1) +
							1 +
							jsonBound((v as Record<string, unknown>)[k], depth + 1) +
							1;
						if (!Number.isSafeInteger(n) || n > CELL) refusal();
					}
				}
			} else refusal();
			if (!Number.isSafeInteger(n) || n > CELL) refusal();
			return n;
		};
		const serialize = (v: unknown, _reserve: number) => {
			const reserve = jsonBound(v);
			charge(reserve);
			return JSON.stringify(v);
		};
		const feed = (h: ReturnType<typeof createHash>, s: string) => {
			for (let i = 0; i < s.length;) {
				guard();
				let end = Math.min(s.length, i + CELL / 4);
				if (
					end < s.length &&
					s.charCodeAt(end - 1) >= 0xd800 &&
					s.charCodeAt(end - 1) <= 0xdbff
				)
					end--;
				const reserve = (end - i) * 9;
				charge(reserve);
				try {
					const chunk = s.slice(i, end);
					h.update(Buffer.from(chunk));
				} finally {
					release(reserve);
				}
				i = end;
			}
		};
		const hash = (s: string) => {
			const h = createHash("sha256");
			feed(h, s);
			charge(64);
			return h.digest("hex");
		};
		const hashArray = (values: unknown[]) => {
			const h = createHash("sha256");
			feed(h, "[");
			for (let i = 0; i < values.length; i++) {
				if (i) feed(h, ",");
				const before = retained;
				try {
					feed(h, serialize(values[i], CELL));
				} finally {
					release(retained - before);
				}
			}
			feed(h, "]");
			charge(64);
			return h.digest("hex");
		};
		const one = (sql: string, ...args: SqlStorageValue[]) => {
			guard();
			const it = input.storage.sql.exec(sql, ...args)[Symbol.iterator](),
				a = it.next();
			if (a.done || !it.next().done) refusal();
			return a.value;
		};
		const sql: SqlItem[] = [];
		let registryColumns: string[] | undefined;
		// Length/type-only checks precede full DDL/name fetch; rows are individually bounded.
		for (let offset = 0; ; offset++) {
			guard();
			const rows = [
				...input.storage.sql.exec(
					"SELECT type,typeof(name) AS nt,length(CAST(name AS BLOB)) AS nb,typeof(tbl_name) AS tt,length(CAST(tbl_name AS BLOB)) AS tb,typeof(sql) AS st,coalesce(length(CAST(sql AS BLOB)),0) AS sb FROM sqlite_master ORDER BY type,name LIMIT 1 OFFSET ?",
					offset,
				),
			];
			if (!rows.length) break;
			if (rows.length !== 1) refusal();
			const probe = rows[0]!;
			if (
				probe.nt !== "text" ||
				probe.tt !== "text" ||
				!["text", "null"].includes(String(probe.st)) ||
				safe(probe.nb) > CELL ||
				safe(probe.tb) > CELL ||
				safe(probe.sb) > CELL
			)
				refusal();
			charge(safe(probe.nb) + safe(probe.tb) + safe(probe.sb) + 1024);
			const row = one(
				"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 1 OFFSET ?",
				offset,
			);
			const name = text(row.name)!,
				tableName = text(row.tbl_name)!,
				ddl = text(row.sql, true),
				type = z.enum(["table", "view", "index", "trigger"]).parse(row.type);
			const memberships = (
				Object.keys(selectors) as (keyof typeof selectors)[]
			).filter((k) => (selectors[k] as readonly string[]).includes(tableName));
			const collision = Object.values(selectors).some((names) =>
				names.some(
					(n) => n.toLowerCase() === tableName.toLowerCase() && n !== tableName,
				),
			);
			let shape: SqlItem["shape"] =
					type === "view" ? "view" : collision ? "case_collision" : "ordinary",
				columnsHash: string | null = null;
			if (type === "table" && name === "_cf_KV") shape = "provider_private";
			else if (type === "table") {
				const t = one(
					"SELECT type,wr,ncol FROM pragma_table_list WHERE schema='main' AND name=?",
					name,
				);
				if (t.type === "shadow") shape = "shadow";
				else if (t.type === "virtual") shape = "virtual";
				else if (t.type !== "table") refusal();
				const columns: unknown[] = [];
				if (name === "cf_agents_sub_agents") {
					charge(64);
					registryColumns = [];
				}
				for (let c = 0; c < safe(t.ncol); c++) {
					const cp = one(
						"SELECT length(CAST(name AS BLOB)) AS nb,length(CAST(type AS BLOB)) AS tb,length(CAST(dflt_value AS BLOB)) AS db FROM pragma_table_xinfo(?) WHERE cid=?",
						name,
						c,
					);
					for (const n of [cp.nb, cp.tb, cp.db ?? 0])
						if (safe(n) > CELL) refusal();
					charge(safe(cp.nb) + safe(cp.tb) + safe(cp.db ?? 0) + 256);
					const col = one(
						'SELECT cid,name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?) WHERE cid=?',
						name,
						c,
					);
					if (safe(col.hidden) > 0 && shape === "ordinary") shape = "generated";
					if (registryColumns && name === "cf_agents_sub_agents") {
						if (typeof col.name !== "string") refusal();
						charge(16);
						registryColumns.push(col.name);
					}
					columns.push(col);
				}
				columnsHash = hash(
					serialize(
						{ type: t.type, withoutRowid: t.wr, columns },
						Math.min(BYTES, columns.length * 256 + safe(probe.sb) * 2 + 1024),
					),
				);
			}
			const unsupported = shape !== "ordinary";
			sql.push({
				domain: "sql",
				name,
				type,
				tableName,
				ddlHash: ddl === null ? null : hash(ddl),
				columnsHash,
				shape,
				classification: unsupported
					? "unsupported"
					: memberships.length
						? "declared"
						: "uncovered",
				memberships,
				archiveAuthenticated: false,
			});
		}
		charge(sql.length * 64);
		const tables = new Map<string, SqlItem>();
		for (const item of sql) {
			guard();
			if (item.type === "table") tables.set(item.name, item);
		}
		for (const item of sql) {
			guard();
			const owner = tables.get(item.tableName);
			if (owner && owner.shape !== "ordinary") {
				item.shape = owner.shape;
				item.classification = "unsupported";
			}
		}
		const registry: RegistryItem[] = [],
			tuples: Omit<RegistryItem, "registryMetadataHash">[] = [];
		const registryTable = tables.get("cf_agents_sub_agents");
		if (registryTable) {
			if (registryTable.shape !== "ordinary") refusal();
			const cols = registryColumns ?? refusal();
			if (!cols.includes("class") || !cols.includes("name")) refusal();
			const iv = cols.includes("identity_version")
					? "identity_version"
					: "NULL",
				iname = cols.includes("identity_name") ? "identity_name" : "NULL";
			for (let offset = 0; ; offset++) {
				guard();
				const probes = [
					...input.storage.sql.exec(
						`SELECT length(CAST(class AS BLOB)) AS cb,length(CAST(name AS BLOB)) AS nb,length(CAST(${iv} AS BLOB)) AS vb,length(CAST(${iname} AS BLOB)) AS ib FROM cf_agents_sub_agents ORDER BY class,name LIMIT 1 OFFSET ?`,
						offset,
					),
				];
				if (!probes.length) break;
				if (probes.length !== 1) refusal();
				const probe = probes[0]!;
				for (const n of [probe.cb, probe.nb, probe.vb ?? 0, probe.ib ?? 0])
					if (safe(n) > CELL) refusal();
				charge(
					safe(probe.cb) +
						safe(probe.nb) +
						safe(probe.vb ?? 0) +
						safe(probe.ib ?? 0) +
						2048,
				);
				const r = one(
					`SELECT class,name,${iv} AS identity_version,${iname} AS identity_name FROM cf_agents_sub_agents ORDER BY class,name LIMIT 1 OFFSET ?`,
					offset,
				);
				const hop = CutoverInspectionHopSchema.parse({
					className: r.class,
					name: r.name,
					identityVersion: r.identity_version,
					identityName: r.identity_name,
					objectId: input.namespace
						.idFromName(String(r.identity_name ?? r.name))
						.toString(),
					registryHash: "0".repeat(64),
					parentGeneration: identity.generation,
				});
				const { registryHash: _, ...rest } = hop;
				tuples.push({
					domain: "registry",
					...rest,
					routingCustody: "not_queried",
					disposition: "registered_not_visited",
					childGeneration: null,
					localOwner: "UNKNOWN",
				});
			}
		}
		const sqlMetadataHash = hashArray(sql),
			registryHash = hashArray(tuples);
		for (const t of tuples)
			registry.push({ ...t, registryMetadataHash: registryHash });
		const coverageHash = hash(
			serialize(
				{
					sqlMetadataHash,
					registryHash,
					kv,
					alarm: "UNKNOWN",
					remoteEffects: "not_queried",
					writerExclusionAck: "UNKNOWN",
				},
				2048,
			),
		);
		return { sql, registry, sqlMetadataHash, registryHash, coverageHash };
	}
	charge(
		frozenIdentity.length * 6 +
			(input.continuation?.length ?? 0) * 6 +
			input.masterKey.length * 6,
	);
	const original = snapshot();
	const originalRetained = retained;
	const continuity = () => {
		guard();
		try {
			const baseline = retained;
			try {
				const current = snapshot();
				if (current.coverageHash !== original.coverageHash) refusal();
			} finally {
				release(retained - baseline);
			}
		} catch (e) {
			if (!failed) {
				failed = true;
				first = e;
			}
			throw first;
		}
	};
	const result = (async () => {
		await checked(input.verifyCanonical());
		let offset = 0;
		if (input.continuation !== undefined) {
			if (
				input.continuation.length > 131072 ||
				!/^[A-Za-z0-9+/]+={0,2}$/.test(input.continuation) ||
				!input.coverageHash
			)
				refusal();
			charge(input.continuation.length * 8 + CELL * 2);
			const plaintext = await checked(
				decryptTediSecret(input.masterKey, identity.tediId, input.continuation),
			);
			if (Buffer.byteLength(plaintext) > CELL) refusal();
			const cursor = CursorSchema.parse(JSON.parse(plaintext));
			if (
				JSON.stringify(cursor.identity) !== frozenIdentity ||
				cursor.expiresAt - cursor.issuedAt !== TTL ||
				cursor.issuedAt > Date.now() ||
				cursor.expiresAt <= Date.now() ||
				cursor.sqlMetadataHash !== original.sqlMetadataHash ||
				cursor.registryHash !== original.registryHash ||
				cursor.coverageHash !== original.coverageHash ||
				input.coverageHash !== original.coverageHash
			)
				refusal();
			issuedAt = cursor.issuedAt;
			expiresAt = cursor.expiresAt;
			offset =
				cursor.nextDomain === "sql"
					? cursor.nextOffset
					: original.sql.length + cursor.nextOffset;
			if (
				offset === 0 ||
				offset % PAGE !== 0 ||
				offset >= original.sql.length + original.registry.length ||
				cursor.nextDomain !==
					(offset < original.sql.length ? "sql" : "registry")
			)
				refusal();
		} else if (input.coverageHash !== undefined) refusal();
		continuity();
		await checked(input.verifyCanonical());
		charge((original.sql.length + original.registry.length) * 16 + PAGE * 16);
		const all = [...original.sql, ...original.registry],
			end = Math.min(offset + PAGE, all.length);
		let continuation: string | null = null;
		if (end < all.length) {
			charge(frozenIdentity.length * 12 + 16384 + CELL * 8);
			const value = {
				version: 1,
				purpose: PURPOSE,
				identity,
				issuedAt,
				expiresAt,
				sqlMetadataHash: original.sqlMetadataHash,
				registryHash: original.registryHash,
				coverageHash: original.coverageHash,
				classificationVersion: 1,
				kvStatus: kv.status,
				nextDomain: end < original.sql.length ? "sql" : "registry",
				nextOffset: end < original.sql.length ? end : end - original.sql.length,
			};
			const plaintext = JSON.stringify(value);
			if (Buffer.byteLength(plaintext) > CELL) refusal();
			continuation = await checked(
				encryptTediSecret(input.masterKey, identity.tediId, plaintext),
			);
			if (continuation.length > 131072) refusal();
		}
		const value = {
			version: "custody-coverage-metadata-v1" as const,
			coverageHash: original.coverageHash,
			sqlMetadataHash: original.sqlMetadataHash,
			registryHash: original.registryHash,
			issuedAt,
			expiresAt,
			sqlObjects: original.sql.length,
			registeredTargets: original.registry.length,
			offset,
			items: all.slice(offset, end),
			continuation,
			metadataEnumerationComplete: end === all.length,
			kv,
			alarm: "UNKNOWN" as const,
			remoteEffects: "not_queried" as const,
			writerExclusionAck: "UNKNOWN" as const,
			wholeContentPreserved: false as const,
			wholePreservationReady: false as const,
			adoptionReady: false as const,
			executionEligible: false as const,
			financialClearance: false as const,
		};
		charge(originalRetained + 131072);
		if (Buffer.byteLength(JSON.stringify(value)) > BYTES) refusal();
		continuity();
		ready = true;
		return value;
	})();
	return {
		result,
		assertContinuity: continuity,
		assertReady: () => {
			continuity();
			if (!ready) refusal();
		},
	};
}
