import type { Container, Health, Hop, RequestResult, World } from './types';
import { diskFreeMB, hostCpuPct } from './world';
import { own } from './util';

/**
 * Request-path simulation. A request is a walk along the same chain the real
 * packet takes (host NIC -> iptables DNAT -> bridge -> veth -> netns -> socket
 * -> app). The first broken hop becomes the reason, and every hop is a
 * semantic anchor the renderer can light up.
 */

type Out = Omit<RequestResult, 'id' | 'tick' | 'from' | 'to'>;

class Trace {
  hops: Hop[] = [];
  failed = false;
  reason = '';
  status = 0;
  ok(node: string, detail: string, anchor?: string): this {
    this.hops.push({ node, detail, status: this.failed ? 'skipped' : 'ok', anchor });
    return this;
  }
  fail(node: string, detail: string, reason: string, status = 0, anchor?: string): this {
    if (this.failed) {
      this.hops.push({ node, detail, status: 'skipped', anchor });
    } else {
      this.failed = true;
      this.reason = reason;
      this.status = status;
      this.hops.push({ node, detail, status: 'fail', anchor });
    }
    return this;
  }
}

export function findByName(w: World, name: string): Container | undefined {
  return (
    own(w.containers, name) ??
    Object.values(w.containers).find((c) => c.compose?.service === name || c.compose?.service === name.replace(/^.*-(\w+)-1$/, '$1'))
  );
}

/** networks both containers are on */
export function sharedNetworks(a: Container, b: Container): string[] {
  return Object.keys(a.networks).filter((n) => n in b.networks);
}

export interface NameResolution {
  ok: boolean;
  target?: Container;
  reason: string;
  network?: string;
}

/** Can `from` find `name` through Docker's embedded DNS (127.0.0.11)? */
export function resolveName(w: World, from: Container, name: string): NameResolution {
  const target = findByName(w, name);
  if (!target) {
    if (!w.host.net.dnsUp) {
      return { ok: false, reason: `could not resolve "${name}": not a container name, and the host's upstream DNS is down` };
    }
    return { ok: false, reason: `could not resolve "${name}": no container or service has that name` };
  }
  if (target.name === from.name) return { ok: true, target, reason: 'self', network: Object.keys(from.networks)[0] };
  const shared = sharedNetworks(from, target);
  const userDefined = shared.filter((n) => w.networks[n]?.dns);
  if (userDefined.length === 0) {
    if (shared.length > 0) {
      return {
        ok: false,
        target,
        reason: `"${name}" shares only the default bridge with ${from.name}; the default bridge has no embedded DNS, so names do not resolve (use a user-defined network or the IP)`,
      };
    }
    return { ok: false, target, reason: `"${name}" is on a different network than ${from.name}; Docker's embedded DNS only answers for networks the asker is attached to` };
  }
  return { ok: true, target, reason: 'resolved by embedded DNS (127.0.0.11)', network: userDefined[0] };
}

export interface Serve {
  status: number;
  reason: string;
}

/** What does the application itself answer? Pure function of state => also drives health. */
export function serve(w: World, c: Container, depth = 0): Serve {
  const wl = c.workload;
  if (depth > 4) return { status: 508, reason: 'dependency loop' };
  // data hidden by a bind mount over a directory the image populated
  if (wl.dataDir && wl.imageHasData) {
    const m = c.mounts.find((x) => x.target === wl.dataDir);
    if (m && m.type === 'bind') {
      const items = w.host.paths[m.source]?.items ?? 0;
      if (items === 0) {
        return {
          status: 403,
          reason: `403 Forbidden: ${m.source} (empty) is bind-mounted over ${wl.dataDir}, hiding the files that were baked into the image`,
        };
      }
    }
  }
  if (wl.kind === 'database' && diskFreeMB(w) <= 0) {
    return { status: 500, reason: 'PANIC: could not write to file: No space left on device' };
  }
  for (const need of wl.needs) {
    const r = resolveName(w, c, need);
    if (!r.ok || !r.target) return { status: 502, reason: `upstream "${need}" unreachable: ${r.reason}` };
    const t = r.target;
    if (t.state === 'paused') return { status: 504, reason: `upstream "${need}" is paused (frozen): gateway timeout` };
    if (t.state !== 'running') return { status: 502, reason: `upstream "${need}" is ${t.state}: connection refused` };
    if (t.workload.listens === null) return { status: 502, reason: `upstream "${need}" is not listening on any port` };
    const sub = serve(w, t, depth + 1);
    if (sub.status >= 400) return { status: 502, reason: `upstream "${need}" is failing: ${sub.reason}` };
  }
  return { status: 200, reason: 'ok' };
}

