import { promises as dns } from 'node:dns';

/**
 * SSRF fence for operator-supplied outbound URLs (pack-declared external
 * MCP tool endpoints). Pure module — no Nest, no config; callers pass
 * `allowHttp` from their own flag.
 *
 * The check resolves the host and rejects when ANY address is
 * loopback / private / link-local / ULA / unspecified — which covers the
 * cloud metadata endpoint (169.254.169.254). Known limitation (stated in
 * docs/mcp-pack-tools.md): the address is not pinned between this check
 * and the subsequent fetch, so a fast-flux DNS rebind is a residual
 * risk; the check runs at install time AND per call to narrow the window.
 */
export class EgressDeniedError extends Error {}

export async function assertPublicHttpUrl(
  rawUrl: string,
  opts: { allowHttp?: boolean } = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressDeniedError(`"${rawUrl}" is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EgressDeniedError(`endpoint "${rawUrl}" must use http(s), got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new EgressDeniedError(`endpoint must not embed credentials in the URL`);
  }
  if (opts.allowHttp) {
    // Dev/test escape hatch (MCP_PACK_TOOLS_ALLOW_HTTP): permits plain
    // http AND loopback/private targets so a local endpoint is testable.
    // Never enable in production — it disables the SSRF fence entirely.
    return;
  }
  if (url.protocol !== 'https:') {
    throw new EgressDeniedError(`endpoint "${rawUrl}" must use https`);
  }
  // URL keeps IPv6 literals bracketed ("[::1]") — strip for lookup.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new EgressDeniedError(`cannot resolve endpoint host "${host}"`);
  }
  for (const { address, family } of addrs) {
    const blocked = family === 6 ? isBlockedIPv6(address) : isBlockedIPv4(address);
    if (blocked) {
      throw new EgressDeniedError(
        `endpoint host "${host}" resolves to a non-public address (${address})`,
      );
    }
  }
}

/** 0/8 (unspecified), 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16. */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable → fail closed
  }
  const [a, b] = parts;
  if (a === undefined || b === undefined) return true; // fail closed
  return (
    a === 0 ||
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** ::, ::1, fc00::/7 (ULA), fe80::/10 (link-local), IPv4-mapped. */
function isBlockedIPv6(ip: string): boolean {
  const bare = ip.toLowerCase().split('%')[0] ?? '';
  if (bare === '::' || bare === '::1') return true;
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1] ?? ''); // '' → parts≠4 → blocked
  const first = parseInt(bare.split(':')[0] || '0', 16);
  if (!Number.isFinite(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  return false;
}
