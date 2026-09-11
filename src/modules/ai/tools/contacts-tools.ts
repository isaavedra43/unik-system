import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { registerTool } from './registry';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function decimalToString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return String(value);
  }
  return String(value);
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return Number(String(value));
  }
  return Number(value);
}

/* ------------------------------------------------------------------ */
/* 1. queryContacts — Universal contacts query tool                   */
/* ------------------------------------------------------------------ */

const CONTACT_GROUP_BY = ['none', 'contactType', 'status', 'taxRegime', 'owner'] as const;

registerTool({
  name: 'queryContacts',
  description:
    'TOOL UNIVERSAL de contactos (clientes y proveedores). Úsalo para CUALQUIER consulta de contactos. ' +
    'Soporta filtrar por búsqueda (nombre/empresa/email/teléfono), tipo (contactType: customer/vendor), ' +
    'estado (status), régimen fiscal (taxRegime) y propietario (owner). ' +
    'Puede agrupar por tipo, estado, régimen fiscal o propietario. ' +
    'Incluye saldos (outstandingReceivable, outstandingPayable), créditos, direcciones y campos fiscales. ' +
    'EJEMPLOS: ' +
    '"contactos" → queryContacts(). ' +
    '"clientes" → queryContacts(contactType="customer"). ' +
    '"proveedores" → queryContacts(contactType="vendor"). ' +
    '"busca a Juan" → queryContacts(search="Juan"). ' +
    '"clientes con saldo" → queryContacts(contactType="customer"). (filtra por outstandingReceivable > 0 en JS) ' +
    '"proveedores con saldo" → queryContacts(contactType="vendor"). (filtra por outstandingPayable > 0 en JS) ' +
    '"contactos por tipo" → queryContacts(groupBy="contactType").',
  category: 'contacts',
  requiredPermission: 'customers.view',
  enabledByDefault: true,
  parameters: z.object({
    search: z.string().optional().describe(
      'Búsqueda parcial en nombre del contacto, empresa, email, teléfono.'
    ),
    contactType: z.string().optional().describe(
      'Filtrar por tipo de contacto. Valores típicos: "customer" (cliente), "vendor" (proveedor). ' +
      'Úsalo para "clientes" → contactType="customer", "proveedores" → contactType="vendor".'
    ),
    status: z.string().optional().describe('Filtrar por estado (búsqueda parcial). Valores típicos: "active", "inactive".'),
    taxRegime: z.string().optional().describe('Filtrar por régimen fiscal (búsqueda parcial).'),
    owner: z.string().optional().describe('Filtrar por propietario/owner (búsqueda parcial).'),
    outstandingReceivableOnly: z.boolean().optional().describe(
      'true = solo contactos con saldo por cobrar (outstandingReceivable > 0). ' +
      'Úsalo para "clientes con saldo", "clientes que me deben".'
    ),
    outstandingPayableOnly: z.boolean().optional().describe(
      'true = solo contactos con saldo por pagar (outstandingPayable > 0). ' +
      'Úsalo para "proveedores con saldo", "proveedores a los que debo".'
    ),
    groupBy: z.enum(CONTACT_GROUP_BY).default('none').describe(
      'Agrupar resultados. "none" = lista individual. "contactType" = por tipo. "status" = por estado. "taxRegime" = por régimen fiscal. "owner" = por propietario.'
    ),
    includeAddresses: z.boolean().default(false).describe(
      'true = incluir direcciones completas de facturación y envío.'
    ),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as {
      search?: string; contactType?: string; status?: string; taxRegime?: string; owner?: string;
      outstandingReceivableOnly?: boolean; outstandingPayableOnly?: boolean;
      groupBy: (typeof CONTACT_GROUP_BY)[number];
      includeAddresses: boolean; page: number; pageSize: number;
    };

    // Build where clause
    const where: Record<string, unknown> = {};

    if (args.search) {
      where.OR = [
        { contactName: { contains: args.search, mode: 'insensitive' } },
        { companyName: { contains: args.search, mode: 'insensitive' } },
        { primaryEmail: { contains: args.search, mode: 'insensitive' } },
        { primaryPhone: { contains: args.search, mode: 'insensitive' } },
      ];
    }
    if (args.contactType) {
      where.contactType = { contains: args.contactType, mode: 'insensitive' };
    }
    if (args.status) {
      where.status = { contains: args.status, mode: 'insensitive' };
    }
    if (args.taxRegime) {
      where.taxRegime = { contains: args.taxRegime, mode: 'insensitive' };
    }
    if (args.owner) {
      where.ownerName = { contains: args.owner, mode: 'insensitive' };
    }

    const contacts = await prisma.contact.findMany({
      where: where as never,
      select: {
        id: true,
        contactName: true,
        companyName: true,
        contactType: true,
        status: true,
        primaryEmail: true,
        primaryPhone: true,
        website: true,
        outstandingReceivable: true,
        outstandingPayable: true,
        unusedCreditsReceivable: true,
        unusedCreditsPayable: true,
        paymentTerms: true,
        paymentTermsLabel: true,
        currencyCode: true,
        taxRegNo: true,
        taxTreatment: true,
        taxRegime: true,
        legalName: true,
        ownerName: true,
        firstName: true,
        lastName: true,
        mobile: true,
        designation: true,
        department: true,
        billingAddress: true,
        billingCity: true,
        billingState: true,
        billingZip: true,
        billingCountry: true,
        billingFax: true,
        shippingAddress: true,
        shippingCity: true,
        shippingState: true,
        shippingZip: true,
        shippingCountry: true,
        shippingFax: true,
        notes: true,
      },
      orderBy: { contactName: 'asc' },
      take: 1000,
    });

    // Apply outstanding filters in JavaScript
    let filtered = contacts;
    if (args.outstandingReceivableOnly) {
      filtered = filtered.filter((c) => toNumber(c.outstandingReceivable) > 0);
    }
    if (args.outstandingPayableOnly) {
      filtered = filtered.filter((c) => toNumber(c.outstandingPayable) > 0);
    }

    // Auto-diagnóstico
    const usedFilter = !!(args.contactType || args.status || args.taxRegime || args.owner);
    let diagnostic: Record<string, unknown> | null = null;
    if (filtered.length === 0 && usedFilter) {
      const uniqueTypes = new Map<string, number>();
      const uniqueStatuses = new Map<string, number>();
      const uniqueRegimes = new Map<string, number>();
      for (const c of contacts) {
        if (c.contactType) uniqueTypes.set(c.contactType, (uniqueTypes.get(c.contactType) ?? 0) + 1);
        if (c.status) uniqueStatuses.set(c.status, (uniqueStatuses.get(c.status) ?? 0) + 1);
        if (c.taxRegime) uniqueRegimes.set(c.taxRegime, (uniqueRegimes.get(c.taxRegime) ?? 0) + 1);
      }
      diagnostic = {
        message: 'La consulta devolvió 0 resultados. Valores disponibles:',
        totalContacts: contacts.length,
        availableContactTypes: [...uniqueTypes.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableStatuses: [...uniqueStatuses.entries()].map(([v, c]) => ({ value: v, count: c })),
        availableTaxRegimes: [...uniqueRegimes.entries()].map(([v, c]) => ({ value: v, count: c })),
        hint: 'Reintenta con un valor que SÍ exista.',
      };
    }

    if (args.groupBy === 'none') {
      const total = filtered.length;
      const totalPages = Math.ceil(total / args.pageSize);
      const paginated = filtered.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);

      return {
        mode: 'list',
        total, page: args.page, pageSize: args.pageSize, totalPages,
        filters: {
          search: args.search ?? null, contactType: args.contactType ?? null,
          status: args.status ?? null, taxRegime: args.taxRegime ?? null,
          owner: args.owner ?? null,
          outstandingReceivableOnly: args.outstandingReceivableOnly ?? null,
          outstandingPayableOnly: args.outstandingPayableOnly ?? null,
        },
        ...(diagnostic ? { diagnostic } : {}),
        contacts: paginated.map((c) => formatContact(c, args.includeAddresses)),
      };
    }

    // Group by
    const groups = new Map<string, { count: number; receivable: number; payable: number; contacts: typeof filtered }>();
    for (const c of filtered) {
      let key = 'SIN DATO';
      if (args.groupBy === 'contactType') key = c.contactType ?? 'SIN TIPO';
      else if (args.groupBy === 'status') key = c.status ?? 'SIN ESTADO';
      else if (args.groupBy === 'taxRegime') key = c.taxRegime ?? 'SIN RÉGIMEN';
      else if (args.groupBy === 'owner') key = c.ownerName ?? 'SIN PROPIETARIO';
      const g = groups.get(key) ?? { count: 0, receivable: 0, payable: 0, contacts: [] as typeof filtered };
      g.count++;
      g.receivable += toNumber(c.outstandingReceivable);
      g.payable += toNumber(c.outstandingPayable);
      g.contacts.push(c);
      groups.set(key, g);
    }

    const groupedResult = [...groups.entries()]
      .map(([key, g]) => ({
        key, count: g.count,
        totalReceivable: g.receivable.toFixed(2),
        totalPayable: g.payable.toFixed(2),
        contacts: g.contacts.slice(0, 50).map((c) => ({
          name: c.contactName, company: c.companyName,
          type: c.contactType, status: c.status,
          email: c.primaryEmail, phone: c.primaryPhone,
          outstandingReceivable: decimalToString(c.outstandingReceivable),
          outstandingPayable: decimalToString(c.outstandingPayable),
        })),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      mode: 'grouped', groupBy: args.groupBy, groupCount: groups.size,
      totalContacts: filtered.length,
      filters: {
        search: args.search ?? null, contactType: args.contactType ?? null,
        status: args.status ?? null, taxRegime: args.taxRegime ?? null,
        owner: args.owner ?? null,
        outstandingReceivableOnly: args.outstandingReceivableOnly ?? null,
        outstandingPayableOnly: args.outstandingPayableOnly ?? null,
      },
      ...(diagnostic ? { diagnostic } : {}),
      groups: groupedResult,
    };
  },
});

function formatContact(c: Record<string, unknown>, includeAddresses: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: c.contactName,
    company: c.companyName,
    type: c.contactType,
    status: c.status,
    email: c.primaryEmail,
    phone: c.primaryPhone,
    website: c.website,
    currency: c.currencyCode,
    paymentTerms: c.paymentTerms,
    paymentTermsLabel: c.paymentTermsLabel,
    outstandingReceivable: decimalToString(c.outstandingReceivable),
    outstandingPayable: decimalToString(c.outstandingPayable),
    unusedCreditsReceivable: decimalToString(c.unusedCreditsReceivable),
    unusedCreditsPayable: decimalToString(c.unusedCreditsPayable),
    taxRegNo: c.taxRegNo,
    taxTreatment: c.taxTreatment,
    taxRegime: c.taxRegime,
    legalName: c.legalName,
    owner: c.ownerName,
    firstName: c.firstName,
    lastName: c.lastName,
    mobile: c.mobile,
    designation: c.designation,
    department: c.department,
    notes: c.notes,
  };
  if (includeAddresses) {
    const billingParts = [c.billingAddress, c.billingCity, c.billingState, c.billingZip, c.billingCountry]
      .filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    result.billingAddress = billingParts.length > 0 ? billingParts.join(', ') : null;
    result.billingFax = c.billingFax;
    const shippingParts = [c.shippingAddress, c.shippingCity, c.shippingState, c.shippingZip, c.shippingCountry]
      .filter((p) => p !== null && p !== undefined && String(p).trim() !== '');
    result.shippingAddress = shippingParts.length > 0 ? shippingParts.join(', ') : null;
    result.shippingFax = c.shippingFax;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 2. getContactDetail — Detail by name/ID with all fields            */
/* ------------------------------------------------------------------ */

registerTool({
  name: 'getContactDetail',
  description:
    'Detalle completo de un contacto por su nombre, empresa o ID interno. ' +
    'Incluye todos los campos: saldos, créditos, direcciones, campos fiscales, datos de contacto.',
  category: 'contacts',
  requiredPermission: 'customers.view',
  enabledByDefault: true,
  parameters: z.object({
    contactNameOrId: z.string().min(1).describe('Nombre del contacto, empresa o ID interno (búsqueda parcial).'),
  }),
  execute: async (_actor, rawArgs) => {
    const args = rawArgs as { contactNameOrId: string };
    const contact = await prisma.contact.findFirst({
      where: {
        OR: [
          { contactName: { contains: args.contactNameOrId, mode: 'insensitive' } },
          { companyName: { contains: args.contactNameOrId, mode: 'insensitive' } },
          { id: args.contactNameOrId },
        ],
      },
    });
    if (!contact) return { found: false, searched: args.contactNameOrId };
    return {
      found: true,
      contact: {
        id: contact.id,
        name: contact.contactName,
        company: contact.companyName,
        type: contact.contactType,
        status: contact.status,
        email: contact.primaryEmail,
        phone: contact.primaryPhone,
        website: contact.website,
        currency: contact.currencyCode,
        paymentTerms: contact.paymentTerms,
        paymentTermsLabel: contact.paymentTermsLabel,
        outstandingReceivable: decimalToString(contact.outstandingReceivable),
        outstandingPayable: decimalToString(contact.outstandingPayable),
        unusedCreditsReceivable: decimalToString(contact.unusedCreditsReceivable),
        unusedCreditsPayable: decimalToString(contact.unusedCreditsPayable),
        taxRegNo: contact.taxRegNo,
        taxTreatment: contact.taxTreatment,
        taxRegime: contact.taxRegime,
        legalName: contact.legalName,
        isTdsRegistered: contact.isTdsRegistered,
        owner: contact.ownerName,
        firstName: contact.firstName,
        lastName: contact.lastName,
        mobile: contact.mobile,
        designation: contact.designation,
        department: contact.department,
        customerSubType: contact.customerSubType,
        portalStatus: contact.portalStatus,
        source: contact.source,
        photoUrl: contact.photoUrl,
        primaryContactId: contact.primaryContactId,
        creditLimitExceededAmount: decimalToString(contact.creditLimitExceededAmount),
        notes: contact.notes,
        // Billing address
        billingAddress: contact.billingAddress,
        billingCity: contact.billingCity,
        billingState: contact.billingState,
        billingZip: contact.billingZip,
        billingCountry: contact.billingCountry,
        billingFax: contact.billingFax,
        // Shipping address
        shippingAddress: contact.shippingAddress,
        shippingCity: contact.shippingCity,
        shippingState: contact.shippingState,
        shippingZip: contact.shippingZip,
        shippingCountry: contact.shippingCountry,
        shippingFax: contact.shippingFax,
      },
    };
  },
});