export function evaluateHealth(w: World, c: Container): Health {
  if (c.state !== 'running') return 'none';
  if (c.workload.kind === 'idle' || c.workload.kind === 'job') return 'none';
  return serve(w, c).status < 400 ? 'healthy' : 'unhealthy';
}

/** latency multiplier from host CPU saturation */
function cpuFactor(w: World): number {
  const p = hostCpuPct(w);
  return p > 90 ? 6 : p > 75 ? 3 : p > 50 ? 1.6 : 1;
}

function appLatency(w: World, c: Container, base: number): number {
  const throttle = c.limits.cpus && c.usage.cpuPct > c.limits.cpus * 100 ? 2.5 : 1;
  return Math.round(base * cpuFactor(w) * throttle);
}

export interface ServiceCheck {
  ok: boolean;
  status: number;
  reason: string;
}

/** Is the container reachable from outside the machine through a published port? */
export function externalService(w: World, c: Container): ServiceCheck {
  const first = c.ports[0];
  if (!first) return { ok: false, status: 0, reason: 'nothing published' };
  const t = probe(w, 'external', c.name, first.host, 'name');
  return { ok: t.ok, status: t.status, reason: t.reason };
}

/**
 * Walk a request. `from` is "external" | "host" | a container name.
 * `to` is a container name. `port` is the HOST port for external/host, the
 * CONTAINER port for container->container.
 */
export function probe(w: World, from: string, to: string, port?: number, by: 'name' | 'ip' = 'name'): Out {
  const t = new Trace();
  const target = findByName(w, to);
  const finish = (latency: number, okReason = 'ok'): Out => ({
    ok: !t.failed,
    status: t.failed ? t.status : 200,
    latencyMs: t.failed ? 0 : latency,
    hops: t.hops,
    reason: t.failed ? t.reason : okReason,
  });

  if (!target) {
    t.fail('resolve', `no such container "${to}"`, `no such container "${to}"`, 0);
    return finish(0);
  }
  const tAnchor = `container:${target.name}`;
  const net = w.host.net;
  let latency = 2;

  /* ---- from outside the machine, or from the host itself -------------- */
  if (from === 'external' || from === 'host') {
    const external = from === 'external';
    if (!w.host.online) {
      t.fail('client', 'connect to whale-01', 'no route to host: the machine is powered off', 0, 'host');
      return finish(0);
    }
    t.ok('client', external ? 'external client sends SYN to the host IP' : 'process on the host connects to localhost', undefined);
    if (external) {
      if (net.packetLossPct >= 50) {
        t.fail('internet', `${net.packetLossPct}% packet loss`, `connection timed out: ${net.packetLossPct}% of packets are being lost`, 0, 'host');
        return finish(0);
      }
      t.ok('internet', `${net.latencyMs} ms one-way, ${net.packetLossPct}% loss`, 'host');
      latency += net.latencyMs * 2 + Math.round((net.packetLossPct / 100) * 80);
    }
    const mapping = port !== undefined ? target.ports.find((p) => p.host === port || p.container === port) : target.ports[0];
    if (!mapping) {
      const direct = !external && target.state === 'running' && Object.keys(target.networks).some((n) => w.networks[n]?.driver === 'bridge');
      if (direct) {
        // host can reach bridge IPs directly (no DNAT needed)
        t.ok('host route', 'host routes to the bridge subnet directly (no port publish needed from the host)', 'host');
      } else {
        t.fail(
          `host :${port ?? '?'}`,
          'no iptables DNAT rule for this port',
          `connection refused: no host port is published for ${target.name}${port ? ` on :${port}` : ''} (run with -p)`,
          0,
          'host',
        );
        return finish(0);
      }
    } else {
      if (target.state !== 'running' && target.state !== 'paused') {
        t.fail(`host :${mapping.host}`, 'DNAT rule and docker-proxy are removed when the container stops', `connection refused: ${target.name} is ${target.state}, so nothing is bound to host port ${mapping.host}`, 0, 'host');
        return finish(0);
      }
      t.ok(`host :${mapping.host}`, `iptables DNAT → ${firstIp(target)}:${mapping.container}  (docker-proxy as fallback)`, 'host');
    }
    return containerLeg(w, t, target, tAnchor, port !== undefined && mapping ? mapping.container : (mapping?.container ?? target.workload.listens ?? 0), latency, finish);
  }

  /* ---- container -> container ----------------------------------------- */
  const src = findByName(w, from);
  if (!src) {
    t.fail('client', `no such container "${from}"`, `no such container "${from}"`, 0);
    return finish(0);
  }
  const sAnchor = `container:${src.name}`;
  if (src.state !== 'running') {
    t.fail('client', `${src.name} is ${src.state}`, `${src.name} is not running, so it cannot send anything`, 0, sAnchor);
    return finish(0);
  }
  t.ok('client', `${src.name} opens a socket`, sAnchor);
  if (by === 'name') {
    const r = resolveName(w, src, to);
    if (!r.ok) {
      t.fail('dns 127.0.0.11', `lookup ${to}`, r.reason, 0, sAnchor);
      return finish(0);
    }
    t.ok('dns 127.0.0.11', `Docker's embedded DNS answers ${to} → ${firstIp(target, r.network)}`, sAnchor);
  }
  const shared = sharedNetworks(src, target);
  if (shared.length === 0) {
    t.fail('bridge', 'no shared network', `connection timed out: ${src.name} and ${target.name} are on different networks, and Docker isolates bridges from each other`, 0, tAnchor);
    return finish(0);
  }
  const netName = shared.find((n) => w.networks[n]?.dns) ?? shared[0]!;
  const bridgeIf = w.networks[netName]?.bridgeIf ?? netName;
  t.ok('veth (client)', `eth0 in ${src.name}'s netns ↔ veth on ${bridgeIf}`, sAnchor);
  t.ok(`bridge ${bridgeIf}`, `layer-2 switch for network "${netName}"`, `network:${netName}`);
  t.ok('veth (server)', `${bridgeIf} ↔ eth0 in ${target.name}'s netns`, tAnchor);
  return containerLeg(w, t, target, tAnchor, port ?? target.workload.listens ?? 0, latency + 1, finish);
}

