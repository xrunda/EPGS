import {
  SoapPacsRisAdapter,
  SoapPacsContractError,
  SoapPacsTransientError,
  mapSoapWireRecordToDto,
} from './soap-pacs-ris-adapter';

const BASE_URL = 'https://pacs-soap.internal.test/imedical/webservice/web.DHCENS.EnsWebService.cls';

/**
 * One DHCWebInterface(W00000206) wire record in its confirmed shape
 * (Chinese field names, live-probed against KeyName=W00000206 - see
 * docs/pacs-ris-adapter.md). Field values here are entirely synthetic.
 */
function syntheticRecord(overrides: Record<string, unknown> = {}) {
  return {
    姓名: '测试患者甲',
    床号: 'TEST-12',
    报告内容: '测试检查所见文本，仅为合成数据。',
    检查号: 'TEST-A-20260821001',
    检查日期: '2026-08-21',
    检查时间: '09:30:00',
    检查项目: '电子胃镜检查',
    登记号: 'TEST-REG-0001',
    科室: '测试科室',
    类型: 'I',
    诊断: '测试诊断意见文本，仅为合成数据。',
    ...overrides,
  };
}

function soapEnvelope(records: unknown[]): string {
  const json = JSON.stringify(records);
  return `<?xml version="1.0" encoding="UTF-8" ?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV='http://schemas.xmlsoap.org/soap/envelope/'>
  <SOAP-ENV:Body><DHCWebInterfaceResponse xmlns="http://tempuri.org"><DHCWebInterfaceResult><![CDATA[${json}]]></DHCWebInterfaceResult></DHCWebInterfaceResponse></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
}

function mockFetch(handler: (input: unknown, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return handler as unknown as typeof fetch;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  } as Response;
}

function buildAdapter(fetchImpl: typeof fetch) {
  return new SoapPacsRisAdapter({
    baseUrl: BASE_URL,
    username: 'test-user',
    password: 'test-pass',
    keyName: 'W00000206',
    fetchImpl,
  });
}

describe('mapSoapWireRecordToDto', () => {
  it('maps a well-formed Chinese-keyed wire record to the internal DTO', () => {
    const dto = mapSoapWireRecordToDto(syntheticRecord());
    expect(dto.sourceRecordId).toBe('TEST-A-20260821001');
    expect(dto.patientName).toBe('测试患者甲');
    expect(dto.department).toBe('测试科室');
    expect(dto.bedNo).toBe('TEST-12');
    expect(dto.patientTypeCode).toBe('I');
    expect(dto.patientTypeName).toBeNull();
    expect(dto.examItem).toBe('电子胃镜检查');
    expect(dto.examDate).toBe('2026-08-21');
    expect(dto.examTimeText).toBe('09:30:00');
    expect(dto.reportContent).toBe('测试检查所见文本，仅为合成数据。');
    expect(dto.diagnosis).toBe('测试诊断意见文本，仅为合成数据。');
    expect(dto.reportId).toBe(dto.sourceRecordId);
  });

  it('maps empty-string fields to null (bedNo, department, etc)', () => {
    const dto = mapSoapWireRecordToDto(syntheticRecord({ 床号: '', 科室: '' }));
    expect(dto.bedNo).toBeNull();
    expect(dto.department).toBeNull();
  });

  it('throws SoapPacsContractError when 检查号 is missing', () => {
    const record = syntheticRecord();
    delete (record as Record<string, unknown>).检查号;
    expect(() => mapSoapWireRecordToDto(record)).toThrow(SoapPacsContractError);
  });

  it('throws SoapPacsContractError when 检查日期 is malformed', () => {
    expect(() => mapSoapWireRecordToDto(syntheticRecord({ 检查日期: 'not-a-date' }))).toThrow(
      SoapPacsContractError,
    );
  });
});

describe('SoapPacsRisAdapter.fetchReports', () => {
  it('parses a JSON array response containing bare CR characters (non-strict JSON)', async () => {
    // Reproduces the confirmed gateway quirk: 报告内容/诊断 contain literal
    // \r bytes inside string values instead of the \r escape sequence,
    // which a strict JSON.parse rejects outright.
    const rawWithBareCr = `[{"姓名":"测试患者甲","床号":"","报告内容":"食道：粘膜光整。\r贲门：齿状线清晰。\r","检查号":"TEST-CR-0001","检查日期":"2026-08-21","检查时间":"09:03:45","检查项目":"电子胃镜检查","登记号":"TEST-REG-0001","科室":"测试科室","类型":"O","诊断":"慢性胃炎\r"}]`;
    const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV='http://schemas.xmlsoap.org/soap/envelope/'>
  <SOAP-ENV:Body><DHCWebInterfaceResponse xmlns="http://tempuri.org"><DHCWebInterfaceResult><![CDATA[${rawWithBareCr}]]></DHCWebInterfaceResult></DHCWebInterfaceResponse></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

    const adapter = buildAdapter(mockFetch(() => textResponse(xml)));
    const result = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      pageSize: 20,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].sourceRecordId).toBe('TEST-CR-0001');
    expect(result.items[0].reportContent).toBe('食道：粘膜光整。\r贲门：齿状线清晰。\r');
    expect(result.items[0].diagnosis).toBe('慢性胃炎\r');
  });

  it('paginates the full-window result in memory via an offset cursor', async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      syntheticRecord({ 检查号: `TEST-PAGE-${i}`, 检查时间: `0${i}:00:00` }),
    );
    const adapter = buildAdapter(mockFetch(() => textResponse(soapEnvelope(records))));

    const page1 = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      pageSize: 2,
    });
    expect(page1.items.map((i) => i.sourceRecordId)).toEqual(['TEST-PAGE-0', 'TEST-PAGE-1']);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      pageSize: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.sourceRecordId)).toEqual(['TEST-PAGE-2', 'TEST-PAGE-3']);
    expect(page2.nextCursor).toBeDefined();

    const page3 = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      pageSize: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((i) => i.sourceRecordId)).toEqual(['TEST-PAGE-4']);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('filters by department after fetching the full window', async () => {
    const records = [
      syntheticRecord({ 检查号: 'TEST-DEPT-A', 科室: '甲科室' }),
      syntheticRecord({ 检查号: 'TEST-DEPT-B', 科室: '乙科室' }),
    ];
    const adapter = buildAdapter(mockFetch(() => textResponse(soapEnvelope(records))));

    const result = await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      department: '乙科室',
      pageSize: 20,
    });
    expect(result.items.map((i) => i.sourceRecordId)).toEqual(['TEST-DEPT-B']);
  });

  it('sends a SOAP envelope with WS-Security credentials and the configured KeyName', async () => {
    let capturedBody = '';
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = buildAdapter(
      mockFetch((_input, init) => {
        capturedBody = String(init?.body ?? '');
        capturedHeaders = init?.headers as Record<string, string> | undefined;
        return textResponse(soapEnvelope([]));
      }),
    );

    await adapter.fetchReports({
      since: new Date('2026-08-21T00:00:00+08:00'),
      until: new Date('2026-08-22T00:00:00+08:00'),
      pageSize: 20,
    });

    expect(capturedBody).toContain('<tem:KeyName>W00000206</tem:KeyName>');
    expect(capturedBody).toContain('<wsse:Username>test-user</wsse:Username>');
    expect(capturedBody).toContain('<wsse:Password');
    expect(capturedBody).toContain('test-pass');
    expect(capturedBody).toContain('2026-08-21^2026-08-22');
    expect(capturedHeaders?.SOAPAction).toContain('DHCWebInterface');
  });

  it('throws SoapPacsTransientError on a non-2xx HTTP status', async () => {
    const adapter = buildAdapter(mockFetch(() => textResponse('Internal Server Error', 500)));
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00+08:00'),
        pageSize: 20,
      }),
    ).rejects.toThrow(SoapPacsTransientError);
  });

  it('throws SoapPacsTransientError on a network error', async () => {
    const adapter = buildAdapter(
      mockFetch(() => Promise.reject(new Error('network unreachable'))),
    );
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00+08:00'),
        pageSize: 20,
      }),
    ).rejects.toThrow(SoapPacsTransientError);
  });

  it('throws SoapPacsContractError when the response has no DHCWebInterfaceResult element', async () => {
    const adapter = buildAdapter(mockFetch(() => textResponse('<SOAP-ENV:Envelope></SOAP-ENV:Envelope>')));
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00+08:00'),
        pageSize: 20,
      }),
    ).rejects.toThrow(SoapPacsContractError);
  });

  it('throws SoapPacsContractError when the CDATA payload is not valid JSON', async () => {
    const xml = `<DHCWebInterfaceResult><![CDATA[not json at all]]></DHCWebInterfaceResult>`;
    const adapter = buildAdapter(mockFetch(() => textResponse(xml)));
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00+08:00'),
        pageSize: 20,
      }),
    ).rejects.toThrow(SoapPacsContractError);
  });

  it('rejects a deviceId filter as unsupported by the confirmed SOAP gateway', async () => {
    const adapter = buildAdapter(mockFetch(() => textResponse(soapEnvelope([]))));
    await expect(
      adapter.fetchReports({
        since: new Date('2026-08-21T00:00:00+08:00'),
        deviceId: 'scope-1',
        pageSize: 20,
      }),
    ).rejects.toThrow('deviceId is not available');
  });
});
