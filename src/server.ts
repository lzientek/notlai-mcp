import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createCredentialStore } from './storage/credentials.js';
import { validateEmail } from './validators/email.js';
import { validatePassword } from './validators/password.js';
import { mapCognitoError, authRequiredError, tokenExpiredError } from './errors/mapper.js';
import { refreshTokenIfNeeded } from './auth/refresh.js';
import { createLocalAuthServer, type LocalAuthServer } from './auth/local-auth-server.js';
import { createApiClient, type ApiClient } from './api/client.js';
import type { McpNotesConfig } from './types/config.js';

export interface McpNotesServerDeps {
  config: McpNotesConfig;
  cognitoClient?: CognitoIdentityProviderClient;
}

interface Tag {
  tagId: string;
  name: string;
  createdAt: string;
}

interface TagsResponse {
  tags: Tag[];
}

interface Folder {
  folderId: string;
  name: string;
  createdAt: string;
}

interface FoldersResponse {
  folders: Folder[];
}

interface Note {
  noteId: string;
  userId: string;
  title: string;
  content: string;
  tags: string[];
  folderId: string | null;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  // Share fields (present when scope=shared or scope=all)
  isShared?: boolean;
  ownerId?: string;
  permission?: 'read' | 'write';
  sharedAt?: string;
}

interface NotesListResponse {
  notes: Note[];
  nextCursor: string | null;
}

interface ShareResponse {
  shareId: string;
  shareUrl?: string;
  type: 'public' | 'user';
  email?: string;
  permission: 'read' | 'write';
  createdAt?: string;
}

