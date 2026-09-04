export interface SyncFormState {
  error: string | null;
  success: boolean;
}

export interface SyncStatusResult {
  id: string | null;
  status: SyncStatus | null;
  completedAt: string | null;
  detailsFetched: number;
  detailsFailed: number;
}

export enum SyncStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}
