import { promises as dns } from 'node:dns';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

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
  await assertPublicHost(url.hostname.replace(/^\[|\]$/g, ''));
}

/**
 * The host half of the check, for a connection that is not HTTP (an
 * IMAP session over TLS): every address the name resolves to must be
 * public.
 */
export async function assertPublicHost(host: string): Promise<void> {
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

/**
 * The IANA special-purpose address registries (RFC 6890 and successors):
 * every block that is not globally reachable, or is documentation,
 * benchmarking, multicast or reserved space. The hand-written list this
 * replaces had six IPv4 ranges and missed carrier-grade NAT (100.64/10),
 * benchmarking (198.18/15), multicast and reserved space, NAT64 and 6to4.
 */
const SPECIAL_PURPOSE = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv6');
  }
  return list;
})();

function isBlockedIPv4(ip: string): boolean {
  if (!isIPv4(ip)) return true; // unparseable → fail closed
  return SPECIAL_PURPOSE.check(ip, 'ipv4');
}

/**
 * IPv6, plus the IPv4 an address carries: IPv4-mapped (::ffff:0:0/96),
 * NAT64 (64:ff9b::/96, 64:ff9b:1::/48) and 6to4 (2002::/16) all reach an
 * IPv4 host, so they are judged by that host.
 */
function isBlockedIPv6(ip: string): boolean {
  const bare = ip.toLowerCase().split('%')[0] ?? '';
  if (!isIPv6(bare)) return true; // unparseable → fail closed
  const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIPv4(mapped[1] ?? '');
  const embedded = embeddedIPv4(bare);
  if (embedded !== null) return isBlockedIPv4(embedded);
  return SPECIAL_PURPOSE.check(bare, 'ipv6');
}

/** The IPv4 inside a NAT64 or 6to4 address, or null. */
function embeddedIPv4(ip: string): string | null {
  const words = expandIPv6(ip);
  if (!words) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  if (words[0] === 0x64 && words[1] === 0xff9b) return v4(words[6]!, words[7]!);
  if (words[0] === 0x2002) return v4(words[1]!, words[2]!);
  return null;
}

/** The eight 16-bit words of an IPv6 address (no embedded dotted quad), or null. */
function expandIPv6(ip: string): number[] | null {
  if (ip.includes('.')) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = ip.includes('::') ? 8 - h.length - t.length : 0;
  const words = [...h, ...Array<string>(fill).fill('0'), ...t].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w)) ? words : null;
}
