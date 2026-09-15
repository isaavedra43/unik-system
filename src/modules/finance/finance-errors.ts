import { OperationsError, type OperationsErrorCode } from '@/modules/operations/errors';
import { FINANCE_ERROR_HTTP_STATUS, type FinanceErrorCode } from './types';

/**
 * Finance rejections are `OperationsError`s (the command engine turns them
 * into `rejected` results with the same code). Finance-specific codes carry
 * their HTTP status from `FINANCE_ERROR_HTTP_STATUS`; core codes keep the
 * core mapping. Pure (errors.ts has no imports).
 */
export function financeError(
  code: FinanceErrorCode | OperationsErrorCode,
  message: string,
  details?: Record<string, unknown>
): OperationsError {
  const httpStatus = (FINANCE_ERROR_HTTP_STATUS as Record<string, number>)[code];
  return new OperationsError(code, message, {
    ...(httpStatus ? { httpStatus } : {}),
    ...(details ? { details } : {}),
  });
}
