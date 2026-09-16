import type {
  CaseNextAction,
  CaseProgress,
  CaseRequestView,
  CaseRiskLevel,
  CaseStepView,
  CaseTimelineEntry,
  CaseWorkItemView,
} from './case-model';

/**
 * Contract of the Expediente 360 between its server loader
 * (`src/app/app/operations/_case-data.ts`) and the client components. Types
 * only: everything is already serialized (ISO instants, decimals as strings)
 * and every label comes from the domain modules, never re-worded here.
 */

export interface CaseHeaderView {
  id: string;
  caseNumber: string;
  status: string;
  statusLabel: string;
  phase: string;
  phaseLabel: string;
  priority: string;
  priorityLabel: string;
  customerName: string | null;
  salesOrderNumber: string | null;
  zohoSalesOrderId: string | null;
  /** Detail of the Zoho order, or null when the person may not open it. */
  salesOrderHref: string | null;
  salesOrderStatus: string | null;
  locationName: string | null;
  deliveryMethod: string | null;
  promisedAt: string | null;
  openedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
  cancelledAt: string | null;
  closeReason: string | null;
  ownerUserId: string;
  ownerName: string | null;
  /** `sales_fulfillment@1`. */
  process: string;
  /** Case room in the internal chat, or null when there is none (or no access). */
  chatHref: string | null;
  risk: CaseRiskLevel;
  version: number;
}

export interface CaseAllocationView {
  id: string;
  source: string;
  sourceLabel: string;
  quantity: string;
  status: string;
  statusLabel: string;
  expectedAt: string | null;
  deliveredQuantity: string;
  warehouseName: string | null;
  /** What covers it: a purchase request, a production order… */
  linkedLabel: string | null;
}

export interface CaseDemandConfidence {
  level: string;
  label: string;
  lastCountAt: string | null;
}

export interface CaseDemandView {
  id: string;
  lineRef: string;
  name: string;
  sku: string | null;
  quantity: string;
  unit: string;
  baseQuantity: string;
  baseUnit: string;
  fulfilledQuantity: string;
  status: string;
  statusLabel: string;
  /** Inventory confidence of the product (only with `inventory.view`). */
  confidence: CaseDemandConfidence | null;
  allocations: CaseAllocationView[];
}

export interface CaseIncidentView {
  id: string;
  kind: string;
  kindLabel: string;
  severity: string;
  severityLabel: string;
  status: string;
  statusLabel: string;
  title: string;
  areaLabel: string;
  ownerName: string | null;
  openedAt: string;
  open: boolean;
}

export interface CaseTripView {
  id: string;
  number: string;
  status: string;
  statusLabel: string;
  date: string;
  vehicleLabel: string | null;
  driverName: string | null;
}

export interface CaseDeliveryOrderView {
  id: string;
  status: string;
  statusLabel: string;
  mode: string;
  modeLabel: string;
  zohoSyncState: string;
  zohoSyncLabel: string;
  /** The write to Zoho needs a person: conflict or failed read-back. */
  zohoNeedsAttention: boolean;
  plannedDate: string | null;
  deliveredAt: string | null;
  carrier: string | null;
  addressLine: string | null;
  contactName: string | null;
  packageNumber: string | null;
  /** Local package detail, or null without `packages.view`. */
  packageHref: string | null;
  trip: CaseTripView | null;
}

export interface CaseEvidenceView {
  id: string;
  kindLabel: string;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  fileName: string | null;
  /** Authenticated stream of the file (evidence uploads are restricted). */
  fileUrl: string | null;
}

export interface CaseViewData {
  header: CaseHeaderView;
  progress: CaseProgress;
  next: CaseNextAction;
  steps: CaseStepView[];
  workItems: CaseWorkItemView[];
  requests: CaseRequestView[];
  incidents: CaseIncidentView[];
  demands: CaseDemandView[];
  delivery: CaseDeliveryOrderView[];
  evidence: CaseEvidenceView[];
  timeline: CaseTimelineEntry[];
  /** Cursor for older timeline pages, or null when it reached the start. */
  timelineCursor: string | null;
  /** Last real activity of the case (drives the copilot re-analysis). */
  activityAt: string | null;
  /** Blocks that could not be loaded, shown as notices instead of breaking the page. */
  warnings: string[];
}
