import { describe, expect, it } from 'vitest';
import { applyAction } from '../../src/engine/sim';
import { emptyWorld } from '../../src/engine/world';
import type { Action, ActionResult, World, WorldEvent } from '../../src/engine/types';

/** tiny harness: run actions in order, keep the world and every event */
function lab() {
  let world = emptyWorld();
  let next = 1;
  let step = 0;
  const all: WorldEvent[] = [];
  const run = (a: Action): ActionResult => {
    const r = applyAction(world, a, { source: 'user', step: step++, firstEventId: next });
    world = r.world;
    next = r.nextEventId;
    all.push(...r.result.events);
    return r.result;
  };
  return { run, get w(): World { return world; }, all };
}

const chainOf = (events: WorldEvent[], id: number): WorldEvent[] => {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: WorldEvent[] = [];
  for (let e = byId.get(id); e; e = e.causedBy ? byId.get(e.causedBy) : undefined) out.unshift(e);
  return out;
};

describe('lifecycle', () => {
  it('run pulls the image, creates and starts a container, publishes the port', () => {
    const l = lab();
    const r = l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], detach: true });
    expect(r.ok).toBe(true);
    const c = l.w.containers.web!;
    expect(c.state).toBe('running');
    expect(c.pid).toBeGreaterThan(0);
    expect(c.networks.bridge!.ip).toBe('172.17.0.2');
    expect(l.w.images['nginx:latest']).toBeTruthy();
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toContain('image.pull.completed');
    expect(kinds).toContain('engine.runc');
    expect(kinds).toContain('process.started');
    expect(c.service).toBe('up');
  });

  it('every event except the root points at an earlier cause', () => {
    const l = lab();
    const r = l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'] });
    const ids = new Set(r.events.map((e) => e.id));
    r.events.forEach((e, i) => {
      if (i === 0) expect(e.causedBy).toBeNull();
      else {
        expect(e.causedBy).not.toBeNull();
        expect(ids.has(e.causedBy!)).toBe(true);
        expect(e.causedBy!).toBeLessThan(e.id);
      }
    });
  });

  it('is deterministic: same actions, same world', () => {
    const a = lab();
    const b = lab();
    for (const l of [a, b]) l.run({ action: 'run_container', image: 'redis:7', name: 'r', volumes: ['d:/data'] });
    expect(JSON.stringify(a.w)).toBe(JSON.stringify(b.w));
  });

  it('stop: nginx handles SIGTERM (0), node-as-PID1 does not (137)', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web' });
    l.run({ action: 'stop_container', target: 'container:web' });
    expect(l.w.containers.web!.exitCode).toBe(0);
    l.run({ action: 'build_image' });
    l.run({ action: 'run_container', image: 'my-api:latest', name: 'api' });
    l.run({ action: 'stop_container', target: 'container:api' });
    expect(l.w.containers.api!.exitCode).toBe(137);
  });

  it('removing a running container needs force', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web' });
    const r = l.run({ action: 'remove_container', target: 'container:web' });
    expect(r.ok).toBe(false);
    expect(l.w.containers.web).toBeTruthy();
    expect(l.run({ action: 'remove_container', target: 'container:web', force: true }).ok).toBe(true);
    expect(l.w.containers.web).toBeUndefined();
  });

  it('hello-world exits 0 immediately; alpine -d exits unless it has a long-running command', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'hello-world', name: 'h' });
    expect(l.w.containers.h!.state).toBe('exited');
    expect(l.w.containers.h!.exitCode).toBe(0);
    l.run({ action: 'run_container', image: 'alpine:3.20', name: 'a1' });
    expect(l.w.containers.a1!.state).toBe('exited');
    l.run({ action: 'run_container', image: 'alpine:3.20', name: 'a2', cmd: ['sleep', '3600'] });
    expect(l.w.containers.a2!.state).toBe('running');
  });
});

