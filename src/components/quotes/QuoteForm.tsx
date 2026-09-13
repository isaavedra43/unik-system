'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Save, Search, Trash2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import {
  quoteFormInputSchema, estimateTotals, type QuoteFormInput, type DiscountMode,
} from '@/modules/quotes/quotes-form-schema';
import type { CustomerLookupRow, ProductLookupRow } from '@/modules/quotes/quotes-service';
import type { SalespersonOption } from '@/modules/quotes/quotes-salespersons';
import { formatCurrency } from '@/modules/quotes/quotes-helpers';
import type { QuoteWriteResult } from '@/app/app/quotes/actions';

interface LineState {
  key: string;
  lineItemId: string | null;
  itemId: string | null;
  name: string;
  description: string;
  quantity: string;
  rate: string;
  unit: string;
  discountPercent: string;
  taxId: string | null;
  taxName: string | null;
  taxPercent: number | null;
  sku: string | null;
}

export interface QuoteFormProps {
  mode: 'create' | 'edit';
  basePath: string;
  quoteId?: string;
  initialValues: QuoteFormInput;
  initialCustomer: CustomerLookupRow | null;
  /** Salespersons from Zoho (merged with local history). */
  salespersons: SalespersonOption[];
  /** Product tax percentages keyed by zohoItemId (for the totals preview). */
  initialLineTaxes?: Record<string, { taxName: string | null; taxPercent: number | null; sku: string | null }>;
  estimateNumber?: string | null;
  isMockMode: boolean;
  submitAction: (input: QuoteFormInput) => Promise<QuoteWriteResult>;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function toLineState(line: QuoteFormInput['items'][number], taxes?: QuoteFormProps['initialLineTaxes']): LineState {
  const meta = line.itemId && taxes ? taxes[line.itemId] : undefined;
  return {
    key: newKey(),
    lineItemId: line.lineItemId ?? null,
    itemId: line.itemId ?? null,
    name: line.name ?? '',
    description: line.description ?? '',
    quantity: String(line.quantity ?? 1),
    rate: String(line.rate ?? 0),
    unit: line.unit ?? '',
    discountPercent: line.discountPercent ? String(line.discountPercent) : '',
    taxId: line.taxId ?? null,
    taxName: meta?.taxName ?? null,
    taxPercent: meta?.taxPercent ?? null,
    sku: meta?.sku ?? null,
  };
}

function useDebouncedSearch<T>(url: string, enabled: boolean) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`${url}?q=${encodeURIComponent(term)}`);
        if (res.ok) {
          const json = (await res.json()) as { data: T[] };
          setResults(json.data);
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [term, url, enabled]);

  return { term, setTerm, results, loading };
}

