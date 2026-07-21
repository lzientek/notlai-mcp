import type { AuthErrorResponse } from '../types/auth.js';

export interface PasswordValidationResult {
  valid: boolean;
  error?: AuthErrorResponse;
}

export function validatePassword(input: string): PasswordValidationResult {
  if (!input || input.length < 8) {
    return {
      valid: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Password does not meet requirements.',
        remedy: 'Password must be at least 8 characters long.',
      },
    };
  }

  return { valid: true };
}
