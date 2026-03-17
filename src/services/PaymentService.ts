// =========================================================
// PAYMENT SERVICE - Generación de link PSE
// =========================================================

import { IdrdReservationResponse, PsePaymentResponse } from '../types';
import { logger } from '../utils/logger';

/**
 * Extracts the payment link from the PSE response
 * Handles multiple possible field names from the IDRD API
 */
export function extractPaymentLink(response: PsePaymentResponse): string {
  const data = response?.data || response;

  const link =
    (data as any).bank_url ||
    (data as any).bankUrl ||
    (data as any).url ||
    (data as any).processUrl ||
    (data as any).redirect_url;

  if (!link || String(link).trim() === '') {
    return 'https://portalciudadano.idrd.gov.co/app/pagos';
  }

  return link;
}

/**
 * Extracts the reservation/payment ID
 */
export function extractPaymentId(response: PsePaymentResponse): string {
  const data = response?.data || response;
  return String((data as any).payment || (data as any).booking_id || 'CONFIRMADA');
}
