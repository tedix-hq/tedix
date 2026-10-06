/**
 * The exact `@modelcontextprotocol/client` surface `./mcp-client` and
 * `./first-party-mcp` use, loaded through `import("./mcp-client-sdk")`.
 *
 * Why this module exists: a dynamic `import()` of the SDK package itself keeps
 * its whole namespace alive, so the bundler retains every export (DPoP/JWT auth
 * providers pull in jose's JWE/JWS/key modules). `agents` already initializes
 * the SDK's entry at Worker startup, so anything retained there is evaluated at
 * startup too. Named re-exports let the bundler drop what is unused.
 */
export {
	Client,
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	StreamableHTTPClientTransport,
	UnsupportedProtocolVersionError,
	extractWWWAuthenticateParams,
} from "@modelcontextprotocol/client";