describe('ports', () => {
  it('a port conflict leaves the second container in "created", like Docker', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'a', ports: ['8080:80'] });
    const r = l.run({ action: 'run_container', image: 'nginx', name: 'b', ports: ['8080:80'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/port is already allocated/);
    expect(l.w.containers.b!.state).toBe('created');
    expect(r.events.some((e) => e.kind === 'port.conflict')).toBe(true);
  });

  it('a host process can hold the port too', () => {
    const l = lab();
    const r = l.run({ action: 'run_container', image: 'nginx', name: 'ssh', ports: ['22:80'] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already allocated/);
  });

  it('publishing the wrong container port gives connection reset', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:8080'] });
    const r = l.run({ action: 'send_request', from: 'external', to: 'container:web', port: 8080 });
    const rr = r.data as { ok: boolean; reason: string };
    expect(rr.ok).toBe(false);
    expect(rr.reason).toMatch(/listens on 80/);
  });
});

describe('persistence: volume vs writable layer', () => {
  it('removing a container destroys layer data but not volume data', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'redis:7', name: 'v', volumes: ['mydata:/data'] });
    l.run({ action: 'run_container', image: 'redis:7', name: 't' });
    l.run({ action: 'write_data', target: 'container:v', path: '/data', count: 50 });
    const wr = l.run({ action: 'write_data', target: 'container:t', path: '/data', count: 50 });
    expect(wr.events.some((e) => e.kind === 'layer.data_written')).toBe(true);
    expect(l.w.volumes.mydata!.items).toBe(50);
    l.run({ action: 'remove_container', target: 'container:v', force: true });
    const rm = l.run({ action: 'remove_container', target: 'container:t', force: true });
    expect(rm.events.some((e) => e.kind === 'container.data_lost')).toBe(true);
    expect(l.w.volumes.mydata!.items).toBe(50); // survived
    // and a new container sees the old data
    l.run({ action: 'run_container', image: 'redis:7', name: 'v2', volumes: ['mydata:/data'] });
    expect(l.w.volumes.mydata!.items).toBe(50);
  });

  it('cannot remove a volume that a stopped container still references', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'redis:7', name: 'v', volumes: ['mydata:/data'] });
    l.run({ action: 'stop_container', target: 'container:v' });
    const r = l.run({ action: 'remove_volume', name: 'mydata' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/in use/);
  });

  it('a bind mount over the nginx html dir hides the image content: 403', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], volumes: ['/srv/wrong:/usr/share/nginx/html'] });
    expect(l.w.host.paths['/srv/wrong']).toEqual({ exists: true, items: 0 });
    expect(l.w.containers.web!.health).toBe('unhealthy');
    const r = l.run({ action: 'send_request', from: 'external', to: 'container:web', port: 8080 });
    expect((r.data as { status: number }).status).toBe(403);
    // the right path works
    l.run({ action: 'run_container', image: 'nginx', name: 'web2', ports: ['8081:80'], volumes: ['/srv/site:/usr/share/nginx/html:ro'] });
    expect(l.w.containers.web2!.health).toBe('healthy');
  });

  it('read-only mounts refuse writes', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'redis:7', name: 'r', volumes: ['d:/data:ro'] });
    expect(l.run({ action: 'write_data', target: 'container:r', path: '/data', count: 1 }).ok).toBe(false);
  });
});

