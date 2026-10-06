import { describe, expect, it } from "vite-plus/test";
import {
	AUDIT_ALL_RESOURCES,
	AUDIT_DEFAULT_SEARCH,
	AUDIT_PAGE_SIZE,
	auditSearchInput,
	isDefaultAuditSearch,
	validateAuditSearch,
} from "./audit-search";

/** URL search values arrive untyped; the marker brand exists only for links. */
const parseSearch = (search: Record<string, unknown>) =>
	validateAuditSearch(search as Parameters<typeof validateAuditSearch>[0]);

describe("validateAuditSearch", () => {
	it("defaults every omitted field to the unfiltered first page", () => {
		expect(parseSearch({})).toEqual(AUDIT_DEFAULT_SEARCH);
	});

	it("keeps valid filter and paging values", () => {
		expect(
			parseSearch({
				resourceType: "skill",
				action: "record_skill",
				page: 3,
			}),
		).toEqual({ resourceType: "skill", action: "record_skill", page: 3 });
	});

	it("lands hand-typed junk on the default instead of an error page", () => {
		expect(parseSearch({ resourceType: 42, action: ["x"], page: 0 })).toEqual(
			AUDIT_DEFAULT_SEARCH,
		);
		expect(parseSearch({ page: -5 }).page).toBe(1);
		expect(parseSearch({ resourceType: "a".repeat(256) }).resourceType).toBe(
			AUDIT_ALL_RESOURCES,
		);
	});
});

describe("isDefaultAuditSearch", () => {
	it("treats the unfiltered first page as the default view", () => {
		expect(isDefaultAuditSearch(AUDIT_DEFAULT_SEARCH)).toBe(true);
		// Whitespace-only values are the same read as no filter.
		expect(
			isDefaultAuditSearch({ resourceType: "  ", action: " ", page: 1 }),
		).toBe(true);
	});

	it("marks any filter or later page as non-default", () => {
		expect(
			isDefaultAuditSearch({ ...AUDIT_DEFAULT_SEARCH, resourceType: "app" }),
		).toBe(false);
		expect(
			isDefaultAuditSearch({ ...AUDIT_DEFAULT_SEARCH, action: "user.login" }),
		).toBe(false);
		expect(isDefaultAuditSearch({ ...AUDIT_DEFAULT_SEARCH, page: 2 })).toBe(
			false,
		);
	});
});

describe("auditSearchInput", () => {
	it("uses the shared 20-row operational page rhythm", () => {
		expect(AUDIT_PAGE_SIZE).toBe(20);
	});

	it("maps 1-based pages onto contract offsets", () => {
		expect(auditSearchInput(AUDIT_DEFAULT_SEARCH)).toEqual({
			limit: AUDIT_PAGE_SIZE,
			offset: 0,
		});
		expect(auditSearchInput({ ...AUDIT_DEFAULT_SEARCH, page: 3 }).offset).toBe(
			2 * AUDIT_PAGE_SIZE,
		);
	});

	it("drops empty filters so no meaningless key variant is generated", () => {
		const input = auditSearchInput({
			resourceType: AUDIT_ALL_RESOURCES,
			action: "  ",
			page: 2,
		});
		expect("resourceType" in input).toBe(false);
		expect("action" in input).toBe(false);
	});

	it("trims and forwards real filters", () => {
		expect(
			auditSearchInput({
				resourceType: " skill ",
				action: " record_skill ",
				page: 1,
			}),
		).toEqual({
			limit: AUDIT_PAGE_SIZE,
			offset: 0,
			resourceType: "skill",
			action: "record_skill",
		});
	});
});
