import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CognitoTokens } from '../types/auth.js';

export interface CredentialStore {
  save(tokens: CognitoTokens): Promise<void>;
  load(): Promise<CognitoTokens | null>;
  delete(): Promise<void>;
  getPath(): string;
  isExpired(tokens: CognitoTokens): boolean;
}

export interface CredentialStoreOptions {
  filePath?: string;
  now?: () => number;
}

export function createCredentialStore(options?: CredentialStoreOptions): CredentialStore {
  const credentialsPath =
    options?.filePath ??
    path.join(os.homedir(), '.mcp-notes', 'credentials.json');

  const getNow = options?.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async save(tokens: CognitoTokens): Promise<void> {
      const dir = path.dirname(credentialsPath);
      await fs.mkdir(dir, { recursive: true });

      const data = JSON.stringify(
        { ...tokens, savedAt: new Date().toISOString() },
        null,
        2,
      );

      await fs.writeFile(credentialsPath, data, { mode: 0o600 });
    },

    async load(): Promise<CognitoTokens | null> {
      try {
        const content = await fs.readFile(credentialsPath, 'utf-8');
        const parsed = JSON.parse(content);

        if (
          typeof parsed.idToken !== 'string' ||
          typeof parsed.refreshToken !== 'string' ||
          typeof parsed.accessToken !== 'string' ||
          typeof parsed.expiresAt !== 'number'
        ) {
          return null;
        }

        return {
          idToken: parsed.idToken,
          refreshToken: parsed.refreshToken,
          accessToken: parsed.accessToken,
          expiresAt: parsed.expiresAt,
        };
      } catch {
        return null;
      }
    },

    async delete(): Promise<void> {
      try {
        await fs.unlink(credentialsPath);
      } catch {
        // File already doesn't exist
      }
    },

    getPath(): string {
      return credentialsPath;
    },

    isExpired(tokens: CognitoTokens): boolean {
      return tokens.expiresAt < getNow();
    },
  };
}
