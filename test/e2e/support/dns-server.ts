/** Fake authoritative DNS (dns2, UDP on 127.0.0.1) for the e2e sites: DMARC/SPF/MX records, NXDOMAIN otherwise. */
import dns2 from 'dns2';

const { Packet } = dns2;

export interface FakeZone {
  /** qname → TXT strings */
  txt?: Record<string, string[]>;
  /** qname → [priority, exchange] */
  mx?: Record<string, Array<[number, string]>>;
  /** Names that exist (NOERROR without data for other types). */
  names?: string[];
}

export interface FakeDnsServer {
  address: string;
  queries: Array<{ name: string; type: number }>;
  close(): Promise<void>;
}

type DnsPacket = InstanceType<typeof Packet>;
type DnsQuestion = DnsPacket['questions'][number];

const ANSWER_TTL_SECONDS = 300;
/** Every name of the zone resolves here: the fixture server listens on loopback. */
const LOOPBACK = '127.0.0.1';

/** The zone with lower-cased keys; a name that has TXT or MX data exists even when `names` omits it. */
function indexZone(zone: FakeZone) {
  const txt = new Map(Object.entries(zone.txt ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const mx = new Map(Object.entries(zone.mx ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const names = new Set([...(zone.names ?? []), ...txt.keys(), ...mx.keys()].map((n) => n.toLowerCase()));
  return { txt, mx, names };
}

const recordHeader = (qname: string, type: number) => ({
  name: qname,
  type,
  class: Packet.CLASS.IN,
  ttl: ANSWER_TTL_SECONDS,
});

/** TXT and MX answers from the zone, an A record for known names, NXDOMAIN for unknown ones, NOERROR without data otherwise. */
function answerQuestion(
  response: DnsPacket,
  q: DnsQuestion,
  name: string,
  zone: ReturnType<typeof indexZone>,
): void {
  if (q.type === Packet.TYPE.TXT && zone.txt.has(name)) {
    for (const data of zone.txt.get(name) ?? []) {
      response.answers.push({ ...recordHeader(q.name, Packet.TYPE.TXT), data } as never);
    }
  } else if (q.type === Packet.TYPE.MX && zone.mx.has(name)) {
    for (const [priority, exchange] of zone.mx.get(name) ?? []) {
      response.answers.push({ ...recordHeader(q.name, Packet.TYPE.MX), priority, exchange } as never);
    }
  } else if (q.type === Packet.TYPE.A && zone.names.has(name)) {
    response.answers.push({ ...recordHeader(q.name, Packet.TYPE.A), address: LOOPBACK } as never);
  } else if (!zone.names.has(name)) {
    response.header.rcode = Packet.RCODE.NXDOMAIN;
  }
}

export async function startFakeDns(zone: FakeZone): Promise<FakeDnsServer> {
  const index = indexZone(zone);
  const queries: FakeDnsServer['queries'] = [];

  const server = dns2.createServer({
    udp: true,
    handle: (request, send) => {
      const response = Packet.createResponseFromRequest(request);
      const q = request.questions[0];
      if (!q) return send(response);

      const name = q.name.toLowerCase().replace(/\.$/, '');
      queries.push({ name, type: q.type });
      answerQuestion(response, q, name, index);
      send(response);
    },
  });

  const addr = await server.listen({ udp: { port: 0, address: LOOPBACK } });
  const port = addr.udp?.port;
  if (!port) throw new Error('fake DNS did not start');

  return {
    address: `${LOOPBACK}:${port}`,
    queries,
    close: async () => {
      await server.close();
    },
  };
}
