import {
	getConsumerGrants,
	setConsumerGrants,
} from "./connections/consumer-grants";
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
	recordProviderRegistration,
	disconnectProvider,
	fetchOrgToken,
	fetchToken,
	getUserConnections,
	initiateConnection,
	listProviders,
	setProviderAccountMode,
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
	getConsumerGrants,
	setConsumerGrants,
	createConnectionInstance,
	renameConnectionInstance,
	setConnectionAccessCheck,
	preparePersonalConnection,
	stageConnectTicket,
	redeemConnectTicket,
	bindConnectionInstance,
	getConnectionsOverview,
	listProviders,
	setProviderAccountMode,
	auditProviderSettings,
	recordProviderRegistration,
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
