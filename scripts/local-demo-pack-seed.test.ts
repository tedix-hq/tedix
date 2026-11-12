import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	osGadgetCode,
	osGadgetCodeBlobs,
} from "@tedix/db/schema/os-workspaces";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import opportunityCardsApp from "../apps/os/dev/demo-pack/opportunity-cards-app.json";
import { demoPackSeedSql } from "./local-demo-pack-seed";

test("demo app code seeds an idempotent blob and a readable revision pointer", () => {
	const db = new Database(":memory:");
	try {
		db.exec("PRAGMA foreign_keys = OFF");
		db.exec(schemaDdl(osGadgetCode, osGadgetCodeBlobs));
		const statements = demoPackSeedSql()
			.split("\n")
			.filter((line) =>
				/^INSERT OR IGNORE INTO os_gadget_code(?: |_blobs )/.test(line),
			)
			.join("\n");
		db.exec(statements);
		db.exec(statements);
		const files = JSON.stringify(opportunityCardsApp);
		expect(
			db.query("SELECT files, files_sha256 FROM os_gadget_code").all(),
		).toEqual([
			{
				files: "",
				files_sha256: createHash("sha256").update(files).digest("hex"),
			},
		]);
		expect(
			db
				.query(`SELECT b.files, b.code_length FROM os_gadget_code c
			JOIN os_gadget_code_blobs b ON b.organization_id = c.organization_id AND b.sha256 = c.files_sha256`)
				.all(),
		).toEqual([
			{
				files,
				code_length: Object.values(opportunityCardsApp).reduce(
					(sum, source) => sum + source.length,
					0,
				),
			},
		]);
		expect(
			db.query("SELECT count(*) AS n FROM os_gadget_code_blobs").get(),
		).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});
