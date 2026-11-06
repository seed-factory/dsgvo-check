/**
 * Fake authoritative DNS (dns2, UDP on 127.0.0.1:<random>). Zone keys are `"<TYPE> <name>"`; values are TXT strings
 * (an array of chunks = one multi-string record), MX `"<prio> <exchange>"`, A, an rcode or `DROP` (never answer).
 * `"CNAME <name>": ["<target>"]` answers any type at `<name>` as a recursive resolver does: the CNAME followed by the
 * target's records, NXDOMAIN when the target does not exist (a dangling CNAME).
 */
import dns2 from 'dns2';
import type { NetworkConfig } from '../../../src/core/url/net.ts';

const { Packet } = dns2;

export type FakeZoneValue =
  | ReadonlyArray<string | readonly string[]>
  | 'SERVFAIL'
  | 'REFUSED'
  | 'NXDOMAIN'
  | 'DROP';
export type FakeZone = Record<string, FakeZoneValue>;

export interface FakeDnsServer {
  port: number;
  server: string;
  /** Every question received over UDP or TCP, as `"<TYPE> <name>"`; a truncated answer's TCP retry counts again. */
  requests: string[];
  setZone(zone: FakeZone): void;
  close(): Promise<void>;
}

const TYPE_NAMES: Record<number, string> = {
  [Packet.TYPE.A]: 'A',
  [Packet.TYPE.AAAA]: 'AAAA',
  [Packet.TYPE.CNAME]: 'CNAME',
  [Packet.TYPE.MX]: 'MX',
  [Packet.TYPE.TXT]: 'TXT',
};
const RCODES = { SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5 } as const;

/** Adds one answer record per zone value: TXT chunks, MX `"<prio> <exchange>"` (`.` = null MX), or an address. */
function addAnswers(
  response: dns2.Packet,
  question: dns2.Packet.Question,
  type: string,
  values: ReadonlyArray<string | readonly string[]>,
  owner?: string,
) {
  const answer = (record: Partial<dns2.Packet.Resource>) =>
    response.answers.push(
      Packet.createResourceFromQuestion(question, {
        class: Packet.CLASS.IN,
        ttl: 300,
        ...(owner ? { name: owner } : {}),
        ...record,
      }),
    );

  for (const v of values) {
    if (type === 'TXT') {
      answer({ data: typeof v === 'string' ? [v] : [...v] });
    } else if (type === 'MX') {
      const [prio, exchange] = String(v).split(' ') as [string, string];
      answer({ exchange: exchange === '.' ? '' : exchange, priority: Number(prio) });
    } else {
      answer({ address: String(v) });
    }
  }
}

/** A UDP and a TCP server on one random loopback port: a response over 512 bytes is truncated and asked again over TCP. */
async function listenUdpAndTcp(
  handle: dns2.DnsHandler,
): Promise<{ port: number; close: () => Promise<void> }> {
  for (let attempt = 0; ; attempt++) {
    const udp = dns2.createUDPServer(handle);
    await udp.listen(0, '127.0.0.1');
    const port = udp.address()?.port;
    if (!port) throw new Error('fake DNS did not bind');
    const tcp = dns2.createTCPServer(handle);
    const bound = await new Promise<boolean>((resolve) => {
      tcp.once('error', () => resolve(false));
      tcp.listen(port, '127.0.0.1', () => resolve(true));
    });
    const closeUdp = () => new Promise<void>((resolve) => udp.close(() => resolve()));
    if (bound) {
      const closeTcp = () => new Promise<void>((resolve) => tcp.close(() => resolve()));
      return { port, close: async () => void (await Promise.all([closeUdp(), closeTcp()])) };
    }
    await closeUdp();
    if (attempt >= 4) throw new Error('fake DNS found no port free for both UDP and TCP');
  }
}

export async function startFakeDns(initial: FakeZone): Promise<FakeDnsServer> {
  let zone = initial;
  const requests: string[] = [];
  const server = await listenUdpAndTcp((request, send) => {
    const response = Packet.createResponseFromRequest(request);
    const question = request.questions[0];
    if (!question) return void send(response);

    const name = question.name.toLowerCase().replace(/\.$/, '');
    const type = TYPE_NAMES[question.type] ?? String(question.type);
    const key = `${type} ${name}`;
    requests.push(key);
    const value = zone[key];
    const cname = zone[`CNAME ${name}`];

    if (!value && Array.isArray(cname) && type !== 'CNAME') {
      const target = String(cname[0]);
      response.answers.push(
        Packet.createResourceFromQuestion(question, {
          class: Packet.CLASS.IN,
          ttl: 300,
          type: Packet.TYPE.CNAME,
          domain: target,
        }),
      );
      const targetValue = zone[`${type} ${target}`];
      if (Array.isArray(targetValue)) addAnswers(response, question, type, targetValue, target);
      else if (!Object.keys(zone).some((k) => k.split(' ')[1] === target))
        response.header.rcode = RCODES.NXDOMAIN;
      return void send(response);
    }

    if (value === 'DROP') return;
    if (typeof value === 'string') {
      response.header.rcode = RCODES[value];
      return void send(response);
    }
    if (!value) {
      // A name that has other records answers with an empty NOERROR (no data), an unknown name with NXDOMAIN.
      const exists = Object.keys(zone).some((k) => k.split(' ')[1] === name);
      if (!exists) response.header.rcode = RCODES.NXDOMAIN;
      return void send(response);
    }

    addAnswers(response, question, type, value);
    void send(response);
  });

  return {
    port: server.port,
    server: `127.0.0.1:${server.port}`,
    requests,
    setZone(z) {
      zone = z;
      requests.length = 0;
    },
    close: server.close,
  };
}

/** A typical small site: DMARC p=none with rua, SPF ~all with one include, one unrelated TXT. */
export const MAIL_SITE: FakeZone = {
  'A www.example.test': ['192.0.2.10'],
  'MX example.test': ['10 mx.example.test'],
  'TXT _dmarc.example.test': ['v=DMARC1; p=none; rua=mailto:dmarc-reports@example.test'],
  'TXT example.test': [
    'google-site-verification=abc123',
    // one TXT record split into two strings (RFC 7208 §3.3: concatenated without spaces)
    ['v=spf1 include:_spf.provider.test ', 'mx ~all'],
  ],
  'TXT _spf.provider.test': ['v=spf1 ip4:192.0.2.0/24 -all'],
};

/** Network for scan/collectors: every host resolves to 127.0.0.1, DNS goes to the fake server only. */
export function localDnsNetwork(dns: FakeDnsServer): NetworkConfig {
  return {
    proxy: null,
    allowPrivateAddresses: true,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    dnsServers: [dns.server],
  };
}
