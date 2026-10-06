import { appsContract } from "@tedix/api-contract/contracts/apps";
import { browserContract } from "@tedix/api-contract/contracts/browser";
import { catalogContract } from "@tedix/api-contract/contracts/catalog";
import { connectionsContract } from "@tedix/api-contract/contracts/connections";
import { imagesContract } from "@tedix/api-contract/contracts/images";
import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import { templatesContract } from "@tedix/api-contract/contracts/templates";
import { describe, expect, it } from "vite-plus/test";
import { isPublicProcedure } from "./openapi-filter";
import {
	getPublicOperationKey,
	PUBLIC_REST_OPERATION_LIST,
	PUBLIC_REST_OPERATIONS,
} from "./public-rest-operations";

describe("public OpenAPI filter", () => {
	it("publishes an explicitly supported operation", () => {
		expect(getPublicOperationKey(appsContract.list)).toBe("GET /apps");
		expect(isPublicProcedure(appsContract.list)).toBe(true);
		expect(isPublicProcedure(organizationsContract.resolveCliWorkspace)).toBe(
			true,
		);
	});

	it("does not publish another operation merely because it shares a tag", () => {
		expect(isPublicProcedure(appsContract.provision)).toBe(false);
		expect(isPublicProcedure(templatesContract.list)).toBe(true);
		expect(isPublicProcedure(templatesContract.create)).toBe(false);
		expect(isPublicProcedure(templatesContract.update)).toBe(false);
		expect(isPublicProcedure(templatesContract.delete)).toBe(false);
	});

	it("keeps unlisted and runtime namespaces private by default", () => {
		expect(isPublicProcedure(imagesContract.upload)).toBe(false);
		expect(isPublicProcedure(browserContract.capturePage)).toBe(false);
	});

	it("keeps credential and service operations RPC-only", () => {
		expect(isPublicProcedure(connectionsContract.listProviders)).toBe(false);
		expect(isPublicProcedure(connectionsContract.fetchOrgToken)).toBe(false);
		expect(isPublicProcedure(connectionsContract.fetchTediToken)).toBe(false);
		expect(isPublicProcedure(connectionsContract.fetchToken)).toBe(false);
		expect(isPublicProcedure(connectionsContract.auditProviderSettings)).toBe(
			false,
		);
		expect(isPublicProcedure(organizationsContract.list)).toBe(false);
		expect(isPublicProcedure(organizationsContract.getMyOrganization)).toBe(
			false,
		);
	});

	it("keeps catalog maintenance private inside the public marketplace", () => {
		expect(isPublicProcedure(catalogContract.getSyncLogs)).toBe(false);
		expect(isPublicProcedure(catalogContract.list)).toBe(true);
	});

	it("contains no duplicate operation keys", () => {
		expect(PUBLIC_REST_OPERATIONS.size).toBe(PUBLIC_REST_OPERATION_LIST.length);
	});
});
