# Notlai MCP

Access your [Notlai](https://www.notlai.com) notes directly from Claude Desktop using the Model Context Protocol.

## Quick Start

### 1. Create an account

Go to [www.notlai.com](https://www.notlai.com) and sign up with your email address. You'll receive a verification code by email — enter it on the site to activate your account.

### 2. Add to Claude Desktop

Open your Claude Desktop configuration file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add the following:

```json
{
  "mcpServers": {
    "notlai": {
      "command": "npx",
      "args": ["-y", "notlai-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### 3. Log in

In Claude Desktop, simply ask:

> "Log me in to Notlai via web"

Claude will start the web login flow and give you a link. Open it in your browser, enter your email and password, and you're connected. Your session is stored locally and refreshed automatically.

**Alternative**: You can also log in directly in the chat:

> "Log me in to Notlai with my email user@example.com"

## Available Tools

Once connected, Claude has access to:

| Tool | Description |
|------|-------------|
| `mcp_notes_web_login` | Start web-based login (recommended) |
| `mcp_notes_login` | Log in with email/password directly |
| `mcp_notes_register` | Create a new account |
| `mcp_notes_status` | Check authentication status |
| `mcp_notes_logout` | Log out and delete local credentials |

## How It Works

- Your credentials are stored locally at `~/.mcp-notes/credentials.json` with restricted permissions (owner read/write only)
- Tokens are refreshed automatically when they expire
- The web login flow uses a temporary local server on `localhost:9876` that shuts down after receiving tokens
- No data is sent to third parties — authentication goes directly to the Notlai backend

## Troubleshooting

### "Not authenticated" error

Ask Claude to run `mcp_notes_web_login` or `mcp_notes_login` to sign in.

### Web login page says "MCP server not reachable"

Make sure Claude Desktop is running and you've asked Claude to start the web login flow before opening the link.

### Port 9876 is already in use

Ask Claude: "Log me in via web on port 9877" — you can use any available port.

## Requirements

- Node.js 20+
- Claude Desktop

## License

MIT
