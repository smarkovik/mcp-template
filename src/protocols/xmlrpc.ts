import type { InboundResult } from '../transform/inbound.js';
import type { ToolDefinition } from '../types.js';
import type { RestResponse } from './rest.js';

// ---------------------------------------------------------------------------
// XML builder
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function valueToXml(value: unknown): string {
  if (value === null || value === undefined) return '<value><nil/></value>';
  if (typeof value === 'boolean') return `<value><boolean>${value ? '1' : '0'}</boolean></value>`;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
    return `<value><double>${value}</double></value>`;
  }
  if (typeof value === 'string') return `<value><string>${escapeXml(value)}</string></value>`;
  if (Array.isArray(value)) {
    const items = value.map((v) => `<data>${valueToXml(v)}</data>`).join('');
    return `<value><array><data>${items}</data></array></value>`;
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `<member><name>${escapeXml(k)}</name>${valueToXml(v)}</member>`)
      .join('');
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(value))}</string></value>`;
}

function buildMethodCall(methodName: string, params: unknown[]): string {
  const paramsXml = params
    .map((p) => `<param>${valueToXml(p)}</param>`)
    .join('');
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(methodName)}</methodName><params>${paramsXml}</params></methodCall>`;
}

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

function parseValue(node: Element): unknown {
  const child = node.firstElementChild;
  if (!child) return node.textContent ?? '';

  switch (child.tagName) {
    case 'string': return child.textContent ?? '';
    case 'int':
    case 'i4':
    case 'i8': return parseInt(child.textContent ?? '0', 10);
    case 'double': return parseFloat(child.textContent ?? '0');
    case 'boolean': return child.textContent?.trim() === '1';
    case 'nil': return null;
    case 'base64': return Buffer.from(child.textContent ?? '', 'base64').toString('utf-8');
    case 'dateTime.iso8601': return child.textContent ?? '';
    case 'array': {
      const dataNode = child.querySelector('data');
      if (!dataNode) return [];
      return Array.from(dataNode.children)
        .filter((c) => c.tagName === 'value')
        .map(parseValue);
    }
    case 'struct': {
      const obj: Record<string, unknown> = {};
      for (const member of Array.from(child.children)) {
        if (member.tagName !== 'member') continue;
        const nameEl = member.querySelector('name');
        const valueEl = member.querySelector('value');
        if (nameEl && valueEl) {
          obj[nameEl.textContent ?? ''] = parseValue(valueEl);
        }
      }
      return obj;
    }
    default:
      return child.textContent ?? '';
  }
}

function parseMethodResponse(xml: string): { fault: boolean; value: unknown } {
  // Use a lightweight DOMParser-compatible approach for Node.js
  // Node 20+ has a global DOMParser (via jsdom or --experimental-vm-modules), but
  // for reliability we use a regex-based parser for the simple structures we expect.
  // Full XML parsing is handled by the DOMParser polyfill below.
  let doc: Document;
  try {
    // Node 18+ supports DOMParser natively with the --experimental-vm-modules flag.
    // In Lambda (Node 20) it is not available. We use a minimal regex approach.
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    // DOMParser not available — fall back to regex extraction
    return parseWithRegex(xml);
  }

  const faultEl = doc.querySelector('fault');
  if (faultEl) {
    const valueEl = faultEl.querySelector('value');
    return { fault: true, value: valueEl ? parseValue(valueEl) : {} };
  }

  const paramEl = doc.querySelector('params > param > value');
  return { fault: false, value: paramEl ? parseValue(paramEl) : {} };
}

/** Minimal regex-based fallback for environments without DOMParser */
function parseWithRegex(xml: string): { fault: boolean; value: unknown } {
  // Detect fault
  if (/<fault>/i.test(xml)) {
    const faultString = xml.match(/<faultString>\s*<string>([^<]*)<\/string>/)?.[1] ?? 'XML-RPC fault';
    const faultCode = parseInt(xml.match(/<faultCode>\s*<int>(\d+)<\/int>/)?.[1] ?? '0', 10);
    return { fault: true, value: { faultString, faultCode } };
  }
  // Try to extract a simple struct from params
  const structMatch = xml.match(/<struct>([\s\S]*?)<\/struct>/);
  if (!structMatch) return { fault: false, value: {} };

  const obj: Record<string, unknown> = {};
  const memberRe = /<member>\s*<name>([^<]+)<\/name>\s*<value>\s*(?:<(\w+)>([^<]*)<\/\w+>|([^<]*))\s*<\/value>\s*<\/member>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRe.exec(structMatch[1]!)) !== null) {
    const key = m[1]!;
    const tag = m[2];
    const rawVal = m[3] ?? m[4] ?? '';
    let val: unknown = rawVal;
    if (tag === 'int' || tag === 'i4') val = parseInt(rawVal, 10);
    else if (tag === 'double') val = parseFloat(rawVal);
    else if (tag === 'boolean') val = rawVal.trim() === '1';
    obj[key] = val;
  }
  return { fault: false, value: obj };
}

// ---------------------------------------------------------------------------
// Main caller
// ---------------------------------------------------------------------------

export async function callXmlRpc(
  inbound: InboundResult,
  tool: ToolDefinition,
  timeoutMs: number
): Promise<RestResponse> {
  const methodName = tool.xmlrpc_method!;
  const params = inbound.xmlrpcParams ?? [];
  const xmlBody = buildMethodCall(methodName, params);

  const headers: Record<string, string> = {
    ...inbound.headers,
    'Content-Type': 'text/xml; charset=utf-8',
    'User-Agent': 'mcp-proxy/1.0',
  };

  let response: Response;
  try {
    response = await fetch(inbound.url, {
      method: 'POST',
      headers,
      body: xmlBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw Object.assign(new Error(`TIMEOUT: XML-RPC request to ${tool.endpoint} timed out after ${timeoutMs}ms`), {
        code: 'TIMEOUT',
      });
    }
    throw Object.assign(new Error(`UPSTREAM_ERROR: ${err instanceof Error ? err.message : String(err)}`), {
      code: 'UPSTREAM_ERROR',
    });
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => { responseHeaders[k] = v; });

  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(
      new Error(`UPSTREAM_ERROR: XML-RPC endpoint returned ${response.status}`),
      {
        code: 'UPSTREAM_ERROR',
        upstream_status: response.status,
        upstream_body: { _raw: text },
      }
    );
  }

  const xmlText = await response.text();
  const parsed = parseMethodResponse(xmlText);

  if (parsed.fault) {
    const fault = parsed.value as Record<string, unknown>;
    throw Object.assign(
      new Error(`XMLRPC_FAULT: ${fault['faultString'] ?? 'Unknown fault'} (code: ${fault['faultCode'] ?? 0})`),
      {
        code: 'XMLRPC_FAULT',
        upstream_status: response.status,
        upstream_body: fault,
      }
    );
  }

  const body =
    parsed.value !== null && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, unknown>)
      : { _value: parsed.value };

  return { body, headers: responseHeaders, status: response.status };
}
