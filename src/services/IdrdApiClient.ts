// =========================================================
// IDRD API CLIENT - HTTP client con retries para IDRD
// =========================================================

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import { IdrdLoginResponse, IdrdScheduleSlot, IdrdReservationResponse, PsePaymentResponse } from '../types';
import { logger } from '../utils/logger';

export class IdrdApiClient {
  private citizenClient: AxiosInstance;
  private contractorClient: AxiosInstance;

  constructor(citizenBaseUrl: string, contractorBaseUrl: string) {
    const browserHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
    };

    this.citizenClient = axios.create({
      baseURL: citizenBaseUrl,
      timeout: 30000,
      headers: browserHeaders,
      decompress: false,
    });

    this.contractorClient = axios.create({
      baseURL: contractorBaseUrl,
      timeout: 30000,
      headers: browserHeaders,
    });

    // Strip Accept-Encoding only on citizen (the /login endpoint rejects it with 405).
    // Contractor must keep default decompression so the PSE JSON response is parsed correctly.
    const stripDefaults = (config: any) => {
      if (config.headers) {
        delete config.headers['Accept-Encoding'];
        delete config.headers['accept-encoding'];
      }
      return config;
    };
    this.citizenClient.interceptors.request.use(stripDefaults);

    // Log request details on auth/method errors (405 / 401) for diagnostics
    const logOnError = (error: any) => {
      const status = error?.response?.status;
      if (status === 405 || status === 401) {
        logger.error({
          sentHeaders: error.config?.headers,
          url: error.config?.url,
          method: error.config?.method,
          receivedHeaders: error.response?.headers,
          responseBody: error.response?.data,
        }, `🔍 DIAGNÓSTICO ${status}: headers enviados vs respuesta`);
      }
      return Promise.reject(error);
    };
    this.citizenClient.interceptors.response.use(undefined, logOnError);
    this.contractorClient.interceptors.response.use(undefined, logOnError);

    // Retry config: 3 attempts with exponential backoff
    axiosRetry(this.citizenClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response?.status !== undefined && error.response.status >= 500);
      },
      onRetry: (retryCount, error) => {
        logger.warn({ retry: retryCount, error: error.message }, 'Reintentando petición IDRD (citizen)');
      },
    });

    axiosRetry(this.contractorClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: (error) => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) ||
               (error.response?.status !== undefined && error.response.status >= 500);
      },
      onRetry: (retryCount, error) => {
        logger.warn({ retry: retryCount, error: error.message }, 'Reintentando petición IDRD (contractor)');
      },
    });
  }

  /**
   * Login to IDRD portal → returns access_token
   */
  async login(email: string, password: string): Promise<IdrdLoginResponse> {
    const response = await this.citizenClient.post<IdrdLoginResponse>('/login', {
      email,
      password,
    });
    return response.data;
  }

  /**
   * Query park availability for a specific date
   */
  async getSchedules(parkId: number, date: string, document: string, token: string): Promise<IdrdScheduleSlot[]> {
    const response = await this.citizenClient.get<{ data: IdrdScheduleSlot[] }>(
      `/parks/schedules/${parkId}`,
      {
        params: { date, Documento: document },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data?.data || [];
  }

  /**
   * Create reservation and initiate payment
   */
  async createReservation(
    parkId: number,
    date: string,
    startHour: string,
    endHour: string,
    document: string,
    token: string,
  ): Promise<IdrdReservationResponse> {
    const response = await this.citizenClient.post<IdrdReservationResponse>(
      `/parks/schedules/${parkId}/payment`,
      {
        date,
        start_hour: startHour,
        final_hour: endHour,
        payment_method: 'PSE',
        bank_id: 1507,
        person_type: 'N',
        parkSelected: parkId,
        document: String(document),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://portalciudadano.idrd.gov.co',
          Referer: 'https://portalciudadano.idrd.gov.co/app/reservas',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }
    );
    return response.data;
  }

  /**
   * Generate PSE payment link via contractor portal
   */
  async generatePaymentLink(
    reservationData: IdrdReservationResponse['data'],
    token: string,
    account: { name: string; document: string; email: string },
  ): Promise<PsePaymentResponse> {
    const nameParts = account.name.split(' ');
    const firstName = nameParts[0] || 'N/A';
    const lastName = nameParts.slice(1).join(' ') || 'N/A';

    const response = await this.contractorClient.post<PsePaymentResponse>(
      '/payment-gateway/transferBank',
      {
        reservationId: reservationData.booking_id,
        totalPay: reservationData.amount,
        concept: reservationData.concept,
        BankTypeSelected: '1507',
        permitTypeSelected: 'PO',
        permitNumber: '999',
        isTheSame: false,
        name: reservationData.name || firstName,
        lastName: reservationData.surname || lastName,
        documentTypeSelected: 'CC',
        document: reservationData.document || account.document,
        email: reservationData.email || account.email,
        phone: '3176357660',
        address: 'CRA 90A 91 60',
        typePersonSelected: 'N',
        namePayer: 'NICOLAS',
        lastNamePayer: 'SUAREZ VILLALBA',
        documentTypeSelectedPayer: 'CC',
        documentPayer: '1014275899',
        emailPayer: 'nicolas.suarezv@hotmail.com',
        phonePayer: '3176357660',
        addressPayer: 'CRA 90A 91 60',
        typePersonSelectedPayer: 'N',
        parkSelected: reservationData.park_id,
        serviceParkSelected: 15,
        sport_id: null,
        redirect_url: 'https://portalciudadano.idrd.gov.co/app/pagos/comprobante/',
        ip_address: '179.13.168.147',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return response.data;
  }
}
