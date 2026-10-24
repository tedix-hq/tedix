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
client.setQueryData(cliWorkspacesDirectoryQueryOptions().queryKey, {
	data: ["Acme", "Globex"].map((name) => ({
		org: {
			organizationId: `org_${name.toLowerCase()}`,
			name,
			slug: name.toLowerCase(),
			descopeTenantId: `tenant_${name.toLowerCase()}`,
			provisionComplete: true,
		},
	})),
});

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<CliLoginPage />
	</QueryClientProvider>,
);
