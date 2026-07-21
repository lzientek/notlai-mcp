import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { CredentialStore } from '../storage/credentials.js';
import { mapCognitoError } from '../errors/mapper.js';

export async function refreshTokenIfNeeded(
  store: CredentialStore,
  cognitoClient: CognitoIdentityProviderClient,
  clientId: string,
): Promise<boolean> {
  const tokens = await store.load();
  if (!tokens) {
    throw new Error('No credentials found');
  }

  if (!store.isExpired(tokens)) {
    return false;
  }

  try {
    const result = await cognitoClient.send(
      new InitiateAuthCommand({
        ClientId: clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: {
          REFRESH_TOKEN: tokens.refreshToken,
        },
      }),
    );

    const auth = result.AuthenticationResult;
    if (!auth?.IdToken || !auth?.AccessToken) {
      throw new Error('Refresh succeeded but new tokens were not returned');
    }

    await store.save({
      idToken: auth.IdToken,
      accessToken: auth.AccessToken,
      refreshToken: auth.RefreshToken ?? tokens.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (auth.ExpiresIn ?? 3600),
    });

    return true;
  } catch (error) {
    const mapped = mapCognitoError(error);
    throw mapped;
  }
}
