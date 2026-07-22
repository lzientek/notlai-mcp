import {
  UsernameExistsException,
  NotAuthorizedException,
  UserNotFoundException,
  TooManyRequestsException,
  InvalidPasswordException,
  InvalidParameterException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { AuthErrorResponse } from '../types/auth.js';

export function mapCognitoError(error: unknown): AuthErrorResponse {
  if (error instanceof UsernameExistsException) {
    return {
      code: 'EMAIL_ALREADY_EXISTS',
      message: 'An account with this email already exists.',
      remedy: 'Use the login command with your existing credentials, or use a different email.',
    };
  }

  if (error instanceof NotAuthorizedException) {
    const message = (error as { message?: string }).message ?? '';
    if (message.toLowerCase().includes('refresh token')) {
      return {
        code: 'AUTH_TOKEN_EXPIRED',
        message: 'Your session has expired.',
        remedy: 'Run the login command to re-authenticate with your email and password.',
      };
    }
    return {
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
      remedy: 'Check your email and password and try again.',
    };
  }

  if (error instanceof UserNotFoundException) {
    return {
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
      remedy: 'Check your email and password and try again.',
    };
  }

  if (error instanceof TooManyRequestsException) {
    return {
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many authentication attempts. Please wait before trying again.',
      remedy: 'Wait a few minutes before attempting to log in again.',
    };
  }

  if (error instanceof InvalidPasswordException) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Password does not meet requirements.',
      remedy: 'Password must be at least 8 characters long.',
    };
  }

  if (error instanceof InvalidParameterException) {
    return {
      code: 'VALIDATION_ERROR',
      message: 'Invalid input provided.',
      remedy: 'Check that your email is valid and your password meets the minimum requirements.',
    };
  }

  return {
    code: 'SERVICE_UNAVAILABLE',
    message: 'An unexpected error occurred while communicating with the authentication service.',
    remedy: 'Please try again in a few moments. If the problem persists, check your network connection.',
  };
}

export function authRequiredError(): AuthErrorResponse {
  return {
    code: 'AUTH_REQUIRED',
    message: 'Authentication is required to perform this action.',
    remedy: 'Run notlai_web_login or notlai_login to authenticate.',
  };
}

export function tokenExpiredError(): AuthErrorResponse {
  return {
    code: 'AUTH_TOKEN_EXPIRED',
    message: 'Your session has expired.',
    remedy: 'Run notlai_web_login or notlai_login to re-authenticate.',
  };
}
