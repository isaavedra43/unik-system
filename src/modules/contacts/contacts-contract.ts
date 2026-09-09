import { Prisma } from '@prisma/client';

/**
 * Canonical camelCase DTOs for the Contacts workspace and detail pages.
 * These are the ONLY shapes exposed to the UI.
 */

export interface ContactListRow {
  id: string;
  contactType: string | null;
  contactName: string | null;
  companyName: string | null;
  status: string | null;
  currencyCode: string | null;
  paymentTermsLabel: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  website: string | null;
  outstandingReceivable: string | null;
  outstandingPayable: string | null;
  sourceRemoteModifiedAt: string | null;
}

export interface ContactDetail {
  id: string;
  zohoContactId: string;
  contactType: string | null;
  contactName: string | null;
  companyName: string | null;
  status: string | null;
  currencyCode: string | null;
  paymentTerms: number | null;
  paymentTermsLabel: string | null;
  outstandingReceivable: string | null;
  outstandingPayable: string | null;
  unusedCreditsReceivable: string | null;
  unusedCreditsPayable: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  website: string | null;
  languageCode: string | null;
  // Mexico fiscal fields
  taxRegNo: string | null;
  taxTreatment: string | null;
  taxRegime: string | null;
  legalName: string | null;
  isTdsRegistered: boolean | null;
  // Sync tracking
  sourceRemoteModifiedAt: string;
  sourceSnapshotId: string;
  normalizedAt: string;
  createdAt: string;
  updatedAt: string;
}

function decimalToString(value: Prisma.Decimal | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.toString();
}

export function toContactListRow(contact: {
  id: string;
  contactType: string | null;
  contactName: string | null;
  companyName: string | null;
  status: string | null;
  currencyCode: string | null;
  paymentTermsLabel: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  website: string | null;
  outstandingReceivable: Prisma.Decimal | null;
  outstandingPayable: Prisma.Decimal | null;
  sourceRemoteModifiedAt: Date;
}): ContactListRow {
  return {
    id: contact.id,
    contactType: contact.contactType,
    contactName: contact.contactName,
    companyName: contact.companyName,
    status: contact.status,
    currencyCode: contact.currencyCode,
    paymentTermsLabel: contact.paymentTermsLabel,
    primaryEmail: contact.primaryEmail,
    primaryPhone: contact.primaryPhone,
    website: contact.website,
    outstandingReceivable: decimalToString(contact.outstandingReceivable),
    outstandingPayable: decimalToString(contact.outstandingPayable),
    sourceRemoteModifiedAt: contact.sourceRemoteModifiedAt.toISOString(),
  };
}

export function toContactDetail(contact: {
  id: string;
  zohoContactId: string;
  contactType: string | null;
  contactName: string | null;
  companyName: string | null;
  status: string | null;
  currencyCode: string | null;
  paymentTerms: number | null;
  paymentTermsLabel: string | null;
  outstandingReceivable: Prisma.Decimal | null;
  outstandingPayable: Prisma.Decimal | null;
  unusedCreditsReceivable: Prisma.Decimal | null;
  unusedCreditsPayable: Prisma.Decimal | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  website: string | null;
  languageCode: string | null;
  taxRegNo: string | null;
  taxTreatment: string | null;
  taxRegime: string | null;
  legalName: string | null;
  isTdsRegistered: boolean | null;
  sourceRemoteModifiedAt: Date;
  sourceSnapshotId: string;
  normalizedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}): ContactDetail {
  return {
    id: contact.id,
    zohoContactId: contact.zohoContactId,
    contactType: contact.contactType,
    contactName: contact.contactName,
    companyName: contact.companyName,
    status: contact.status,
    currencyCode: contact.currencyCode,
    paymentTerms: contact.paymentTerms,
    paymentTermsLabel: contact.paymentTermsLabel,
    outstandingReceivable: decimalToString(contact.outstandingReceivable),
    outstandingPayable: decimalToString(contact.outstandingPayable),
    unusedCreditsReceivable: decimalToString(contact.unusedCreditsReceivable),
    unusedCreditsPayable: decimalToString(contact.unusedCreditsPayable),
    primaryEmail: contact.primaryEmail,
    primaryPhone: contact.primaryPhone,
    website: contact.website,
    languageCode: contact.languageCode,
    taxRegNo: contact.taxRegNo,
    taxTreatment: contact.taxTreatment,
    taxRegime: contact.taxRegime,
    legalName: contact.legalName,
    isTdsRegistered: contact.isTdsRegistered,
    sourceRemoteModifiedAt: contact.sourceRemoteModifiedAt.toISOString(),
    sourceSnapshotId: contact.sourceSnapshotId,
    normalizedAt: contact.normalizedAt.toISOString(),
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}
