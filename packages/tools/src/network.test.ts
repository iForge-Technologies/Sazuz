import { describe, expect, it, vi } from 'vitest';
import {
  createBuiltinTools,
  fetchPublicText,
  isPublicAddress,
  resolvePublicUrl,
  ToolError,
  type ResolvedAddress,
  type SafeNetworkDependencies,
  type SafeNetworkRequest,
  type ToolContext,
} from './index.js';

const publicAddress: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const signal = new AbortController().signal;
const lookup = () => Promise.resolve([publicAddress]);
const response = {
  status: 200,
  headers: { 'content-type': 'text/plain' },
  body: 'Public fixture content.',
};

describe('public network boundary', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.2.2',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    'fc00::1',
    'fe80::1',
    '64:ff9b::a00:1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    'ff02::1',
    '3fff::1',
  ])('denies special-use address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts global unicast address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/file',
    'http://localhost/',
    'http://host.local/',
    'http://metadata.google.internal/',
    'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'https://user:password@example.com/',
    'http://example.com:2375/',
    'https://example.com/#fragment',
  ])('rejects unsafe or ambiguous URL %s before the request', async (url) => {
    const request = vi.fn(() => Promise.resolve(response));
    await expect(fetchPublicText(url, signal, { lookup, request })).rejects.toMatchObject({
      code: 'UNSAFE_URL',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins a single checked public address and never accepts a mixed DNS response', async () => {
    const request = vi.fn((_request: SafeNetworkRequest) => Promise.resolve(response));
    await expect(
      fetchPublicText('https://example.com/resource', signal, { lookup, request }),
    ).resolves.toMatchObject({ text: response.body });
    expect(request.mock.calls[0]![0]).toMatchObject({
      address: publicAddress,
      headers: { 'accept-encoding': 'identity' },
    });
    request.mockClear();
    const mixed = () =>
      Promise.resolve([publicAddress, { address: '127.0.0.1', family: 4 as const }]);
    await expect(
      fetchPublicText('https://example.com/', signal, { lookup: mixed, request }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(request).not.toHaveBeenCalled();
  });

  it('revalidates DNS after redirects and blocks a rebinding destination', async () => {
    let resolutions = 0;
    const rebinding = () =>
      Promise.resolve(
        ++resolutions === 1 ? [publicAddress] : [{ address: '10.0.0.1', family: 4 as const }],
      );
    const request = vi.fn(() =>
      Promise.resolve({ ...response, status: 302, headers: { location: '/next' } }),
    );
    await expect(
      fetchPublicText('https://example.com/', signal, { lookup: rebinding, request }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolutions).toBe(2);
  });

  it('rejects private redirect URLs and limits a redirect cycle', async () => {
    const redirected = () =>
      Promise.resolve({
        ...response,
        status: 302,
        headers: { location: 'http://169.254.169.254/' },
      });
    await expect(
      fetchPublicText('https://example.com/', signal, { lookup, request: redirected }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    const request = vi.fn(() =>
      Promise.resolve({ ...response, status: 302, headers: { location: '/again' } }),
    );
    await expect(
      fetchPublicText('https://example.com/', signal, { lookup, request }),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('applies the explicit egress allowlist to every destination', async () => {
    await expect(
      resolvePublicUrl('https://example.com/', { lookup, allowedHosts: [] }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    await expect(
      resolvePublicUrl('https://example.com/', { lookup, allowedHosts: ['EXAMPLE.COM'] }),
    ).resolves.toMatchObject({ address: publicAddress });
    await expect(
      resolvePublicUrl('https://sub.example.com/', { lookup, allowedHosts: ['example.com'] }),
    ).rejects.toMatchObject({ code: 'UNSAFE_URL' });
  });

  it('bounds byte size, rejects binary responses and suppresses transport error details', async () => {
    await expect(
      fetchPublicText('https://example.com/', signal, {
        lookup,
        maxResponseBytes: 3,
        request: () => Promise.resolve({ ...response, body: 'ああ' }),
      }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    await expect(
      fetchPublicText('https://example.com/', signal, {
        lookup,
        request: () => Promise.resolve({ ...response, headers: { 'content-type': 'image/png' } }),
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    await expect(
      fetchPublicText('https://example.com/', signal, {
        lookup,
        request: () => Promise.reject(new Error('Authorization: private-value')),
      }),
    ).rejects.toEqual(new ToolError('NETWORK_FAILED'));
  });

  it('cancels a slow DNS lookup at the configured deadline', async () => {
    const network: SafeNetworkDependencies = {
      timeoutMs: 10,
      lookup: () => new Promise(() => undefined),
    };
    await expect(fetchPublicText('https://example.com/', signal, network)).rejects.toMatchObject({
      code: 'TOOL_ABORTED',
    });
  });
});

describe('official search and external trust', () => {
  const context: ToolContext = {
    workspaceDir: '/unused',
    projectId: 'project-a',
    runId: 'run-a',
    agentId: 'researcher',
    idempotencyKey: 'call-a',
    signal,
  };
  const tools = createBuiltinTools();

  it('uses the official MediaWiki endpoint, validates its result and names the restricted search source', async () => {
    const request = vi.fn((_request: SafeNetworkRequest) =>
      Promise.resolve({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: {
            search: [
              {
                pageid: 123,
                title: 'Robot',
                snippet: 'A <span class="searchmatch">robot</span> &amp; its controller.',
              },
            ],
          },
        }),
      }),
    );
    const result = await tools.execute(
      'web.search',
      { ...context, network: { lookup, request } },
      { query: 'robot', limit: 1 },
    );
    expect(request.mock.calls[0]![0].url).toEqual(
      new URL(
        'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=robot&srlimit=1&format=json&utf8=1',
      ),
    );
    expect(result).toEqual({
      untrusted: true,
      output: {
        source: 'Wikipedia encyclopedia search (MediaWiki Action API)',
        results: [
          {
            title: 'Robot',
            url: 'https://en.wikipedia.org/?curid=123',
            snippet: 'A robot & its controller.',
          },
        ],
      },
    });
  });

  it('supports a trusted configured official provider and validates its output boundary', async () => {
    const search = vi.fn(() =>
      Promise.resolve({
        source: 'Fixture official search',
        results: [{ title: 'Result', url: 'https://example.com/', snippet: 'Text' }],
      }),
    );
    await expect(
      tools.execute('web.search', { ...context, search: { search } }, { query: 'test' }),
    ).resolves.toMatchObject({ untrusted: true, output: { source: 'Fixture official search' } });
    expect(search).toHaveBeenCalledWith(
      'test',
      5,
      expect.objectContaining({ projectId: 'project-a' }),
    );
    await expect(
      tools.execute(
        'web.search',
        {
          ...context,
          search: {
            search: () =>
              Promise.resolve({
                source: 'Fixture',
                results: [{ title: 'Unsafe', url: 'file:///etc/passwd', snippet: '' }],
              }),
          },
        },
        { query: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' });
  });

  it('marks fetched text untrusted and rejects unexpected JSON from search', async () => {
    await expect(
      tools.execute(
        'web.fetch',
        { ...context, network: { lookup, request: () => Promise.resolve(response) } },
        { url: 'https://example.com/' },
      ),
    ).resolves.toMatchObject({ untrusted: true, output: { text: response.body } });
    await expect(
      tools.execute(
        'web.search',
        {
          ...context,
          network: {
            lookup,
            request: () => Promise.resolve({ ...response, body: '{"unexpected":true}' }),
          },
        },
        { query: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TOOL_RESULT' });
  });
});
