export interface TokenCallbackPayload {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type ValidationResult =
  | { valid: true; tokens: TokenCallbackPayload }
  | { valid: false; error: string };

export function validateTokenPayload(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const obj = body as Record<string, unknown>;

  const requiredStrings = ['idToken', 'accessToken', 'refreshToken'] as const;

  for (const field of requiredStrings) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
      return { valid: false, error: `Field '${field}' must be a non-empty string` };
    }
  }

  if (typeof obj.expiresIn !== 'number' || obj.expiresIn <= 0) {
    return { valid: false, error: "Field 'expiresIn' must be a positive number" };
  }

  return {
    valid: true,
    tokens: {
      idToken: obj.idToken as string,
      accessToken: obj.accessToken as string,
      refreshToken: obj.refreshToken as string,
      expiresIn: obj.expiresIn as number,
    },
  };
}