describe('memory limits and the OOM causal chain', () => {
  it('lowering the memory limit below usage kills the process: limit -> cgroup -> oom -> exit 137', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'postgres:16', name: 'db', ports: ['5432:5432'], restart: 'no' });
    l.run({ action: 'stress', target: 'container:db', resource: 'memory', amount: 40 });
    const r = l.run({ action: 'set_resource_limit', target: 'container:db', resource: 'memory', value: '64MB' });
    expect(r.ok).toBe(true);
    const kinds = r.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['cgroup.limit_changed', 'cgroup.memory.exceeded', 'kernel.oom_kill', 'process.killed', 'container.exited']));
    const c = l.w.containers.db!;
    expect(c.state).toBe('exited');
    expect(c.exitCode).toBe(137);
    expect(c.oomKilled).toBe(true);
    // the exit event traces back to the limit change through the chain
    const exited = r.events.find((e) => e.kind === 'container.exited')!;
    const chain = chainOf(r.events, exited.id).map((e) => e.kind);
    expect(chain[0]).toBe('cgroup.limit_changed');
    expect(chain).toContain('kernel.oom_kill');
    // and the service goes down because of it
    expect(r.events.some((e) => e.kind === 'service.unavailable')).toBe(true);
  });

  it('a limit below what the app needs to boot dies instantly', () => {
    const l = lab();
    const r = l.run({ action: 'run_container', image: 'postgres:16', name: 'db', memory: '16MB' });
    expect(r.ok).toBe(true);
    expect(l.w.containers.db!.state).toBe('exited');
    expect(l.w.containers.db!.exitCode).toBe(137);
    expect(l.w.containers.db!.oomKilled).toBe(true);
  });

  it('restart policy turns an OOM into a crash loop that eventually backs off', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'postgres:16', name: 'db', memory: '16MB', restart: 'always' });
    const kinds = l.all.map((e) => e.kind);
    expect(kinds).toContain('container.restarting');
    expect(kinds).toContain('container.restart.backoff');
  });

  it('a leaky app under a limit is OOM-killed after enough ticks; without a limit the host OOMs', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'leaky:latest', name: 'leak', ports: ['9000:8080'], memory: '128MB' });
    const r = l.run({ action: 'advance_time', ticks: 10 });
    expect(r.events.some((e) => e.kind === 'kernel.oom_kill')).toBe(true);
    expect(l.w.containers.leak!.exitCode).toBe(137);
    const l2 = lab();
    l2.run({ action: 'run_container', image: 'leaky:latest', name: 'leak' });
    l2.run({ action: 'set_condition', condition: 'memory_pressure', value: 3000 });
    const r2 = l2.run({ action: 'advance_time', ticks: 60 });
    expect(r2.events.some((e) => e.kind === 'kernel.oom_kill' && /host is out of memory/.test(e.summary))).toBe(true);
  });

  it('cpu limits throttle, they never kill', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web', cpus: 0.5 });
    const r = l.run({ action: 'stress', target: 'container:web', resource: 'cpu', amount: 300 });
    expect(r.events.some((e) => e.kind === 'cgroup.cpu.throttled')).toBe(true);
    expect(l.w.containers.web!.state).toBe('running');
  });
});

