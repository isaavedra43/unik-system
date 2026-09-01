import { z } from 'zod';

/** Valid username characters: a-z, 0-9, ., _, -. No '@'. */
const USERNAME_CHARACTERS = /^[a-z0-9._-]+$/;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 50;

/** Normalizes a username: trim + lowercase. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function isEmailLike(identifier: string): boolean {
  return identifier.includes('@');
}

/**
 * Username schema. It normalizes the input (trim + lowercase) before applying
 * validation, so 'Israel' becomes 'israel' and passes. The database always
 * stores the lowercased value.
 */
export const usernameSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeUsername(value) : value),
  z
    .string()
    .min(USERNAME_MIN_LENGTH, `El usuario debe tener al menos ${USERNAME_MIN_LENGTH} caracteres`)
    .max(USERNAME_MAX_LENGTH, `El usuario no puede exceder ${USERNAME_MAX_LENGTH} caracteres`)
    .regex(
      USERNAME_CHARACTERS,
      'El usuario solo puede contener minúsculas, números, punto, guion y guion bajo; sin @'
    )
);
