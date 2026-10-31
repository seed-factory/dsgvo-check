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

export async function startFakeDns(zone: FakeZone): Promise<FakeDnsServer> {
  const txt = new Map(Object.entries(zone.txt ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const mx = new Map(Object.entries(zone.mx ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const names = new Set([...(zone.names ?? []), ...txt.keys(), ...mx.keys()].map((n) => n.toLowerCase()));
  const queries: FakeDnsServer['queries'] = [];
  const server = dns2.createServer({
    udp: true,
    handle: (request, send) => {
      const response = Packet.createResponseFromRequest(request);
      const q = request.questions[0];
      if (!q) return send(response);
      const name = q.name.toLowerCase().replace(/\.$/, '');
      queries.push({ name, type: q.type });
      if (q.type === Packet.TYPE.TXT && txt.has(name)) {
        for (const data of txt.get(name) ?? []) {
          response.answers.push({
            name: q.name,
            type: Packet.TYPE.TXT,
            class: Packet.CLASS.IN,
            ttl: 300,
            data,
          } as never);
        }
      } else if (q.type === Packet.TYPE.MX && mx.has(name)) {
        for (const [priority, exchange] of mx.get(name) ?? []) {
          response.answers.push({
            name: q.name,
            type: Packet.TYPE.MX,
            class: Packet.CLASS.IN,
            ttl: 300,
            priority,
            exchange,
          } as never);
        }
      } else if (q.type === Packet.TYPE.A && names.has(name)) {
        response.answers.push({
          name: q.name,
          type: Packet.TYPE.A,
          class: Packet.CLASS.IN,
          ttl: 300,
          address: '127.0.0.1',
        } as never);
      } else if (!names.has(name)) {
        response.header.rcode = Packet.RCODE.NXDOMAIN;
      }
      send(response);
    },
  });
  const addr = await server.listen({ udp: { port: 0, address: '127.0.0.1' } });
  const port = addr.udp?.port;
  if (!port) throw new Error('fake DNS did not start');
  return {
    address: `127.0.0.1:${port}`,
    queries,
    close: async () => {
      await server.close();
    },
  };
}
