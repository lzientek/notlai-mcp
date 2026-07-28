import type { CredentialStore } from '../storage/credentials.js';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { refreshTokenIfNeeded } from '../auth/refresh.js';
import type { DebugLogger } from '../debug/logger.js';

export interface ApiClientDeps {
  apiGatewayUrl: string;
  credentialStore: CredentialStore;
  cognitoClient: CognitoIdentityProviderClient;
  cognitoClientId: string;
  logger: DebugLogger;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  del(path: string): Promise<void>;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const { apiGatewayUrl, credentialStore, cognitoClient, cognitoClientId, logger } = deps;

  async function getValidToken(): Promise<string> {
    const tokens = await credentialStore.load();
    if (!tokens) {
      throw new Error('Not authenticated. Use notlai_web_login or notlai_login first.');
    }

    try {
      await refreshTokenIfNeeded(credentialStore, cognitoClient, cognitoClientId);
      logger.logTokenRefresh(true);
    } catch (err) {
      logger.logTokenRefresh(false, err);
      throw err;
    }

    // Re-load after potential refresh
    const refreshed = await credentialStore.load();
    return refreshed!.idToken;
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await getValidToken();
    const url = `${apiGatewayUrl}${path}`;

    logger.logRequest(method, path, body);

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    if (res.status === 204) {
      logger.logResponse(method, path, 204);
      return undefined as T;
    }

    const responseBody = await res.text();

    if (!res.ok) {
      let errorMessage = `API error ${res.status}`;
      try {
        const parsed = JSON.parse(responseBody);
        errorMessage = parsed.message || parsed.code || errorMessage;
      } catch {
        if (responseBody) errorMessage = responseBody;
      }
      logger.logResponse(method, path, res.status, errorMessage);
      throw new Error(errorMessage);
    }

    const parsed = JSON.parse(responseBody) as T;
    logger.logResponse(method, path, res.status, parsed);
    return parsed;
  }

  return {
    get<T>(path: string): Promise<T> {
      return request<T>('GET', path);
    },
    post<T>(path: string, body: unknown): Promise<T> {
      return request<T>('POST', path, body);
    },
    put<T>(path: string, body: unknown): Promise<T> {
      return request<T>('PUT', path, body);
    },
    async del(path: string): Promise<void> {
      await request<void>('DELETE', path);
    },
  };
}
