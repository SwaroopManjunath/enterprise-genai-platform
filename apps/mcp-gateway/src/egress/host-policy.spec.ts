import { EgressBlockedError } from '../domain/errors';
import { HostPolicy, isBlockedAddress } from './host-policy';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.5.5.5',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same, in hex form
    '::ffff:169.254.169.254',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111'])(
    'allows the public address %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe('HostPolicy.check', () => {
  const policy = new HostPolicy(['localhost', '127.0.0.1']);

  it('accepts public https', () => {
    expect(policy.check('https://tools.example.com/mcp').hostname).toBe('tools.example.com');
  });

  it.each([
    ['not a url', 'valid URL'],
    ['ftp://tools.example.com/mcp', 'only http and https'],
    ['file:///etc/passwd', 'only http and https'],
    ['https://user:pass@tools.example.com/mcp', 'credentials'],
    ['http://tools.example.com/mcp', 'plain http'],
    ['https://169.254.169.254/latest/meta-data', 'private or reserved'],
    ['https://10.0.0.5/mcp', 'private or reserved'],
    ['https://[::1]/mcp', 'private or reserved'],
    ['https://[::ffff:127.0.0.1]/mcp', 'private or reserved'],
  ])('refuses %s', (url, reason) => {
    expect(() => policy.check(url)).toThrow(EgressBlockedError);
    expect(() => policy.check(url)).toThrow(new RegExp(reason));
  });

  it('allows plain http and private addresses only for explicitly allowed hosts', () => {
    expect(policy.check('http://127.0.0.1:8080/mcp').port).toBe('8080');
    expect(policy.check('http://localhost:8080/mcp').hostname).toBe('localhost');
    expect(() => policy.check('http://127.0.0.2:8080/mcp')).toThrow(EgressBlockedError);
  });
});

describe('HostPolicy.lookup', () => {
  const resolve = (policy: HostPolicy, host: string) =>
    new Promise<{ error: Error | null; address: unknown }>((done) =>
      policy.lookup(host, { all: true }, (error, address) => done({ error, address })),
    );

  it('refuses a name that resolves to a private address, unless the host is allowed', async () => {
    const strict = await resolve(new HostPolicy([]), 'localhost');
    expect(strict.error).toBeInstanceOf(EgressBlockedError);

    const allowed = await resolve(new HostPolicy(['localhost']), 'localhost');
    expect(allowed.error).toBeNull();
  });
});
