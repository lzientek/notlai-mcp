# Notlai MCP

Access your [Notlai](https://www.notlai.com) notes directly from any MCP-compatible AI assistant. Create, search, organize, and read your notes with Markdown support — all through natural conversation.

## Quick Start

### 1. Create an account

Go to [www.notlai.com/signup](https://www.notlai.com/signup) and sign up with your email address. You'll receive a verification code by email — enter it to activate your account.

### 2. Install the MCP server

Choose the method matching your AI assistant:

---

#### Claude Desktop (Extension)

Download the `.mcpb` file from the [latest release](https://github.com/lzientek/notlai-mcp/releases/latest), then double-click it. Claude Desktop will install the extension automatically.

---

#### Claude Desktop (Manual)

Add to your config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

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

---

#### Kiro

Add to `.kiro/settings/mcp.json` in your workspace (or `~/.kiro/settings/mcp.json` for global access):

```json
{
  "mcpServers": {
    "notlai": {
      "command": "npx",
      "args": ["-y", "notlai-mcp"],
      "timeout": 30000,
      "type": "stdio",
      "autoApprove": [
        "notlai_status",
        "notlai_list_notes",
        "notlai_get_note",
        "notlai_list_tags"
      ]
    }
  }
}
```

> **Note**: The `timeout` and `autoApprove` fields are recommended for Kiro. Without `timeout`, the first launch (when npx downloads the package) may be considered unresponsive. `autoApprove` allows read-only tools to run without manual confirmation.

---

#### Cursor

Add to your MCP settings (Settings > MCP Servers > Add):

```json
{
  "notlai": {
    "command": "npx",
    "args": ["-y", "notlai-mcp"]
  }
}
```

---

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

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

---

#### Any MCP-compatible client

The server runs as a stdio process. Use the command:

```
npx -y notlai-mcp
```

Configure your client to launch this command and communicate via stdin/stdout using the [Model Context Protocol](https://modelcontextprotocol.io).

---

### 3. Log in

Once the server is running, ask your assistant:

> "Log me in to Notlai via web"

It will start the web login flow and give you a URL. Open it in your browser, enter your credentials, and your session is stored locally.

**Alternative**: Log in directly in the chat:

> "Log me in to Notlai with email user@example.com"

## Available Tools

| Tool | Description |
|------|-------------|
| `notlai_list_notes` | List notes with filters (tags, search, dates, pagination) |
| `notlai_get_note` | Get the full content of a note |
| `notlai_create_note` | Create a note (supports Markdown content) |
| `notlai_update_note` | Update a note's title, content, or tags |
| `notlai_delete_note` | Permanently delete a note |
| `notlai_list_tags` | List all your tags |
| `notlai_create_tag` | Create a new tag |
| `notlai_delete_tag` | Delete a tag (removes it from all notes) |
| `notlai_web_login` | Start web-based login (recommended) |
| `notlai_login` | Log in with email/password directly |
| `notlai_register` | Create a new account |
| `notlai_status` | Check authentication status |
| `notlai_logout` | Log out and delete local credentials |

## Features

- **Markdown content**: Notes support full Markdown (headings, lists, code blocks, links, tables, etc.)
- **Tags**: Organize notes with tags — the AI will automatically suggest relevant tags
- **Search**: Full-text search across titles and content
- **Date filters**: Filter notes by time period
- **Web view**: Browse your notes at [www.notlai.com](https://www.notlai.com) (read-only)

## How It Works

- Credentials are stored locally at `~/.mcp-notes/credentials.json` (owner read/write only)
- Tokens refresh automatically when they expire
- The web login flow uses a temporary local server on `localhost:9876` that shuts down after receiving tokens
- No data is sent to third parties — authentication goes directly to the Notlai backend (AWS Cognito)

## Troubleshooting

### Kiro: tools not appearing after setup

If the Notlai tools don't appear in your Kiro session:

1. Make sure your config includes `"timeout": 30000` — without it, the first launch (npx downloading the package) may timeout before the server responds.
2. Restart your Kiro session after editing `mcp.json`. MCP servers are loaded at session start.
3. Check that `npx -y notlai-mcp` works in your terminal (it should hang waiting for stdin — that's normal).

### "Not authenticated" error

Ask your assistant to run `notlai_web_login` or `notlai_login` to sign in.

### Web login page says "MCP server not reachable"

Make sure your AI client is running and you've asked it to start the web login before opening the link.

### Port 9876 is already in use

Ask: "Log me in via web on port 9877" — any available port works.

## Requirements

- Node.js 20+

## License

MIT