describe('networking', () => {
  it('names resolve on user-defined networks but not on the default bridge', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'redis:7', name: 'cache' });
    l.run({ action: 'run_container', image: 'alpine:3.20', name: 'client', cmd: ['sleep', '300'] });
    const bad = l.run({ action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 });
    expect((bad.data as { reason: string }).reason).toMatch(/default bridge has no embedded DNS/);
    l.run({ action: 'create_network', name: 'appnet' });
    l.run({ action: 'connect_network', container: 'container:client', network: 'appnet' });
    l.run({ action: 'connect_network', container: 'container:cache', network: 'appnet' });
    const good = l.run({ action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 });
    expect((good.data as { ok: boolean }).ok).toBe(true);
    // by IP always works on a shared bridge
    const byIp = l.run({ action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379, by: 'ip' });
    expect((byIp.data as { ok: boolean }).ok).toBe(true);
  });

  it('different networks are isolated', () => {
    const l = lab();
    l.run({ action: 'create_network', name: 'a' });
    l.run({ action: 'create_network', name: 'b' });
    l.run({ action: 'run_container', image: 'redis:7', name: 'cache', network: 'a' });
    l.run({ action: 'run_container', image: 'alpine:3.20', name: 'client', network: 'b', cmd: ['sleep', '1'] });
    const r = l.run({ action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 });
    expect((r.data as { ok: boolean; reason: string }).ok).toBe(false);
  });

  it('broken upstream DNS blocks pulls but not container-to-container names', () => {
    const l = lab();
    l.run({ action: 'create_network', name: 'n' });
    l.run({ action: 'run_container', image: 'redis:7', name: 'cache', network: 'n' });
    l.run({ action: 'run_container', image: 'alpine:3.20', name: 'client', network: 'n', cmd: ['sleep', '9'] });
    l.run({ action: 'set_condition', condition: 'dns', value: false });
    const pull = l.run({ action: 'pull_image', ref: 'busybox' });
    expect(pull.ok).toBe(false);
    expect(pull.error).toMatch(/lookup registry-1.docker.io/);
    const r = l.run({ action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 });
    expect((r.data as { ok: boolean }).ok).toBe(true);
  });

  it('registry down: pulls fail, local images still run', () => {
    const l = lab();
    l.run({ action: 'pull_image', ref: 'nginx' });
    l.run({ action: 'set_condition', condition: 'registry', value: false });
    expect(l.run({ action: 'pull_image', ref: 'redis:7' }).ok).toBe(false);
    expect(l.run({ action: 'run_container', image: 'nginx', name: 'web' }).ok).toBe(true);
  });

  it('wrong architecture: pulls with a warning, then exec format error (255)', () => {
    const l = lab();
    const r = l.run({ action: 'run_container', image: 'arm-demo:latest', name: 'x' });
    expect(r.events.some((e) => e.kind === 'image.platform.mismatch')).toBe(true);
    expect(l.w.containers.x!.exitCode).toBe(255);
    expect(l.w.containers.x!.error).toMatch(/exec format error/);
  });

  it('cannot remove a network with active endpoints', () => {
    const l = lab();
    l.run({ action: 'create_network', name: 'n' });
    l.run({ action: 'run_container', image: 'redis:7', name: 'c', network: 'n' });
    expect(l.run({ action: 'remove_network', name: 'n' }).ok).toBe(false);
  });
});

describe('build cache', () => {
  it('second build is fully cached; editing a middle step invalidates everything above it', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    const first = l.w.build.last!.steps.filter((s) => !['ENV', 'EXPOSE', 'CMD', 'USER'].includes(s.instr));
    expect(first.slice(1).every((s) => !s.cached)).toBe(true);
    l.run({ action: 'build_image' });
    const second = l.w.build.last!.steps.filter((s) => !['ENV', 'EXPOSE', 'CMD', 'USER'].includes(s.instr));
    expect(second.every((s) => s.cached)).toBe(true);
    l.run({ action: 'edit_dockerfile', step: 2 }); // COPY package*.json
    l.run({ action: 'build_image' });
    const third = l.w.build.last!.steps;
    expect(third[1]!.cached).toBe(true); // WORKDIR still cached
    expect(third[2]!.cached).toBe(false);
    expect(third[3]!.cached).toBe(false); // npm ci re-runs: the classic cache-bust
    expect(third[4]!.cached).toBe(false);
  });

  it('editing only the last COPY keeps npm ci cached', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    l.run({ action: 'edit_dockerfile', step: 4 });
    l.run({ action: 'build_image' });
    const s = l.w.build.last!.steps;
    expect(s[3]!.cached).toBe(true);
    expect(s[4]!.cached).toBe(false);
  });

  it('image layers are shared with the base image', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    const api = l.w.images['my-api:latest']!;
    const node = l.w.images['node:20-alpine']!;
    expect(api.layers.slice(0, node.layers.length)).toEqual(node.layers);
    expect(api.layers.length).toBeGreaterThan(node.layers.length);
  });

  it('building without DNS fails at the RUN step', () => {
    const l = lab();
    l.run({ action: 'pull_image', ref: 'node:20-alpine' });
    l.run({ action: 'set_condition', condition: 'dns', value: false });
    const r = l.run({ action: 'build_image' });
    expect(r.ok).toBe(false);
  });
});