export function QuoteForm({ mode, basePath, quoteId, initialValues, initialCustomer, salespersons, initialLineTaxes, estimateNumber, isMockMode, submitAction }: QuoteFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const requestKeyRef = useRef(initialValues.requestKey);

  const [customer, setCustomer] = useState<CustomerLookupRow | null>(initialCustomer);
  const [customerPickerOpen, setCustomerPickerOpen] = useState(!initialCustomer);
  const customerSearch = useDebouncedSearch<CustomerLookupRow>(`${basePath}/api/lookup/customers`, customerPickerOpen);

  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const productSearch = useDebouncedSearch<ProductLookupRow>(`${basePath}/api/lookup/products`, productPickerOpen);

  const [date, setDate] = useState(initialValues.date);
  const [expiryDate, setExpiryDate] = useState(initialValues.expiryDate ?? '');
  const [referenceNumber, setReferenceNumber] = useState(initialValues.referenceNumber ?? '');
  const [salespersonName, setSalespersonName] = useState(initialValues.salespersonName ?? '');
  const [salespersonId, setSalespersonId] = useState<string | null>(initialValues.salespersonId ?? null);
  const salespersonOptions = useMemo(() => {
    const list = [...salespersons];
    const current = (initialValues.salespersonName ?? '').trim();
    if (current && !list.some((s) => s.name.toLowerCase() === current.toLowerCase())) {
      list.push({ id: initialValues.salespersonId ?? null, name: current, email: null, source: 'local' });
    }
    return list;
  }, [salespersons, initialValues.salespersonName, initialValues.salespersonId]);
  const [notes, setNotes] = useState(initialValues.notes ?? '');
  const [terms, setTerms] = useState(initialValues.terms ?? '');
  const [discountMode, setDiscountMode] = useState<DiscountMode>(initialValues.discountMode ?? 'none');
  const [discountValue, setDiscountValue] = useState(initialValues.discountValue ? String(initialValues.discountValue) : '');
  const [discountIsPercent, setDiscountIsPercent] = useState(initialValues.discountIsPercent ?? true);
  const [isDiscountBeforeTax, setIsDiscountBeforeTax] = useState(initialValues.isDiscountBeforeTax ?? true);
  const [shippingCharge, setShippingCharge] = useState(initialValues.shippingCharge ? String(initialValues.shippingCharge) : '');
  const [adjustment, setAdjustment] = useState(initialValues.adjustment ? String(initialValues.adjustment) : '');
  const [adjustmentDescription, setAdjustmentDescription] = useState(initialValues.adjustmentDescription ?? '');
  const [lines, setLines] = useState<LineState[]>(() => initialValues.items.map((l) => toLineState(l, initialLineTaxes)));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<QuoteWriteResult['conflictQuote']>(null);

  const totals = useMemo(() => estimateTotals({
    items: lines.map((l) => ({ quantity: Number(l.quantity) || 0, rate: Number(l.rate) || 0, discountPercent: Number(l.discountPercent) || 0, taxPercent: l.taxPercent })),
    discountMode, discountValue: Number(discountValue) || 0, discountIsPercent,
    shippingCharge: Number(shippingCharge) || 0, adjustment: Number(adjustment) || 0,
  }), [lines, discountMode, discountValue, discountIsPercent, shippingCharge, adjustment]);

  const currency = customer?.currencyCode ?? null;

  const updateLine = useCallback((key: string, patch: Partial<LineState>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }, []);

  const addProduct = useCallback((product: ProductLookupRow) => {
    setLines((prev) => [...prev, {
      key: newKey(), lineItemId: null, itemId: product.zohoItemId, name: product.name ?? product.sku ?? 'Producto',
      description: product.description ?? '', quantity: '1', rate: product.rate ?? '0', unit: product.unit ?? '',
      discountPercent: '', taxId: null, taxName: product.taxName, taxPercent: product.taxPercentage ? Number(product.taxPercentage) : null, sku: product.sku,
    }]);
    setProductPickerOpen(false);
    productSearch.setTerm('');
  }, [productSearch]);

  const addFreeLine = useCallback(() => {
    setLines((prev) => [...prev, { key: newKey(), lineItemId: null, itemId: null, name: '', description: '', quantity: '1', rate: '0', unit: '', discountPercent: '', taxId: null, taxName: null, taxPercent: null, sku: null }]);
  }, []);

  const buildInput = (): QuoteFormInput => ({
    requestKey: requestKeyRef.current,
    customerId: customer?.zohoContactId ?? '',
    date,
    expiryDate: expiryDate || null,
    referenceNumber: referenceNumber || null,
    salespersonName: salespersonName || null,
    salespersonId: salespersonId || null,
    notes: notes || null,
    terms: terms || null,
    discountMode,
    discountValue: discountMode === 'entity' ? Number(discountValue) || 0 : null,
    discountIsPercent,
    isDiscountBeforeTax,
    shippingCharge: shippingCharge === '' ? null : Number(shippingCharge),
    adjustment: adjustment === '' ? null : Number(adjustment),
    adjustmentDescription: adjustmentDescription || null,
    templateId: initialValues.templateId ?? null,
    expectedRemoteModifiedAt: initialValues.expectedRemoteModifiedAt ?? null,
    items: lines.map((l) => ({
      lineItemId: l.lineItemId, itemId: l.itemId, name: l.name, description: l.description || null,
      quantity: Number(l.quantity), rate: Number(l.rate), unit: l.unit || null,
      discountPercent: discountMode === 'item' && l.discountPercent !== '' ? Number(l.discountPercent) : null,
      taxId: l.taxId,
    })),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const input = buildInput();
    const parsed = quoteFormInputSchema.safeParse(input);
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) errors[issue.path.join('.')] = issue.message;
      setFieldErrors(errors);
      toast.error(parsed.error.issues[0]?.message ?? 'Revisa los datos del formulario');
      return;
    }
    setFieldErrors({});
    startTransition(async () => {
      const result = await submitAction(input);
      if (result.success && result.quote) {
        toast.success(mode === 'create' ? `Cotización ${result.quote.estimateNumber ?? ''} creada en Zoho` : 'Cotización actualizada en Zoho');
        router.push(`${basePath}/${result.quote.id}`);
        router.refresh();
        return;
      }
      if (result.code === 'CONFLICT') {
        setConflict(result.conflictQuote ?? null);
        toast.error(result.error ?? 'Conflicto con Zoho');
        return;
      }
      if (result.code === 'REQUEST_IN_PROGRESS') {
        toast.error(result.error ?? 'Solicitud en proceso');
        return;
      }
      // Any other failure: rotate the request key so a retry after a real
      // failure is not treated as a replay of a completed request.
      if (mode === 'create' && result.code !== 'ZOHO_TIMEOUT') requestKeyRef.current = newKey();
      toast.error(result.error ?? 'No se pudo guardar');
    });
  };

  const err = (path: string) => fieldErrors[path];

  return (
    <div className="app-content">
      <form onSubmit={handleSubmit} className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <Link href={mode === 'edit' && quoteId ? `${basePath}/${quoteId}` : basePath} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" /> {mode === 'edit' ? 'Volver al detalle' : 'Volver a cotizaciones'}
          </Link>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
            <Save size={14} /> {pending ? 'Guardando en Zoho...' : mode === 'create' ? 'Crear en Zoho Books' : 'Guardar cambios en Zoho'}
          </button>
        </div>

        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{mode === 'create' ? 'Nueva cotización' : `Editar ${estimateNumber ?? 'cotización'}`}</h1>
          <p className="text-sm text-muted-foreground">
            {mode === 'create'
              ? 'El folio, los impuestos y los totales definitivos los asigna Zoho Books al guardar. Nunca se duplican folios aunque alguien cree una cotización en Zoho al mismo tiempo.'
              : 'Los cambios se aplican directamente en Zoho Books. Si alguien modificó la cotización en Zoho mientras editabas, te avisaremos antes de sobrescribir.'}
          </p>
          {isMockMode ? <p className="text-xs text-warning">Modo simulación activo: no se llamará a Zoho (ZOHO_BOOKS_MOCK=true).</p> : null}
        </div>

        {conflict ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm space-y-2">
            <div className="flex items-center gap-2 font-medium text-destructive"><AlertTriangle size={16} /> La cotización cambió en Zoho</div>
            <p>Otra persona modificó esta cotización en Zoho Books (estado actual: {conflict.status ?? '—'}, total {formatCurrency(conflict.total, conflict.currencyCode)}). Ya se sincronizó la versión de Zoho. Recarga el formulario para editar sobre la versión más reciente.</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { router.refresh(); window.location.reload(); }}>Recargar con la versión de Zoho</button>
          </div>
        ) : null}

        {/* Customer */}
        <section className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold">Cliente</h2>
            {mode === 'create' || !customer ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCustomerPickerOpen((v) => !v)}>
                <Search size={14} /> {customer ? 'Cambiar cliente' : 'Buscar cliente'}
              </button>
            ) : null}
          </div>
          {customer ? (
            <div className="rounded-md border border-input bg-background px-4 py-3 text-sm">
              <div className="font-medium">{customer.contactName ?? customer.companyName ?? '—'}</div>
              <div className="text-muted-foreground text-xs">
                {[customer.companyName, customer.primaryEmail, customer.currencyCode ? `Moneda ${customer.currencyCode}` : null].filter(Boolean).join(' · ') || 'Sin datos adicionales'}
              </div>
            </div>
          ) : (
            <p className="text-sm text-destructive">{err('customerId') ?? 'Selecciona un cliente del catálogo sincronizado desde Zoho.'}</p>
          )}
          {customerPickerOpen ? (
            <div className="space-y-2">
              <input className="input" autoFocus placeholder="Buscar por nombre, empresa o correo..." value={customerSearch.term} onChange={(e) => customerSearch.setTerm(e.target.value)} />
              <div className="max-h-64 overflow-y-auto rounded-md border border-input divide-y">
                {customerSearch.loading && customerSearch.results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">Buscando...</div> : null}
                {!customerSearch.loading && customerSearch.results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">Sin resultados. Sincroniza contactos si el cliente es nuevo en Zoho.</div> : null}
                {customerSearch.results.map((c) => (
                  <button type="button" key={c.zohoContactId} className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors" onClick={() => { setCustomer(c); setCustomerPickerOpen(false); }}>
                    <div className="font-medium">{c.contactName ?? c.companyName ?? c.zohoContactId}</div>
                    <div className="text-xs text-muted-foreground">{[c.companyName, c.primaryEmail, c.status].filter(Boolean).join(' · ')}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>

        {/* Header fields */}
        <section className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold">Datos generales</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Fecha *</span>
              <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} required />
              {err('date') ? <span className="form-help text-destructive">{err('date')}</span> : null}
            </label>
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Vigencia hasta</span>
              <input type="date" className="input" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} min={date} />
              {err('expiryDate') ? <span className="form-help text-destructive">{err('expiryDate')}</span> : null}
            </label>
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Referencia</span>
              <input className="input" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} maxLength={100} placeholder="Ej. OC del cliente" />
            </label>
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Vendedor</span>
              <select
                className="input"
                value={salespersonName}
                onChange={(e) => {
                  const name = e.target.value;
                  const match = salespersonOptions.find((s) => s.name === name);
                  setSalespersonName(name);
                  setSalespersonId(match?.id ?? null);
                }}
              >
                <option value="">Sin vendedor</option>
                {salespersonOptions.map((s) => (
                  <option key={`${s.id ?? 'local'}-${s.name}`} value={s.name}>{s.name}{s.source === 'local' ? ' (historial)' : ''}</option>
                ))}
              </select>
              {salespersonOptions.length === 0 ? <span className="form-help">No hay vendedores disponibles. Se cargan desde Zoho Books al conectar las credenciales.</span> : null}
            </label>
          </div>
        </section>

        {/* Lines */}
        <section className="rounded-lg border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <h2 className="text-lg font-semibold">Conceptos</h2>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setProductPickerOpen((v) => !v)}><Search size={14} /> Agregar producto</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={addFreeLine}><Plus size={14} /> Línea libre</button>
            </div>
          </div>
          {err('items') ? <p className="text-sm text-destructive">{err('items')}</p> : null}

          {productPickerOpen ? (
            <div className="space-y-2">
              <input className="input" autoFocus placeholder="Buscar producto por nombre o SKU..." value={productSearch.term} onChange={(e) => productSearch.setTerm(e.target.value)} />
              <div className="max-h-64 overflow-y-auto rounded-md border border-input divide-y">
                {productSearch.loading && productSearch.results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">Buscando...</div> : null}
                {!productSearch.loading && productSearch.results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">Sin resultados.</div> : null}
                {productSearch.results.map((p) => (
                  <button type="button" key={p.zohoItemId} className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-3" onClick={() => addProduct(p)}>
                    <span>
                      <span className="font-medium">{p.name ?? '—'}</span>
                      <span className="block text-xs text-muted-foreground">{[p.sku ? `SKU ${p.sku}` : null, p.taxName ? (p.taxName.includes('%') ? p.taxName : `${p.taxName} ${p.taxPercentage ?? 0}%`) : null, p.availableStock !== null ? `Stock ${p.availableStock}` : null].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className="text-sm font-medium whitespace-nowrap">{formatCurrency(p.rate, currency)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 720 }}>
              <thead className="border-b bg-muted/50">
                <tr>
                  <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide" style={{ minWidth: 220 }}>Producto / concepto</th>
                  <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide" style={{ width: 100 }}>Cantidad</th>
                  <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide" style={{ width: 130 }}>Precio</th>
                  {discountMode === 'item' ? <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide" style={{ width: 90 }}>Desc. %</th> : null}
                  <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide" style={{ width: 120 }}>Impuesto</th>
                  <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide" style={{ width: 130 }}>Importe</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Agrega productos del catálogo o una línea libre.</td></tr>
                ) : lines.map((line, index) => {
                  const gross = (Number(line.quantity) || 0) * (Number(line.rate) || 0);
                  const disc = discountMode === 'item' ? gross * ((Number(line.discountPercent) || 0) / 100) : 0;
                  return (
                    <tr key={line.key} className="border-b last:border-0 align-top">
                      <td className="px-2 py-2">
                        <input className="input" value={line.name} onChange={(e) => updateLine(line.key, { name: e.target.value })} placeholder="Nombre del concepto" maxLength={200} />
                        <input className="input" style={{ marginTop: 4, fontSize: '0.8rem' }} value={line.description} onChange={(e) => updateLine(line.key, { description: e.target.value })} placeholder="Descripción (opcional)" maxLength={2000} />
                        {line.sku ? <div className="text-xs text-muted-foreground" style={{ marginTop: 2 }}>SKU {line.sku}{line.itemId ? ' · catálogo Zoho' : ''}</div> : line.itemId ? <div className="text-xs text-muted-foreground" style={{ marginTop: 2 }}>Catálogo Zoho</div> : <div className="text-xs text-muted-foreground" style={{ marginTop: 2 }}>Línea libre (sin producto)</div>}
                        {err(`items.${index}.name`) ? <div className="text-xs text-destructive">{err(`items.${index}.name`)}</div> : null}
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" step="any" min="0" className="input text-right" value={line.quantity} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} />
                        <input className="input" style={{ marginTop: 4, fontSize: '0.8rem' }} value={line.unit} onChange={(e) => updateLine(line.key, { unit: e.target.value })} placeholder="Unidad" maxLength={40} />
                        {err(`items.${index}.quantity`) ? <div className="text-xs text-destructive">{err(`items.${index}.quantity`)}</div> : null}
                      </td>
                      <td className="px-2 py-2">
                        <input type="number" step="any" min="0" className="input text-right" value={line.rate} onChange={(e) => updateLine(line.key, { rate: e.target.value })} />
                      </td>
                      {discountMode === 'item' ? (
                        <td className="px-2 py-2">
                          <input type="number" step="any" min="0" max="100" className="input text-right" value={line.discountPercent} onChange={(e) => updateLine(line.key, { discountPercent: e.target.value })} placeholder="0" />
                        </td>
                      ) : null}
                      <td className="px-2 py-2 text-xs text-muted-foreground">
                        {line.taxName ? (line.taxName.includes('%') ? line.taxName : `${line.taxName} (${line.taxPercent ?? 0}%)`) : line.itemId ? 'Impuesto del producto en Zoho' : 'Según Zoho'}
                      </td>
                      <td className="px-2 py-2 text-right font-medium">{formatCurrency(gross - disc, currency)}</td>
                      <td className="px-2 py-2">
                        <button type="button" className="icon-btn" aria-label="Quitar línea" onClick={() => removeLine(line.key)}><Trash2 size={16} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Discounts, charges, totals */}
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <h2 className="text-lg font-semibold">Descuento y cargos</h2>
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Tipo de descuento</span>
              <select className="input" value={discountMode} onChange={(e) => setDiscountMode(e.target.value as DiscountMode)}>
                <option value="none">Sin descuento</option>
                <option value="entity">Descuento general a la cotización</option>
                <option value="item">Descuento por concepto</option>
              </select>
            </label>
            {discountMode === 'entity' ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="form-field" style={{ marginBottom: 0 }}>
                  <span className="form-label">Descuento</span>
                  <input type="number" step="any" min="0" className="input" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
                  {err('discountValue') ? <span className="form-help text-destructive">{err('discountValue')}</span> : null}
                </label>
                <label className="form-field" style={{ marginBottom: 0 }}>
                  <span className="form-label">Unidad</span>
                  <select className="input" value={discountIsPercent ? 'percent' : 'amount'} onChange={(e) => setDiscountIsPercent(e.target.value === 'percent')}>
                    <option value="percent">Porcentaje (%)</option>
                    <option value="amount">Monto</option>
                  </select>
                </label>
              </div>
            ) : null}
            {discountMode !== 'none' ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isDiscountBeforeTax} onChange={(e) => setIsDiscountBeforeTax(e.target.checked)} />
                Aplicar descuento antes de impuestos
              </label>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="form-field" style={{ marginBottom: 0 }}>
                <span className="form-label">Envío</span>
                <input type="number" step="any" min="0" className="input" value={shippingCharge} onChange={(e) => setShippingCharge(e.target.value)} placeholder="0" />
              </label>
              <label className="form-field" style={{ marginBottom: 0 }}>
                <span className="form-label">Ajuste (+/-)</span>
                <input type="number" step="any" className="input" value={adjustment} onChange={(e) => setAdjustment(e.target.value)} placeholder="0" />
              </label>
            </div>
            {adjustment !== '' ? (
              <label className="form-field" style={{ marginBottom: 0 }}>
                <span className="form-label">Descripción del ajuste</span>
                <input className="input" value={adjustmentDescription} onChange={(e) => setAdjustmentDescription(e.target.value)} maxLength={200} />
              </label>
            ) : null}
          </div>

          <div className="rounded-lg border bg-card p-6 space-y-3">
            <h2 className="text-lg font-semibold">Totales estimados</h2>
            <p className="text-xs text-muted-foreground">Cálculo preliminar. Zoho Books recalcula impuestos y totales definitivos al guardar.</p>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">Subtotal</dt><dd>{formatCurrency(totals.subTotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Descuento</dt><dd>{formatCurrency(totals.discountTotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Impuestos</dt><dd>{formatCurrency(totals.taxTotal, currency)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">Envío + ajuste</dt><dd>{formatCurrency((Number(shippingCharge) || 0) + (Number(adjustment) || 0), currency)}</dd></div>
              <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>Total</dt><dd>{formatCurrency(totals.total, currency)}</dd></div>
            </dl>
          </div>
        </section>

        {/* Notes */}
        <section className="rounded-lg border bg-card p-6 space-y-4">
          <h2 className="text-lg font-semibold">Notas y términos</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Notas para el cliente</span>
              <textarea className="input" rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} placeholder="Aparecen en el PDF de Zoho" />
            </label>
            <label className="form-field" style={{ marginBottom: 0 }}>
              <span className="form-label">Términos y condiciones</span>
              <textarea className="input" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={5000} placeholder="Vacío = términos por defecto de Zoho" />
            </label>
          </div>
        </section>

        <div className="flex items-center justify-end gap-2">
          <Link href={mode === 'edit' && quoteId ? `${basePath}/${quoteId}` : basePath} className="btn btn-secondary btn-sm">Cancelar</Link>
          <button type="submit" className="btn btn-primary btn-sm" disabled={pending}>
            <Save size={14} /> {pending ? 'Guardando en Zoho...' : mode === 'create' ? 'Crear en Zoho Books' : 'Guardar cambios en Zoho'}
          </button>
        </div>
      </form>
    </div>
  );
}
