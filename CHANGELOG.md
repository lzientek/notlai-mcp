# Changelog

## [1.6.0] - 2026-07-24

### Added
- **Favorites**: `notlai_create_note` and `notlai_update_note` now support `isFavorite` parameter
- **Favorites filter**: `notlai_list_notes` supports `favorites: true` to show only favorite notes
- **Star indicator**: favorite notes are marked with ★ in list output

## [1.5.1] - 2026-07-23

### Fixed
- CI: OIDC trusted publishing for npm (requires npm >= 11.5.1, Node 22)
- Repository URL format for npm OIDC validation

## [1.5.0] - 2026-07-23

### Added
- **Markdown support**: `notlai_create_note` and `notlai_update_note` content field now documents Markdown formatting support
- **Multi-client README**: installation guides for Claude (extension + manual), Kiro, Cursor, Windsurf, and generic MCP clients

### Changed
- Tool names renamed from `mcp_notes_*` to `notlai_*` prefix
- Note tools follow `notlai_{action}_note(s)` pattern

## [1.4.0] - 2026-07-22

### Added
- **Notes CRUD tools**: `notlai_list_notes`, `notlai_get_note`, `notlai_create_note`, `notlai_update_note`, `notlai_delete_note`
- `put()` method on API client

### Fixed
- Web login URL updated to `/login?port=` (router paths)
- Register message links to `/signup`

## [1.3.0] - 2026-07-22

### Fixed
- **MCPB compatibility**: bundle server as single CJS file (`dist/bundle.cjs`) via esbuild
- Package size reduced from 4.3MB to 436KB
- Added error handlers for uncaught exceptions

## [1.2.0] - 2026-07-22

### Added
- **MCPB Desktop Extension**: `manifest.json` for Claude Desktop one-click install
- `.mcpbignore` for optimized bundle
- GitHub Actions workflow for automated release (MCPB + npm)
- Extension icon

## [1.1.0] - 2026-07-21

### Added
- Initial release with auth tools: `register`, `login`, `web_login`, `logout`, `status`
- Tag management: `list_tags`, `create_tag`, `delete_tag`
- Web login flow with local auth server
- Credential storage in `~/.mcp-notes/credentials.json`
- Automatic token refresh