describe('compose', () => {
  it('up creates network, volume and three connected services', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    const r = l.run({ action: 'compose_up' });
    expect(r.ok).toBe(true);
    expect(Object.keys(l.w.containers).sort()).toEqual(['shop-api-1', 'shop-db-1', 'shop-web-1']);
    expect(l.w.networks['shop_default']).toBeTruthy();
    expect(l.w.volumes['shop_dbdata']).toBeTruthy();
    expect(l.w.containers['shop-web-1']!.health).toBe('healthy');
    const req = l.run({ action: 'send_request', from: 'external', to: 'container:shop-web-1', port: 8080 });
    expect((req.data as { ok: boolean }).ok).toBe(true);
  });

  it('breaking the db dependency cascades: db down -> api unhealthy -> web unhealthy -> service unavailable', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    l.run({ action: 'compose_up' });
    const r = l.run({ action: 'compose_stop_service', service: 'db' });
    expect(l.w.containers['shop-api-1']!.health).toBe('unhealthy');
    expect(l.w.containers['shop-web-1']!.health).toBe('unhealthy');
    expect(r.events.some((e) => e.kind === 'service.unavailable' && e.target === 'container:shop-web-1')).toBe(true);
    const req = l.run({ action: 'send_request', from: 'external', to: 'container:shop-web-1', port: 8080 });
    expect((req.data as { ok: boolean; status: number }).ok).toBe(false);
    expect((req.data as { status: number }).status).toBe(502);
    // and it recovers
    const back = l.run({ action: 'start_container', target: 'container:shop-db-1' });
    expect(back.events.some((e) => e.kind === 'service.recovered')).toBe(true);
    expect(l.w.containers['shop-web-1']!.health).toBe('healthy');
  });

  it('compose down keeps the volume', () => {
    const l = lab();
    l.run({ action: 'build_image' });
    l.run({ action: 'compose_up' });
    l.run({ action: 'compose_down' });
    expect(Object.keys(l.w.containers)).toHaveLength(0);
    expect(l.w.volumes['shop_dbdata']).toBeTruthy();
  });
});

describe('processes, daemons and the host', () => {
  it('killing a worker keeps the container; killing PID 1 ends it', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web' });
    l.run({ action: 'kill_process', target: 'container:web', pid: 7 });
    expect(l.w.containers.web!.state).toBe('running');
    l.run({ action: 'kill_process', target: 'container:web' });
    expect(l.w.containers.web!.state).toBe('exited');
    expect(l.w.containers.web!.exitCode).toBe(137);
  });

  it('restart policy always brings a killed PID 1 back', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web', restart: 'always' });
    l.run({ action: 'kill_process', target: 'container:web' });
    expect(l.w.containers.web!.state).toBe('running');
    expect(l.w.containers.web!.restartCount).toBe(1);
  });

  it('stopping containerd leaves running containers alive (the shim holds them) but blocks new ones', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web' });
    l.run({ action: 'stop_daemon', daemon: 'containerd' });
    expect(l.w.containers.web!.state).toBe('running');
    const r = l.run({ action: 'run_container', image: 'redis:7', name: 'r' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/containerd/);
  });

  it('stopping dockerd stops containers and blocks the CLI; restart policies decide who returns', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'keep', restart: 'unless-stopped' });
    l.run({ action: 'run_container', image: 'redis:7', name: 'drop' });
    l.run({ action: 'stop_daemon', daemon: 'dockerd' });
    expect(l.run({ action: 'pull_image', ref: 'busybox' }).error).toMatch(/Cannot connect to the Docker daemon/);
    l.run({ action: 'start_daemon', daemon: 'dockerd' });
    expect(l.w.containers.keep!.state).toBe('running');
    expect(l.w.containers.drop!.state).toBe('exited');
  });

  it('a manually stopped unless-stopped container stays down after a host reboot', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'a', restart: 'unless-stopped' });
    l.run({ action: 'run_container', image: 'redis:7', name: 'b', restart: 'unless-stopped' });
    l.run({ action: 'stop_container', target: 'container:b' });
    l.run({ action: 'restart_host' });
    expect(l.w.containers.a!.state).toBe('running');
    expect(l.w.containers.b!.state).toBe('exited');
    expect(l.w.host.bootCount).toBe(2);
  });

  it('a full disk crashes databases but not web servers', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'postgres:16', name: 'db' });
    l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'] });
    const r = l.run({ action: 'fill_disk', mb: 30000 });
    expect(r.events.some((e) => e.kind === 'disk.full')).toBe(true);
    expect(l.w.containers.db!.state).toBe('exited');
    expect(l.w.containers.db!.exitCode).toBe(1);
    expect(l.w.containers.web!.state).toBe('running');
  });

  it('connection test is harmless and visible', () => {
    const l = lab();
    const r = l.run({ action: 'connection_test' });
    expect(r.ok).toBe(true);
    expect(r.events[0]!.kind).toBe('lab.connection_test');
  });

  it('packet loss and latency degrade external requests', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'] });
    const base = (l.run({ action: 'send_request', from: 'external', to: 'container:web', port: 8080 }).data as { latencyMs: number }).latencyMs;
    l.run({ action: 'set_condition', condition: 'latency', value: 300 });
    const slow = (l.run({ action: 'send_request', from: 'external', to: 'container:web', port: 8080 }).data as { latencyMs: number }).latencyMs;
    expect(slow).toBeGreaterThan(base + 500);
    l.run({ action: 'set_condition', condition: 'packet_loss', value: 80 });
    expect((l.run({ action: 'send_request', from: 'external', to: 'container:web', port: 8080 }).data as { ok: boolean }).ok).toBe(false);
  });
});

