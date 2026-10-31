'use strict';

const {
  CourierProviderError,
  COURIER_PROVIDER_ERROR_CODES,
} = require('../courier.errors');

/**
 * Thin OAuth2 + HTTP client for the Pathao Courier Merchant API
 * (Phase 09, ADR-0017).
 *
 * Endpoints (verified against the public sandbox 2026-08-08):
 *   POST /aladdin/api/v1/issue-token                 → OAuth2 access_token
 *   POST /aladdin/api/v1/orders                      → create consignment
 *   GET  /aladdin/api/v1/orders/{consignmentId}      → full order status
 *   POST /aladdin/api/v1/orders/{consignmentId}/cancel → cancel (best-effort)
 *
 * Error classification:
 *   - network / timeout / non-JSON / 5xx  → PROVIDER_UNAVAILABLE (retryable)
 *   - 4xx / provider `error:true` payload → PROVIDER_REJECTED (config/payload)
 *
 * Token lifecycle: OAuth2 bearer fetched lazily, cached until near expiry,
 * refreshed automatically and retried once on a 401.
 *
 * Configuration validation is DEFERRED to the first call (per the provider
 * interface contract) so application boot never fails on missing credentials.
 */
class PathaoClient {
  constructor({
    baseUrl,
    clientId,
    clientSecret,
    username,
    password,
    timeoutMs = 15000,
    fetchImpl = fetch,
    now = Date.now,
  }) {
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.token = null;
  }

  assertConfigured(fields = {}) {
    const required = {
      baseUrl: this.baseUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      username: this.username,
      password: this.password,
      ...fields,
    };
    const missing = Object.entries(required)
      .filter(([, value]) => value === undefined || value === null || value === '')
      .map(([key]) => key.toUpperCase());
    if (missing.length > 0) {
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.NOT_CONFIGURED,
        `Pathao courier is not configured (missing: ${missing.join(', ')}). See .env.example.`
      );
    }
  }

  async request({ method, path, body, headers = {} }) {
    this.assertConfigured();
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = Boolean(err && err.name === 'AbortError');
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
        aborted
          ? `Pathao request timed out after ${this.timeoutMs}ms`
          : `Pathao request failed: ${err.message}`,
        { raw: err }
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (response.status >= 200 && response.status < 300) {
      return { status: response.status, data: json };
    }

    const raw = json || { status: response.status };
    const message =
      raw && (raw.message || raw.error)
        ? String(raw.message || raw.error)
        : `Pathao returned HTTP ${response.status}`;
    throw new CourierProviderError(
      response.status >= 500
        ? COURIER_PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE
        : COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
      message,
      { raw }
    );
  }

  /**
   * Rejects response payloads that carry Pathao's `error: true` flag even
   * though the HTTP status is 2xx (the sandbox cancel endpoint does this).
   */
  assertSuccessPayload(json, context) {
    if (json && json.error === true) {
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        `Pathao ${context} failed: ${json.message || 'unknown error'}`,
        { raw: json }
      );
    }
  }

  async issueToken() {
    const { data } = await this.request({
      method: 'POST',
      path: '/aladdin/api/v1/issue-token',
      body: {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        username: this.username,
        password: this.password,
        grant_type: 'password',
      },
    });
    const accessToken = data && (data.access_token || data.accessToken);
    if (!accessToken) {
      throw new CourierProviderError(
        COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED,
        'Pathao did not return an access token',
        { raw: data }
      );
    }
    const expiresIn = Number(data.expires_in) || 3600;
    this.token = { accessToken, expiresAt: this.now() + expiresIn * 1000 };
    return this.token;
  }

  async getToken() {
    // Refresh ~60s before expiry to avoid mid-flight expirations.
    if (this.token && this.token.expiresAt > this.now() + 60_000) {
      return this.token.accessToken;
    }
    await this.issueToken();
    return this.token.accessToken;
  }

  async authedRequest({ method, path, body }) {
    let token = await this.getToken();
    try {
      return await this.request({
        method,
        path,
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      const isAuthFailure =
        err instanceof CourierProviderError &&
        err.code === COURIER_PROVIDER_ERROR_CODES.PROVIDER_REJECTED &&
        err.raw &&
        err.raw.status === 401;
      if (isAuthFailure) {
        this.token = null;
        token = await this.getToken();
        return this.request({
          method,
          path,
          body,
          headers: { Authorization: `Bearer ${token}` },
        });
      }
      throw err;
    }
  }

  async createOrder(payload) {
    const { data } = await this.authedRequest({
      method: 'POST',
      path: '/aladdin/api/v1/orders',
      body: payload,
    });
    this.assertSuccessPayload(data, 'create order');
    return data;
  }

  async getOrderStatus(consignmentId) {
    const { data } = await this.authedRequest({
      method: 'GET',
      path: `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}`,
    });
    this.assertSuccessPayload(data, 'order status');
    return data;
  }

  async cancelOrder(consignmentId) {
    const { data } = await this.authedRequest({
      method: 'POST',
      path: `/aladdin/api/v1/orders/${encodeURIComponent(consignmentId)}/cancel`,
      body: {},
    });
    this.assertSuccessPayload(data, 'cancel order');
    return data;
  }
}

module.exports = { PathaoClient };
