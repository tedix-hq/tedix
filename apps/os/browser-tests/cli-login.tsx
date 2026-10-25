import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { CliLoginPage } from "../src/account/cli-login-page";
import {
	cliWorkspacesDirectoryQueryOptions,
	osOrganizationsQueryOptions,
} from "../src/account/query-options";
import "../src/styles.css";

const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});
client.setQueryData(osOrganizationsQueryOptions().queryKey, {
	data: [{ organizationId: "org_acme" }],
});
// Long names must stay readable in full (cli-login.spec.ts checks them).
const names = [
	"Acme",
	"Globex",
	"Northwind Regional Logistics Cooperative of the Upper Valley — Field Operations",
	"ContosoInternationalHoldingsEuropeanOperationsDivisionShared",
];

client.setQueryData(cliWorkspacesDirectoryQueryOptions().queryKey, {
	data: names.map((name, index) => ({
		org: {
			organizationId: `org_${index}`,
			name,
			slug: `org-${index}`,
			descopeTenantId: `tenant_${index}`,
			provisionComplete: true,
		},
	})),
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<CliLoginPage />
	</QueryClientProvider>,
);