describe('input hardening (names, references, clamps)', () => {
  it('rejects hostile or malformed names and references with Docker-like errors', () => {
    const l = lab();
    for (const name of ['__proto__', 'constructor', '', ' ', 'a b', '../x', 'x'.repeat(80), '-lead']) {
      const r = l.run({ action: 'run_container', image: 'alpine:3.20', name, cmd: ['sleep', '1'] });
      // an empty name means "auto-name"; everything else must be refused
      if (name === '') expect(r.ok).toBe(true);
      else expect(r.ok, `name ${JSON.stringify(name)}`).toBe(false);
    }
    expect(Object.keys(l.w.containers).every((n) => n !== '__proto__')).toBe(true);
    expect(l.run({ action: 'create_network', name: '__proto__' }).ok).toBe(false);
    expect(l.run({ action: 'stop_container', target: 'container:constructor' }).ok).toBe(false); // not a container, not a prototype member
    expect(l.run({ action: 'create_volume', name: 'a/b' }).ok).toBe(false);
    expect(l.run({ action: 'pull_image', ref: 'UPPER CASE:tag!' }).error).toMatch(/invalid reference format/);
    expect(l.run({ action: 'pull_image', ref: 'https://evil.example/x' }).ok).toBe(false);
    // the world is still sound afterwards
    expect(l.run({ action: 'run_container', image: 'nginx', name: 'ok', ports: ['8080:80'] }).ok).toBe(true);
  });

  it('clamps absurd numbers instead of corrupting state', () => {
    const l = lab();
    l.run({ action: 'run_container', image: 'redis:7', name: 'r', volumes: ['d:/data'] });
    l.run({ action: 'write_data', target: 'container:r', path: '/data', count: 1e15 });
    expect(l.w.volumes.d!.items).toBeLessThanOrEqual(1_000_000);
    l.run({ action: 'fill_disk', mb: -5000 });
    expect(l.w.host.fillerDiskMB).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(l.w.host.fillerDiskMB)).toBe(true);
    l.run({ action: 'advance_time', ticks: 1e12 });
    expect(l.w.tick).toBeLessThan(200);
  });
});
