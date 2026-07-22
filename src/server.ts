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

interface Note {
  noteId: string;
  userId: string;
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface NotesListResponse {
  notes: Note[];
  nextCursor: string | null;
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
    version: '1.3.0',
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
    'notlai_list',
    'List your notes. Supports filtering by tags, date range, and text search. Returns the most recently updated notes first.',
    {
      tags: z.array(z.string()).optional().describe('Filter by tag names (notes with at least one matching tag)'),
      search: z.string().optional().describe('Search text in title and content'),
      from: z.string().optional().describe('Start date filter (ISO format, e.g. "2025-01-01")'),
      to: z.string().optional().describe('End date filter (ISO format, e.g. "2025-12-31")'),
      limit: z.number().optional().describe('Max number of notes to return (default: 20)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
    async ({ tags, search, from, to, limit, cursor }) => {
      try {
        const params = new URLSearchParams();
        if (tags && tags.length > 0) params.set('tags', tags.join(','));
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to);
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
          const date = new Date(n.updatedAt).toLocaleDateString('en-US');
          return `• ${n.title}${tags} (${date}) — id: ${n.noteId}`;
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
    'notlai_get',
    'Get the full content of a specific note by its ID.',
    {
      noteId: z.string().describe('The note ID (ULID format, from notlai_list)'),
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
    'notlai_create',
    'Create a new note. Before creating, consider using notlai_list_tags to find relevant tags to assign.',
    {
      title: z.string().min(1).describe('Note title'),
      content: z.string().min(1).describe('Note content (plain text, supports newlines)'),
      tags: z.array(z.string()).optional().describe('Tag names to assign (must exist — use notlai_list_tags to check, or notlai_create_tag to create new ones)'),
    },
    async ({ title, content, tags }) => {
      try {
        const body: { title: string; content: string; tags?: string[] } = { title, content };
        if (tags && tags.length > 0) body.tags = tags;

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
    'notlai_update',
    'Update an existing note. Only provided fields will be changed. Use notlai_list to find the note ID.',
    {
      noteId: z.string().describe('The note ID to update (ULID format)'),
      title: z.string().optional().describe('New title (omit to keep current)'),
      content: z.string().optional().describe('New content (omit to keep current)'),
      tags: z.array(z.string()).optional().describe('New tags to assign (replaces all current tags). Pass [] to remove all tags. Omit to keep current tags.'),
    },
    async ({ noteId, title, content, tags }) => {
      try {
        const body: { title?: string; content?: string; tags?: string[] } = {};
        if (title !== undefined) body.title = title;
        if (content !== undefined) body.content = content;
        if (tags !== undefined) body.tags = tags;

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
    'notlai_delete',
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

  return server;
}
