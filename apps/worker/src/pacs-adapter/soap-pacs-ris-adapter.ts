import { Injectable, Logger } from '@nestjs/common';
import { Agent, Dispatcher } from 'undici';
import { FetchReportsParams, FetchReportsResult, PacsReportDto } from '@epgs/shared-types';
import { mapWireReportToDto } from './http-pacs-ris-adapter';
import { PacsRisAdapter } from './pacs-ris-adapter.interface';

const MAX_PAGE_SIZE = 500;

/** Default per-request timeout when PACS_SOAP_TIMEOUT_MS is not set. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Options for constructing SoapPacsRisAdapter. Values are read from
 * environment variables by the DI provider (pacs-adapter.module.ts) -
 * never hardcoded, never logged (the password especially).
 */
export interface SoapPacsRisAdapterOptions {
  /** e.g. "https://10.10.13.199:1443/imedical/webservice/web.DHCENS.EnsWebService.cls" */
  baseUrl: string;
  /** WS-Security UsernameToken username. */
  username: string;
  /** WS-Security UsernameToken password. NEVER logged or included in thrown error messages. */
  password: string;
  /** The DHCWebInterface `KeyName` that selects the endoscopy report query. */
  keyName: string;
  /** Per-request timeout in ms. Defaults to 15000 (SOAP gateway is slower than the REST contract). */
  timeoutMs?: number;
  /** Injectable fetch implementation, for testing. Defaults to global fetch (Node 24 native). */
  fetchImpl?: typeof fetch;
  /** Skips TLS certificate verification (for internal gateways using self-signed certs). */
  tlsInsecure?: boolean;
}

/** Raised when the gateway is unreachable, times out, or returns a non-2xx HTTP status. */
export class SoapPacsTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoapPacsTransientError';
  }
}

/**
 * Raised when the gateway returns HTTP 200 but the SOAP/JSON payload does
 * not match the confirmed shape (missing envelope, malformed JSON, a
 * record missing a required field, etc). Not retryable as-is - the sync
 * job should record it and fail the batch rather than silently skipping
 * data.
 */
export class SoapPacsContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoapPacsContractError';
  }
}

