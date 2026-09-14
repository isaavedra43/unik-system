/**
 * Spanish labels of the quote fields tracked by change detection. Kept in a
 * dependency-free file so client components (detail page) can import it
 * without pulling the server-only notification transports.
 */
export const QUOTE_CHANGE_FIELD_LABELS: Record<string, string> = {
  status: 'Estado', customerName: 'Cliente', salespersonName: 'Vendedor', date: 'Fecha',
  expiryDate: 'Vencimiento', referenceNumber: 'Referencia', discount: 'Descuento', subTotal: 'Subtotal',
  discountTotal: 'Descuento total', taxTotal: 'Impuestos', shippingCharge: 'Envío', adjustment: 'Ajuste',
  total: 'Total', notes: 'Notas', terms: 'Términos',
};
