/**
 * The SSRF fence judges every resolved address against the IANA
 * special-purpose registries (RFC 6890). The list it replaced missed
 * carrier-grade NAT, benchmarking, multicast and reserved space, and the
 * IPv6 forms that reach an IPv4 host (NAT64, 6to4). Literal addresses
 * resolve to themselves, so no network is involved.
 */
import { EgressDeniedError, assertPublicHost } from '../src/common/egress-guard';

describe('egress guard — special-purpose addresses', () => {
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.5.4',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:a9fe:a9fe::1',
    '2001:db8::1',
    'fd00::1',
    'fe80::1',
    'ff02::1',
  ])('refuses %s', async (addr) => {
    await expect(assertPublicHost(addr)).rejects.toThrow(EgressDeniedError);
  });

  it.each(['93.184.215.14', '2606:4700::6810:85e5', '64:ff9b::5db8:d70e', '2002:5db8:d70e::1'])(
    'admits %s',
    async (addr) => {
      await expect(assertPublicHost(addr)).resolves.toBeUndefined();
    },
  );
});
