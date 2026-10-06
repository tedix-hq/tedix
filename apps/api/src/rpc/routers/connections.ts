import { getConnectionsOverview } from "./connections/inventory";
/**
 * connections router composition.
 * Capability handlers and shared policy live in ./connections/.
 */
import {
	createProvider,
	fetchTediToken,
	getTediConnections,
	storeApiKey,
} from "./connections/credentials-tedi";
import {
	auditProviderSettings,
	disconnectProvider,
	fetchOrgToken,
	fetchToken,
	getUserConnections,
	initiateConnection,
	listProviders,
	createConnectionInstance,
	renameConnectionInstance,
	preparePersonalConnection,
	bindConnectionInstance,
} from "./connections/discovery-user";
import {
	adaptiveConnect,
	createProviderFromMcp,
	createTediProvider,
	deleteProvider,
	disconnectTediProvider,
	storeTediApiKey,
	updateProviderMetadata,
} from "./connections/provider-management";
import { connectionsOs } from "./connections/policy-resolution";

// =============================================================================
// ROUTER
// =============================================================================

export const connectionsContractRouter = connectionsOs.router({
	createConnectionInstance,
	renameConnectionInstance,
	preparePersonalConnection,
	bindConnectionInstance,
	getConnectionsOverview,
	listProviders,
	auditProviderSettings,
	getUserConnections,
	initiateConnection,
	disconnectProvider,
	fetchToken,
	fetchTediToken,
	fetchOrgToken,
	getTediConnections,
	storeApiKey,
	createProvider,
	createProviderFromMcp,
	updateProviderMetadata,
	deleteProvider,
	createTediProvider,
	storeTediApiKey,
	disconnectTediProvider,
	adaptiveConnect,
});
