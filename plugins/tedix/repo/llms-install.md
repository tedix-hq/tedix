# Install the Tedix MCP server

Instructions for an AI agent installing Tedix for its user.

Tedix is a platform for agents, apps, and work. These steps add its remote MCP
connection. No local server or API key is needed: the user signs in through the
browser with OAuth the first time the connection is used. Tedix Cloud is an
invited beta; a user without access gets a sign-in page that offers to request it.

## 1. Add the server

Add this entry to the client's MCP settings (for Cline:
`cline_mcp_settings.json`), keeping any existing servers:

```json
{
	"mcpServers": {
		"tedix": {
			"type": "streamableHttp",
			"url": "https://connect.mcp.tedix.dev/mcp"
		}
	}
}
```

Clients that name the field differently use the same URL, for example
`"httpUrl"` in Gemini CLI or `"type": "http"` in Claude Code.

## 2. Let the user sign in

The first request returns `401` with OAuth metadata. Open the sign-in page the
client offers and let the user complete it. Never ask for, paste or store a
token, password or cookie; sign-in and consent belong to the user.

## 3. Check the connection

After sign-in, list the server's tools. Start with a read-only call, such as
listing the user's Work or reading the decisions waiting for them in Decisions.
Discover each tool's schema before calling it, and treat any tool that writes
or sends something as a change the user must ask for.

More: https://docs.tedix.dev/agent-guide/