function firstIp(c: Container, net?: string): string {
  const n = net ?? Object.keys(c.networks)[0];
  return (n && c.networks[n]?.ip) || '0.0.0.0';
}

function containerLeg(
  w: World,
  t: Trace,
  target: Container,
  tAnchor: string,
  cport: number,
  latency: number,
  finish: (latency: number, okReason?: string) => Out,
): Out {
  const netName = Object.keys(target.networks)[0];
  if (netName) {
    const br = w.networks[netName]?.bridgeIf ?? netName;
    if (!t.hops.some((h) => h.node.startsWith('bridge'))) {
      t.ok(`bridge ${br}`, `host → ${br} → veth → ${target.name}`, `network:${netName}`);
      t.ok('veth pair', `host side attached to ${br}, container side is eth0`, tAnchor);
    }
  }
  if (target.state === 'paused') {
    t.fail(
      `netns ${target.name}`,
      'cgroup freezer: processes are frozen',
      `connection timed out: ${target.name} is paused; the kernel accepts the SYN but the frozen process never reads from the socket`,
      0,
      tAnchor,
    );
    return finish(0);
  }
  if (target.state !== 'running') {
    t.fail(`netns ${target.name}`, `container is ${target.state}`, `connection refused: ${target.name} is ${target.state}`, 0, tAnchor);
    return finish(0);
  }
  t.ok(`netns ${target.name}`, `eth0 ${firstIp(target)}`, tAnchor);
  if (target.workload.listens === null || target.workload.listens !== cport) {
    t.fail(
      `socket :${cport}`,
      `nothing listening on :${cport} inside the container`,
      `connection reset: ${target.name} listens on ${target.workload.listens ?? 'no port'} but the request went to :${cport}`,
      0,
      tAnchor,
    );
    return finish(0);
  }
  t.ok(`socket :${cport}`, `${target.process} accepts the connection`, tAnchor);
  const s = serve(w, target);
  if (s.status >= 400) {
    t.fail('app', s.reason, `HTTP ${s.status}: ${s.reason}`, s.status, tAnchor);
    return finish(0);
  }
  t.ok('app', `HTTP ${s.status}`, tAnchor);
  let ms = appLatency(w, target, latency + target.workload.baseCpuPct);
  return finish(ms, ms > 400 ? `ok, but slow (${ms} ms): the host CPU is saturated` : 'ok');
}
