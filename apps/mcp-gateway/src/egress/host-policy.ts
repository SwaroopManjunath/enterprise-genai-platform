import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { EgressBlockedError } from '../domain/errors';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata address 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** The IPv4 address hidden inside an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`), if any. */
function embeddedIpv4(address: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex) {
    const high = parseInt(hex[1] as string, 16);
    const low = parseInt(hex[2] as string, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return undefined;
}

/** True for loopback, private, link-local (cloud metadata), multicast and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all: refuse rather than guess
  const mapped = family === 6 ? embeddedIpv4(address) : undefined;
  if (mapped) return blocked.check(mapped, 'ipv4');
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * Decides where the gateway may connect. MCP servers are registered by tenant admins, so the URL
 * is attacker-influenced input: without a policy it is a way to make the gateway call internal
 * services or the cloud metadata endpoint (server-side request forgery).
 *
 *  - only http and https, no credentials in the URL;
 *  - plain http, and addresses in private ranges, only for hosts in the explicit allow list;
 *  - for a name, EVERY address it resolves to is checked at connect time (not just at
 *    registration), which closes the DNS-rebinding trick of resolving to a public address first
 *    and an internal one later.
 */
export class HostPolicy {
  private readonly allowed: ReadonlySet<string>;

  constructor(allowedHosts: readonly string[]) {
    this.allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  }

  /** Validates the URL syntax and literal addresses. Names are checked when connecting. */
  check(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressBlockedError('not a valid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new EgressBlockedError('only http and https are supported');
    }
    if (url.username || url.password) throw new EgressBlockedError('credentials in the URL');

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isAllowed = this.allowed.has(host);
    if (url.protocol === 'http:' && !isAllowed) {
      throw new EgressBlockedError('plain http is only allowed for explicitly allowed hosts');
    }
    if (isIP(host) !== 0 && !isAllowed && isBlockedAddress(host)) {
      throw new EgressBlockedError('private or reserved address');
    }
    return url;
  }

  /** A `lookup` for http(s).request: resolves a name and refuses it if any address is blocked. */
  readonly lookup = (
    hostname: string,
    options: dns.LookupOptions,
    callback: LookupCallback,
  ): void => {
    const allowed = this.allowed.has(hostname.toLowerCase());
    dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error, '');
      if (!allowed && addresses.some((a) => isBlockedAddress(a.address))) {
        return callback(
          Object.assign(new EgressBlockedError('resolves to a private or reserved address'), {
            code: 'EGRESS_BLOCKED',
          }) as NodeJS.ErrnoException,
          '',
        );
      }
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error('no address') as NodeJS.ErrnoException, '');
      return callback(null, first.address, first.family);
    });
  };
}
