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
    version: '1.1.0',
  });

  // ─── Register Tool ─────────────────────────────────────────────────
  server.tool(
    'mcp_notes_register',
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
              text: 'Account created! Check your email for a verification code, then confirm your account at https://www.notlai.com',
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
    'mcp_notes_login',
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
    'mcp_notes_web_login',
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

        const loginUrl = `${config.frontendUrl}?action=login&port=${authPort}`;

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
    'mcp_notes_logout',
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
    'mcp_notes_status',
    'Check authentication status and refresh token if needed',
    {},
    async () => {
      const tokens = await credentialStore.load();
      if (!tokens) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Not authenticated. Use mcp_notes_web_login or mcp_notes_login to sign in.',
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

  // ─── List Tags Tool ────────────────────────────────────────────────
  server.tool(
    'mcp_notes_list_tags',
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
                text: 'No tags created yet. Use mcp_notes_create_tag to create your first tag.',
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
    'mcp_notes_create_tag',
    'Create a new tag for categorizing notes. Check existing tags first with mcp_notes_list_tags to avoid duplicates. Tag names are stored in lowercase.',
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
    'mcp_notes_delete_tag',
    'Delete a tag by its ID. This also removes the tag from all notes that use it. Use mcp_notes_list_tags to see available tags and their IDs.',
    {
      tagId: z.string().describe('The tag ID to delete (ULID format, get from mcp_notes_list_tags)'),
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