export function createMcpNotesServer(deps: McpNotesServerDeps) {
  const { config } = deps;
  const cognitoClient =
    deps.cognitoClient ??
    new CognitoIdentityProviderClient({ region: config.region });

  const credentialStore = createCredentialStore();

  const apiClient: ApiClient = createApiClient({
    apiGatewayUrl: config.apiGatewayUrl,
    credentialStore,
    cognitoClient,
    cognitoClientId: config.cognitoClientId,
  });

  let activeAuthServer: LocalAuthServer | null = null;

  const server = new McpServer({
    name: 'notlai-mcp',
    version: '1.7.0',
  });

  // ─── Register Tool ─────────────────────────────────────────────────
  server.tool(
    'notlai_register',
    'Create a new Notlai account with email and password',
    {
      email: z.string().describe('Your email address'),
      password: z.string().describe('Your password (minimum 8 characters)'),
    },
    async ({ email, password }) => {
      if (!validateEmail(email)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid email format. Please provide a valid email address (e.g., user@example.com).',
            },
          ],
          isError: true,
        };
      }

      const pwResult = validatePassword(password);
      if (!pwResult.valid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${pwResult.error!.message}\n\nWhat to do: ${pwResult.error!.remedy}`,
            },
          ],
          isError: true,
        };
      }

      try {
        await cognitoClient.send(
          new SignUpCommand({
            ClientId: config.cognitoClientId,
            Username: email,
            Password: password,
            UserAttributes: [{ Name: 'email', Value: email }],
          }),
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Account created! Check your email for a verification code, then confirm your account at https://www.notlai.com/signup',
            },
          ],
        };
      } catch (error) {
        const mapped = mapCognitoError(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Registration error: ${mapped.message}\n\nWhat to do: ${mapped.remedy}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Login Tool ────────────────────────────────────────────────────
  server.tool(
    'notlai_login',
    'Authenticate with email and password to obtain access tokens',
    {
      email: z.string().describe('Your email address'),
      password: z.string().describe('Your password'),
    },
    async ({ email, password }) => {
      if (!validateEmail(email)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Invalid email format. Please provide a valid email address.',
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await cognitoClient.send(
          new InitiateAuthCommand({
            ClientId: config.cognitoClientId,
            AuthFlow: 'USER_PASSWORD_AUTH',
            AuthParameters: {
              USERNAME: email,
              PASSWORD: password,
            },
          }),
        );

        const auth = result.AuthenticationResult;
        if (!auth?.IdToken || !auth?.RefreshToken || !auth?.AccessToken) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Authentication succeeded but tokens were not returned. Please try again.',
              },
            ],
            isError: true,
          };
        }

        await credentialStore.save({
          idToken: auth.IdToken,
          refreshToken: auth.RefreshToken,
          accessToken: auth.AccessToken,
          expiresAt: Math.floor(Date.now() / 1000) + (auth.ExpiresIn ?? 3600),
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: 'Authenticated successfully. Your session is stored locally.',
            },
          ],
        };
      } catch (error) {
        const mapped = mapCognitoError(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Login error: ${mapped.message}\n\nWhat to do: ${mapped.remedy}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Web Login Tool ────────────────────────────────────────────────
  server.tool(
    'notlai_web_login',
    'Start web-based login flow. Opens a local auth server and provides a URL to authenticate via the web.',
    {
      port: z.number().optional().describe('Local server port (default: 9876)'),
    },
    async ({ port: requestedPort }) => {
      const authPort = requestedPort ?? 9876;

      if (activeAuthServer) {
        try {
          await activeAuthServer.stop();
        } catch {
          // ignore cleanup errors
        }
        activeAuthServer = null;
      }

      try {
        activeAuthServer = createLocalAuthServer({
          port: authPort,
          credentialStore,
          onSuccess: () => {
            activeAuthServer = null;
          },
          onError: () => {
            activeAuthServer = null;
          },
          timeout: 300_000,
        });

        await activeAuthServer.start();

        const loginUrl = `${config.frontendUrl}/login?port=${authPort}`;

        return {
          content: [
            {
              type: 'text' as const,
              text: `Web login server started! Please visit:\n\n${loginUrl}\n\nThe server will wait for up to 5 minutes. After logging in on the web page, your session will be stored automatically.`,
            },
          ],
        };
      } catch (err) {
        activeAuthServer = null;
        const message =
          err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
            ? `Port ${authPort} is already in use. Try a different port.`
            : `Failed to start auth server: ${err instanceof Error ? err.message : String(err)}`;

        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  );

  // ─── Logout Tool ───────────────────────────────────────────────────
  server.tool(
    'notlai_logout',
    'Delete local credentials and end the session',
    {},
    async () => {
      await credentialStore.delete();
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Logged out successfully. Local credentials have been deleted.',
          },
        ],
      };
    },
  );

  // ─── Status Tool ───────────────────────────────────────────────────
  server.tool(
    'notlai_status',
    'Check authentication status and refresh token if needed',
    {},
    async () => {
      const tokens = await credentialStore.load();
      if (!tokens) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Not authenticated. Use notlai_web_login or notlai_login to sign in.',
            },
          ],
          isError: true,
        };
      }

      try {
        const refreshed = await refreshTokenIfNeeded(
          credentialStore,
          cognitoClient,
          config.cognitoClientId,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: refreshed
                ? 'Authenticated (token was refreshed).'
                : 'Authenticated (session is valid).',
            },
          ],
        };
      } catch {
        const err = tokenExpiredError();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Session expired. ${err.remedy}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── List Notes Tool ────────────────────────────────────────────────
  server.tool(
    'notlai_list_notes',
    'List your notes. Supports filtering by tags, date range, text search, and favorites. Returns the most recently updated notes first.',
    {
      tags: z.array(z.string()).optional().describe('Filter by tag names (notes with at least one matching tag)'),
      search: z.string().optional().describe('Search text in title and content'),
      from: z.string().optional().describe('Start date filter (ISO format, e.g. "2025-01-01")'),
      to: z.string().optional().describe('End date filter (ISO format, e.g. "2025-12-31")'),
      favorites: z.boolean().optional().describe('If true, only return favorite notes'),
      folderId: z.string().optional().describe('Filter by folder ID. Use "root" to list notes not in any folder.'),
      scope: z.enum(['own', 'shared', 'all']).optional().describe('Which notes to list: "own" (default), "shared" (notes shared with you), or "all" (both)'),
      limit: z.number().optional().describe('Max number of notes to return (default: 20)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
    async ({ tags, search, from, to, favorites, folderId, scope, limit, cursor }) => {
      try {
        const params = new URLSearchParams();
        if (tags && tags.length > 0) params.set('tags', tags.join(','));
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        if (favorites) params.set('favorites', 'true');
        if (folderId) params.set('folderId', folderId);
        if (scope && scope !== 'own') params.set('scope', scope);
        if (limit) params.set('limit', String(limit));
        if (cursor) params.set('cursor', cursor);

        const query = params.toString();
        const path = query ? `/notes?${query}` : '/notes';
        const result = await apiClient.get<NotesListResponse>(path);

        if (result.notes.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No notes found matching your criteria.',
            }],
          };
        }

        const notesList = result.notes.map((n) => {
          const tags = n.tags.length > 0 ? ` [${n.tags.join(', ')}]` : '';
          const fav = n.isFavorite ? ' ★' : '';
          const shared = n.isShared ? ' 🔗' : '';
          const perm = n.permission ? ` (${n.permission})` : '';
          const folder = n.folderId ? ` 📁` : '';
          const date = new Date(n.updatedAt).toLocaleDateString('en-US');
          return `• ${n.title}${fav}${shared}${folder}${perm}${tags} (${date}) — id: ${n.noteId}`;
        }).join('\n');

        let text = `Notes (${result.notes.length}):\n${notesList}`;
        if (result.nextCursor) {
          text += `\n\n(More notes available — use cursor: "${result.nextCursor}" to load next page)`;
        }

        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error listing notes: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Get Note Tool ─────────────────────────────────────────────────
  server.tool(
    'notlai_get_note',
    'Get the full content of a specific note by its ID.',
    {
      noteId: z.string().describe('The note ID (ULID format, from notlai_list_notes)'),
    },
    async ({ noteId }) => {
      try {
        const note = await apiClient.get<Note>(`/notes/${encodeURIComponent(noteId)}`);
        const tags = note.tags.length > 0 ? `Tags: ${note.tags.join(', ')}\n` : '';
        const text = `# ${note.title}\n\n${tags}Created: ${new Date(note.createdAt).toLocaleString()}\nUpdated: ${new Date(note.updatedAt).toLocaleString()}\n\n${note.content}`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error getting note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Create Note Tool ──────────────────────────────────────────────
  server.tool(
    'notlai_create_note',
    'Create a new note. Content supports Markdown formatting (headings, lists, code blocks, links, bold, italic, etc.). Before creating, consider using notlai_list_tags to find relevant tags to assign.',
    {
      title: z.string().min(1).describe('Note title'),
      content: z.string().min(1).describe('Note content in Markdown format. Supports headings (#), bold (**), italic (*), lists (- or 1.), code blocks (```), links ([text](url)), blockquotes (>), and tables.'),
      tags: z.array(z.string()).optional().describe('Tag names to assign (must exist — use notlai_list_tags to check, or notlai_create_tag to create new ones)'),
      isFavorite: z.boolean().optional().describe('Mark as favorite (default: false)'),
    },
    async ({ title, content, tags, isFavorite }) => {
      try {
        const body: { title: string; content: string; tags?: string[]; isFavorite?: boolean } = { title, content };
        if (tags && tags.length > 0) body.tags = tags;
        if (isFavorite) body.isFavorite = true;

        const result = await apiClient.post<Note>('/notes', body);
        const tagInfo = result.tags.length > 0 ? ` with tags [${result.tags.join(', ')}]` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Note created successfully${tagInfo}.\n\nID: ${result.noteId}\nTitle: ${result.title}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error creating note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Update Note Tool ──────────────────────────────────────────────
  server.tool(
    'notlai_update_note',
    'Update an existing note. Only provided fields will be changed. Content supports Markdown formatting. Use notlai_list_notes to find the note ID.',
    {
      noteId: z.string().describe('The note ID to update (ULID format)'),
      title: z.string().optional().describe('New title (omit to keep current)'),
      content: z.string().optional().describe('New content in Markdown format (omit to keep current). Supports headings, bold, italic, lists, code blocks, links, blockquotes, and tables.'),
      tags: z.array(z.string()).optional().describe('New tags to assign (replaces all current tags). Pass [] to remove all tags. Omit to keep current tags.'),
      folderId: z.string().nullable().optional().describe('Move to a folder by ID, or pass null to move back to root. Omit to keep current folder.'),
      isFavorite: z.boolean().optional().describe('Set favorite status. Omit to keep current.'),
    },
    async ({ noteId, title, content, tags, folderId, isFavorite }) => {
      try {
        const body: { title?: string; content?: string; tags?: string[]; folderId?: string | null; isFavorite?: boolean } = {};
        if (title !== undefined) body.title = title;
        if (content !== undefined) body.content = content;
        if (tags !== undefined) body.tags = tags;
        if (folderId !== undefined) body.folderId = folderId;
        if (isFavorite !== undefined) body.isFavorite = isFavorite;

        const result = await apiClient.put<Note>(`/notes/${encodeURIComponent(noteId)}`, body);
        return {
          content: [{
            type: 'text' as const,
            text: `Note updated successfully.\n\nTitle: ${result.title}\nTags: ${result.tags.length > 0 ? result.tags.join(', ') : '(none)'}`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error updating note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Delete Note Tool ──────────────────────────────────────────────
  server.tool(
    'notlai_delete_note',
    'Permanently delete a note by its ID. This cannot be undone.',
    {
      noteId: z.string().describe('The note ID to delete (ULID format)'),
    },
    async ({ noteId }) => {
      try {
        await apiClient.del(`/notes/${encodeURIComponent(noteId)}`);
        return {
          content: [{ type: 'text' as const, text: 'Note deleted successfully.' }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error deleting note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── List Tags Tool ────────────────────────────────────────────────
  server.tool(
    'notlai_list_tags',
    'List all your existing tags with their IDs. Use this before creating or updating a note to find relevant tags to assign. When creating a note, pass existing tag names in the tags field.',
    {},
    async () => {
      try {
        const result = await apiClient.get<TagsResponse>('/tags');
        const tags = result.tags;

        if (tags.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No tags created yet. Use notlai_create_tag to create your first tag.',
              },
            ],
          };
        }

        const tagList = tags
          .map((t) => `• ${t.name} (id: ${t.tagId})`)
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Your tags (${tags.length}):\n${tagList}\n\nUse tag names (not IDs) when assigning tags to notes.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing tags: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Create Tag Tool ───────────────────────────────────────────────
  server.tool(
    'notlai_create_tag',
    'Create a new tag for categorizing notes. Check existing tags first with notlai_list_tags to avoid duplicates. Tag names are stored in lowercase.',
    {
      name: z
        .string()
        .min(1)
        .max(50)
        .describe('Tag name (e.g., "work", "ideas", "project-x"). Will be stored in lowercase.'),
    },
    async ({ name }) => {
      try {
        const result = await apiClient.post<Tag>('/tags', { name });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Tag "${result.name}" created successfully (ID: ${result.tagId}). You can now use "${result.name}" when creating or updating notes.`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating tag: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Delete Tag Tool ───────────────────────────────────────────────
  server.tool(
    'notlai_delete_tag',
    'Delete a tag by its ID. This also removes the tag from all notes that use it. Use notlai_list_tags to see available tags and their IDs.',
    {
      tagId: z.string().describe('The tag ID to delete (ULID format, get from notlai_list_tags)'),
    },
    async ({ tagId }) => {
      try {
        await apiClient.del(`/tags/${encodeURIComponent(tagId)}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Tag deleted successfully. It has been removed from all notes that used it.',
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error deleting tag: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── List Folders Tool ──────────────────────────────────────────────
  server.tool(
    'notlai_list_folders',
    'List all your folders. Use folder IDs to filter notes by folder or to move notes into a folder.',
    {},
    async () => {
      try {
        const result = await apiClient.get<FoldersResponse>('/folders');
        const folders = result.folders;

        if (folders.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'No folders created yet. Use notlai_create_folder to create your first folder.',
              },
            ],
          };
        }

        const folderList = folders
          .map((f) => `• 📁 ${f.name} (id: ${f.folderId})`)
          .join('\n');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Your folders (${folders.length}):\n${folderList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing folders: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Create Folder Tool ────────────────────────────────────────────
  server.tool(
    'notlai_create_folder',
    'Create a new folder to organize your notes. After creating a folder, use notlai_move_note to move notes into it.',
    {
      name: z
        .string()
        .min(1)
        .max(100)
        .describe('Folder name (e.g., "Work", "Personal", "Projects")'),
    },
    async ({ name }) => {
      try {
        const result = await apiClient.post<Folder>('/folders', { name });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Folder "${result.name}" created successfully (ID: ${result.folderId}). You can now move notes into it with notlai_move_note.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Delete Folder Tool ────────────────────────────────────────────
  server.tool(
    'notlai_delete_folder',
    'Delete a folder by its ID. Notes inside the folder are moved back to the root (they are not deleted). Use notlai_list_folders to see folder IDs.',
    {
      folderId: z.string().describe('The folder ID to delete (ULID format, get from notlai_list_folders)'),
    },
    async ({ folderId }) => {
      try {
        await apiClient.del(`/folders/${encodeURIComponent(folderId)}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Folder deleted successfully. Notes that were inside have been moved to root.',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error deleting folder: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Move Note Tool ────────────────────────────────────────────────
  server.tool(
    'notlai_move_note',
    'Move a note into a folder, or back to root. Use this to reclassify and organize your notes. Use notlai_list_folders to find folder IDs.',
    {
      noteId: z.string().describe('The note ID to move (ULID format)'),
      folderId: z.string().nullable().describe('Target folder ID to move the note into, or null to move back to root (no folder)'),
    },
    async ({ noteId, folderId }) => {
      try {
        const result = await apiClient.put<Note>(`/notes/${encodeURIComponent(noteId)}`, { folderId });
        const destination = folderId ? `folder ${folderId}` : 'root (no folder)';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Note "${result.title}" moved to ${destination}.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error moving note: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Bulk Delete Notes Tool ────────────────────────────────────────
  server.tool(
    'notlai_bulk_delete_notes',
    'Permanently delete multiple notes at once. This cannot be undone. Use notlai_list_notes to find note IDs.',
    {
      noteIds: z.array(z.string()).min(1).max(50).describe('Array of note IDs to delete (ULID format, max 50 at a time)'),
    },
    async ({ noteIds }) => {
      try {
        await apiClient.post<void>('/notes/bulk-delete', { noteIds });
        return {
          content: [
            {
              type: 'text' as const,
              text: `${noteIds.length} note(s) deleted successfully.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error deleting notes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ─── Share Note Tool ───────────────────────────────────────────────
  server.tool(
    'notlai_share_note',
    'Share a note. Without email: creates a public link (read-only). With email: shares with a specific user at the given permission level.',
    {
      noteId: z.string().describe('The note ID to share'),
      email: z.string().optional().describe('Recipient email. If omitted, creates a public link.'),
      permission: z.enum(['read', 'write']).optional().describe('Permission level for user shares (default: "read"). Ignored for public links.'),
    },
    async ({ noteId, email, permission }) => {
      try {
        const body: { type: string; email?: string; permission?: string } = email
          ? { type: 'user', email, permission: permission ?? 'read' }
          : { type: 'public' };

        const result = await apiClient.post<ShareResponse>(`/notes/${encodeURIComponent(noteId)}/share`, body);

        if (result.type === 'public') {
          return {
            content: [{
              type: 'text' as const,
              text: `Public share link created:\n\n${result.shareUrl}\n\nAnyone with this link can read the note.`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Note shared with ${result.email} (${result.permission} access).`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error sharing note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Unshare Note Tool ─────────────────────────────────────────────
  server.tool(
    'notlai_unshare_note',
    'Revoke a share. Without email: revokes the public link. With email: revokes access for that specific user.',
    {
      noteId: z.string().describe('The note ID to unshare'),
      email: z.string().optional().describe('Recipient email to revoke. If omitted, revokes the public link.'),
    },
    async ({ noteId, email }) => {
      try {
        const query = email
          ? `?email=${encodeURIComponent(email)}`
          : '?type=public';

        await apiClient.del(`/notes/${encodeURIComponent(noteId)}/share${query}`);

        const target = email ? `access for ${email}` : 'the public link';
        return {
          content: [{
            type: 'text' as const,
            text: `Share revoked: ${target} has been removed.`,
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: `Error unsharing note: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
