import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '@/modules/auth/constants';

const BCRYPT_COST = 12;

/**
 * Password policy: long passwords, no arbitrary character-class rules.
 * The hard upper bound is in UTF-8 bytes because bcrypt only processes
 * ~72 bytes.
 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`)
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES,
    `La contraseña no puede exceder ${PASSWORD_MAX_BYTES} bytes UTF-8 (aproximadamente 72 caracteres ASCII)`
  );

/** Hashes a plaintext password with bcrypt. Never log the inputs or output. */
export async function hashPassword(plainPassword: string): Promise<string> {
  return bcrypt.hash(plainPassword, BCRYPT_COST);
}

/** Verifies a plaintext password against a stored bcrypt hash.
 * bcrypt only processes ~72 bytes, so any longer input is rejected outright
 * instead of being silently truncated.
 */
export async function verifyPassword(
  plainPassword: string,
  passwordHash: string
): Promise<boolean> {
  if (Buffer.byteLength(plainPassword, 'utf8') > PASSWORD_MAX_BYTES) {
    return false;
  }
  return bcrypt.compare(plainPassword, passwordHash);
}

/**
 * Generates a secure temporary password (~24 chars base64url).
 * The plaintext is shown to the administrator exactly once and never stored.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}