/** Wire field names as returned by the DHCWebInterface(W00000206) query - Chinese, not English. */
interface SoapWireRecord {
  姓名?: unknown;
  床号?: unknown;
  报告内容?: unknown;
  检查号?: unknown;
  检查日期?: unknown;
  检查时间?: unknown;
  检查项目?: unknown;
  登记号?: unknown;
  科室?: unknown;
  类型?: unknown;
  诊断?: unknown;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEnvelope(username: string, password: string, keyName: string, inputParameter: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soapenv:Header>
    <wsse:Security soapenv:mustUnderstand="1">
      <wsse:UsernameToken>
        <wsse:Username>${xmlEscape(username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xmlEscape(password)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
  </soapenv:Header>
  <soapenv:Body>
    <tem:DHCWebInterface>
      <tem:KeyName>${xmlEscape(keyName)}</tem:KeyName>
      <tem:InputParameter>${xmlEscape(inputParameter)}</tem:InputParameter>
    </tem:DHCWebInterface>
  </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Extracts the `DHCWebInterfaceResult` CDATA payload from the SOAP
 * response envelope. A tiny regex is used instead of a full XML parser
 * because the gateway's response shape is a single fixed element with no
 * nesting/attributes to worry about - see docs/pacs-ris-adapter.md for
 * the confirmed sample envelope.
 */
function extractCdataResult(xml: string): string {
  const match = /<DHCWebInterfaceResult>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/DHCWebInterfaceResult>/.exec(xml);
  if (!match) {
    // Some gateway responses omit CDATA and inline the JSON directly.
    const inline = /<DHCWebInterfaceResult>([\s\S]*?)<\/DHCWebInterfaceResult>/.exec(xml);
    if (!inline) {
      throw new SoapPacsContractError('SOAP response missing DHCWebInterfaceResult element');
    }
    return inline[1];
  }
  return match[1];
}

/**
 * The gateway's JSON payload embeds raw control characters (literal CR)
 * inside string values instead of the `\r` escape sequence, which
 * violates strict JSON and makes `JSON.parse` throw. This escapes bare
 * control characters that appear inside string literals so the payload
 * becomes valid JSON, without touching already-escaped sequences.
 */
function sanitizeEmbeddedControlChars(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (const ch of raw) {
    if (inString) {
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        result += ch;
        inString = false;
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
      result += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
    }
    result += ch;
  }
  return result;
}

function parseWirePayload(cdata: string): SoapWireRecord[] {
  const sanitized = sanitizeEmbeddedControlChars(cdata.trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(sanitized);
  } catch (err) {
    throw new SoapPacsContractError(
      `DHCWebInterfaceResult is not valid JSON after sanitization: ${err instanceof Error ? err.message : 'parse error'}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SoapPacsContractError('DHCWebInterfaceResult JSON is not an array');
  }
  return parsed as SoapWireRecord[];
}

function emptyAsNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new SoapPacsContractError('Wire field is not a string');
  }
  return value === '' ? null : value;
}

function requireWireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SoapPacsContractError(`Wire field ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Maps one 检查号/姓名/... wire record (Chinese field names, per the
 * confirmed DHCWebInterface(W00000206) sample) to the internal
 * PacsReportDto, reusing the exact same contract mapper the HTTP/CSV
 * adapters use once translated to the shared English field names.
 */
export function mapSoapWireRecordToDto(raw: SoapWireRecord): PacsReportDto {
  const wireRecord = {
    sourceRecordId: requireWireString(raw.检查号, '检查号'),
    patientRegistrationNo: emptyAsNull(raw.登记号),
    patientName: emptyAsNull(raw.姓名),
    department: emptyAsNull(raw.科室),
    bedNo: emptyAsNull(raw.床号),
    patientTypeCode: emptyAsNull(raw.类型),
    // The source dictionary for 类型 (I/O) is not yet confirmed - do not
    // guess a Chinese label from the raw code (see docs/api/pacs-ris-data-api.md §7).
    patientTypeName: null,
    examItem: emptyAsNull(raw.检查项目),
    examDate: requireWireString(raw.检查日期, '检查日期'),
    examTime: emptyAsNull(raw.检查时间),
    reportContent: emptyAsNull(raw.报告内容),
    diagnosis: emptyAsNull(raw.诊断),
  };
  try {
    return mapWireReportToDto(wireRecord);
  } catch (err) {
    throw new SoapPacsContractError(
      `SOAP record ${wireRecord.sourceRecordId} violates the PACS/RIS API contract: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

function toShanghaiDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^offset:(\d+)$/.exec(decoded);
  if (!match) throw new SoapPacsContractError('fetchReports: invalid cursor');
  return Number(match[1]);
}

/**
 * PacsRisAdapter implementation for the hospital's DHC/InterSystems
 * Ensemble `EnsWebService` SOAP gateway (confirmed by a live probe against
 * KeyName=W00000206 - see docs/pacs-ris-adapter.md).
 *
 * Unlike the #24 REST contract this gateway has no native pagination: one
 * call returns every record in the requested date range as a single JSON
 * array embedded in the SOAP response. So this adapter fetches the whole
 * window once per distinct [since, until) range and paginates the result
 * in memory, mirroring CsvPacsRisAdapter's offset-cursor approach.
 *
 * Error handling:
 * - Network failure / timeout / non-2xx HTTP status -> SoapPacsTransientError
 *   (retryable by the sync job's backoff logic).
 * - 200 with a body that fails contract validation (missing envelope,
 *   invalid JSON, missing required field) -> SoapPacsContractError
 *   (not retryable as-is).
 *
 * This adapter never logs the password or full response body - only
 * request metadata (date range, record count, elapsed ms).
 */
@Injectable()
export class SoapPacsRisAdapter implements PacsRisAdapter {
  private readonly logger = new Logger(SoapPacsRisAdapter.name);
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly keyName: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcher?: Dispatcher;

  constructor(options: SoapPacsRisAdapterOptions) {
    this.baseUrl = options.baseUrl;
    this.username = options.username;
    this.password = options.password;
    this.keyName = options.keyName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dispatcher = options.tlsInsecure
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    if (!params.since) {
      throw new Error('fetchReports: params.since is required');
    }
    if (!params.pageSize || params.pageSize <= 0) {
      throw new Error('fetchReports: params.pageSize must be a positive integer');
    }
    if (params.deviceId) {
      throw new Error('fetchReports: deviceId is not available in the confirmed SOAP gateway');
    }
    const pageSize = Math.min(params.pageSize, MAX_PAGE_SIZE);
    const until = params.until ?? new Date();

    const records = await this.fetchWindow(params.since, until);
    const filtered = records
      .filter((record) => !params.department || record.department === params.department)
      .sort((left, right) => {
        const diff = left.examTime.getTime() - right.examTime.getTime();
        return diff || left.sourceRecordId.localeCompare(right.sourceRecordId);
      });

    const offset = decodeCursor(params.cursor);
    const items = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;

    return {
      items,
      nextCursor: nextOffset < filtered.length ? encodeCursor(nextOffset) : undefined,
    };
  }

  /** Fetches every record whose 检查日期 falls in [since, until], via one DHCWebInterface call. */
  private async fetchWindow(since: Date, until: Date): Promise<PacsReportDto[]> {
    const inputParameter = `${toShanghaiDate(since)}^${toShanghaiDate(until)}`;
    const envelope = buildEnvelope(this.username, this.password, this.keyName, inputParameter);

    const startedAt = Date.now();
    const responseXml = await this.request(envelope);
    const elapsedMs = Date.now() - startedAt;

    const cdata = extractCdataResult(responseXml);
    const wireRecords = parseWirePayload(cdata);
    const items = wireRecords.map(mapSoapWireRecordToDto);

    this.logger.debug(
      `fetchWindow ok range=${inputParameter} items=${items.length} elapsedMs=${elapsedMs}`,
    );

    return items;
  }

  private async request(envelope: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '"http://tempuri.org/web.DHCENS.EnsWebService.DHCWebInterface"',
        },
        body: envelope,
        signal: controller.signal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit);
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? `PACS/RIS SOAP gateway request timed out after ${this.timeoutMs}ms`
        : `PACS/RIS SOAP gateway request failed: ${err instanceof Error ? err.message : 'unknown network error'}`;
      this.logger.warn(`fetchWindow network error: ${message}`);
      throw new SoapPacsTransientError(message);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    if (!response.ok) {
      this.logger.warn(`fetchWindow HTTP error status=${response.status}`);
      throw new SoapPacsTransientError(`PACS/RIS SOAP gateway returned HTTP ${response.status}`);
    }
    return text;
  }
}
