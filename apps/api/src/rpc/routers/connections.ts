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
	setConnectionAccessCheck,
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
import {
	redeemConnectTicket,
	stageConnectTicket,
} from "./connections/connect-tickets";
import { connectionsOs } from "./connections/policy-resolution";

// =============================================================================
// ROUTER
// =============================================================================

export const connectionsContractRouter = connectionsOs.router({
	createConnectionInstance,
	renameConnectionInstance,
	setConnectionAccessCheck,
	preparePersonalConnection,
	stageConnectTicket,
	redeemConnectTicket,
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
