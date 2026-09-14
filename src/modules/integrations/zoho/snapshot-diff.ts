/**
 * Payload comparison for LIST-as-snapshot sync. Pure.
 *
 * Zoho does not bump a record's last_modified_time for every visible change — e.g. a vendor's
 * outstanding_payable_amount / unused_credits_payable_amount move when bills are paid or credits
 * applied, but the contact's modified time stays. Comparing content (with sorted keys, so key
 * order never counts as a change) is how those updates are detected.
 */

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function payloadChanged(stored: unknown, incoming: unknown): boolean {
  return stableStringify(stored) !== stableStringify(incoming);
}
