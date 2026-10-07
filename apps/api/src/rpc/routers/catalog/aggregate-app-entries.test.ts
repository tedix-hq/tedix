import { describe, expect, it } from "vite-plus/test";
import {
	type AggregateAppEntry,
	detachAggregateAppEntries,
	upsertAggregateAppEntry,
} from "./policy-quality";

/** Gateway entries link installed apps by id; slug is only a display name. */
const MAIL_ID = "40000000-0000-4000-8000-000000000001";
const DOCS_ID = "40000000-0000-4000-8000-000000000002";

describe("upsertAggregateAppEntry", () => {
	it("merges into an old slug-only entry and stamps the id", () => {
		const existing: AggregateAppEntry[] = [
			{ slug: "acme-mail", prefix: "mail", toolIds: ["read"] },
			{ appId: DOCS_ID, slug: "acme-docs" },
		];
		const { entries, attached } = upsertAggregateAppEntry(existing, {
			appId: MAIL_ID,
			slug: "acme-mail",
			prefix: "mail",
		});
		expect(attached).toBe(false);
		expect(entries).toEqual([
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail", toolIds: ["read"] },
			{ appId: DOCS_ID, slug: "acme-docs" },
		]);
	});

	it("matches an id entry whose app was renamed, without duplicating it", () => {
		const { entries, attached } = upsertAggregateAppEntry(
			[{ appId: MAIL_ID, slug: "acme-mail-old", prefix: "mail" }],
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail" },
		);
		expect(attached).toBe(false);
		expect(entries).toEqual([
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail" },
		]);
	});

	it("collapses a slug-only and an id entry for the same app into one", () => {
		const { entries } = upsertAggregateAppEntry(
			[
				{ slug: "acme-mail", prefix: "mail" },
				{ appId: MAIL_ID, slug: "acme-mail" },
			],
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail" },
		);
		expect(entries).toEqual([
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail" },
		]);
	});

	it("appends a different app even when it now carries a former slug", () => {
		const { entries, attached } = upsertAggregateAppEntry(
			[{ appId: DOCS_ID, slug: "acme-mail" }],
			{ appId: MAIL_ID, slug: "acme-mail" },
		);
		expect(attached).toBe(true);
		expect(entries).toHaveLength(2);
	});
});

describe("detachAggregateAppEntries", () => {
	it("removes an id entry by the app's current identity after a rename", () => {
		const result = detachAggregateAppEntries(
			[
				{ appId: MAIL_ID, slug: "acme-mail-old", prefix: "mail" },
				{ appId: DOCS_ID, slug: "acme-docs", prefix: "docs" },
			],
			{ appId: MAIL_ID, slug: "acme-mail" },
		);
		expect(result.aggregateEntry).toEqual({
			appId: MAIL_ID,
			slug: "acme-mail-old",
			prefix: "mail",
		});
		expect(result.remainingAggregateApps).toEqual([
			{ appId: DOCS_ID, slug: "acme-docs", prefix: "docs" },
		]);
	});

	it("removes an old slug-only entry", () => {
		const result = detachAggregateAppEntries(
			[{ slug: "acme-mail" }, { appId: DOCS_ID, slug: "acme-docs" }],
			{ appId: MAIL_ID, slug: "acme-mail" },
		);
		expect(result.aggregateEntry).toEqual({ slug: "acme-mail" });
		expect(result.remainingAggregateApps).toEqual([
			{ appId: DOCS_ID, slug: "acme-docs" },
		]);
	});

	it("keeps another app's entry that shares the slug text", () => {
		const entries = [{ appId: DOCS_ID, slug: "acme-mail" }];
		const result = detachAggregateAppEntries(entries, {
			appId: MAIL_ID,
			slug: "acme-mail",
		});
		expect(result.aggregateEntry).toBeNull();
		expect(result.remainingAggregateApps).toEqual(entries);
	});

	it("narrows by namespace prefix and detaches nothing without criteria", () => {
		const entries: AggregateAppEntry[] = [
			{ appId: MAIL_ID, slug: "acme-mail", prefix: "mail" },
			{ appId: DOCS_ID, slug: "acme-docs", prefix: "docs" },
		];
		expect(
			detachAggregateAppEntries(entries, { prefix: "docs" }).aggregateEntry
				?.appId,
		).toBe(DOCS_ID);
		expect(detachAggregateAppEntries(entries, {}).aggregateEntry).toBeNull();
	});
});
