export interface CognitoTokens {
  idToken: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
}

export interface AuthErrorResponse {
  code: string;
  message: string;
  remedy: string;
}
