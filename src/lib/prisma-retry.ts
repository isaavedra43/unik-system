import { Prisma, PrismaClient } from '@prisma/client';

type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

const MAX_SERIALIZABLE_RETRIES = 3;

/**
 * Runs a callback inside a SERIALIZABLE Prisma transaction and retries on
 * P2034 (write conflict / deadlock) up to 3 times. Other errors are thrown
 * immediately. The callback must re-read any guard conditions (counts, etc.)
 * inside each attempt to keep invariants correct.
 */
export async function runSerializableWithRetry<T>(
  prismaClient: PrismaClient,
  callback: (tx: PrismaTransactionClient) => Promise<T>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_RETRIES; attempt++) {
    try {
      return await prismaClient.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      lastError = error;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < MAX_SERIALIZABLE_RETRIES
      ) {
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
