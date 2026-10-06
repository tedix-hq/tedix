import { previewOpenApiImportCatalog } from "./catalog/quality-governance";
import {
	installTenantMcpAppProcedure,
	installTenantMcpAppsProcedure,
	uninstallTenantMcpAppProcedure,
} from "./catalog/tenant-install";
import { tenantCatalogOs } from "./catalog/policy-quality";

export const tenantCatalogContractRouter = tenantCatalogOs.router({
	installTenantMcpApp: installTenantMcpAppProcedure,
	installTenantMcpApps: installTenantMcpAppsProcedure,
	uninstallTenantMcpApp: uninstallTenantMcpAppProcedure,
	previewOpenApiImport: previewOpenApiImportCatalog,
});
