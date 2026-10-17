import type { Action, Container, World, WorldEvent } from './types';
import { kernelView, processTree, type ProcNode } from './derive';
import { findByName } from './probe';
import { diskFreeMB, diskUsedMB, hostMemUsedMB, imageSizeOnDisk } from './world';
import { fmtMB, normalizeRef, parseTarget, short } from './util';

/**
 * A safe simulation of the docker CLI. It never touches a real daemon: each
 * command is parsed into (a) segments with a semantic meaning, shown to the
 * learner, and (b) world actions or a read-only query.
 */

export type SegRole = 'bin' | 'sub' | 'flag' | 'value' | 'image' | 'arg' | 'cmd';

export interface Seg {
  text: string;
  start: number;
  end: number;
  role: SegRole;
  /** short semantic label, e.g. "identity" */
  label: string;
  /** one-sentence explanation of what this part does */
  explain: string;
  concept?: string;
}

export interface Parsed {
  raw: string;
  segs: Seg[];
  plan: Action[];
  read?: { kind: string; args: string[]; flags: Set<string> };
  autoRemove?: boolean;
  error?: string;
  /** for local pseudo-commands */
  local?: 'help' | 'clear';
}

interface Tok {
  text: string;
  start: number;
  end: number;
}

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    const start = i;
    let text = '';
    let q: string | null = null;
    while (i < line.length && (q || !/\s/.test(line[i]!))) {
      const ch = line[i]!;
      if (q) {
        if (ch === q) q = null;
        else text += ch;
      } else if (ch === '"' || ch === "'") q = ch;
      else text += ch;
      i++;
    }
    out.push({ text, start, end: i });
  }
  return out;
}

const VALUE_FLAGS: Record<string, string> = {
  '--name': 'name',
  '-p': 'publish',
  '--publish': 'publish',
  '-v': 'volume',
  '--volume': 'volume',
  '-e': 'env',
  '--env': 'env',
  '--network': 'network',
  '--net': 'network',
  '-m': 'memory',
  '--memory': 'memory',
  '--cpus': 'cpus',
  '--pids-limit': 'pids',
  '--restart': 'restart',
  '--tmpfs': 'tmpfs',
  '-u': 'user',
  '--user': 'user',
  '-w': 'workdir',
  '--workdir': 'workdir',
  '--hostname': 'hostname',
  '-h': 'hostname',
  '-t': 'tag',
  '--tag': 'tag',
  '-s': 'signal',
  '--signal': 'signal',
  '--tail': 'tail',
  '-n': 'tail',
  '-f': 'file',
  '--mount': 'mount',
  '--entrypoint': 'entrypoint',
};

const BOOL_FLAGS = new Set(['-d', '--detach', '-i', '-t', '-it', '-ti', '--rm', '--privileged', '--read-only', '--init', '-a', '--all', '-q', '--quiet', '--no-stream', '-f', '--force', '--no-trunc', '--follow', '-v']);

function explainFlag(flag: string, value: string | undefined): { label: string; explain: string; concept?: string } {
  switch (VALUE_FLAGS[flag] ?? flag) {
    case 'name':
      return { label: 'identity', explain: `Names the container "${value}". On a user-defined network this is also its DNS name.`, concept: 'service-discovery' };
    case 'publish': {
      const [h, c] = (value ?? '').split(':');
      return { label: 'port exposure', explain: `Publishes host port ${h ?? '?'} to container port ${c ?? h ?? '?'} (an iptables DNAT rule). The container port must be the one the app really listens on.`, concept: 'port-publish' };
    }
    case 'volume': {
      const bind = /^[./~]/.test(value ?? '');
      return { label: bind ? 'bind mount' : 'volume mount', explain: bind ? `Maps the host directory ${(value ?? '').split(':')[0]} into the container. It hides whatever the image had at that path.` : `Mounts named volume ${(value ?? '').split(':')[0]} at ${(value ?? '').split(':')[1] ?? '?'}: data that outlives the container.`, concept: bind ? 'bind-mount' : 'volume' };
    }
    case 'env':
      return { label: 'environment', explain: `Sets environment variable ${value}.`, concept: 'container' };
    case 'network':
      return { label: 'network attachment', explain: `Attaches the container to network ${value} (instead of the default bridge).`, concept: 'network' };
    case 'memory':
      return { label: 'resource limit', explain: `Caps RAM at ${value} (cgroup memory.max). Over the cap the kernel OOM-kills a process.`, concept: 'memory-limit' };
    case 'cpus':
      return { label: 'resource limit', explain: `Limits CPU to ${value} cores (cgroup cpu.max). Over it the container is throttled, not killed.`, concept: 'cpu-limit' };
    case 'pids':
      return { label: 'resource limit', explain: `Caps the number of processes at ${value} (cgroup pids.max).`, concept: 'pids-limit' };
    case 'restart':
      return { label: 'restart behaviour', explain: `If the container exits or the daemon/host restarts, policy "${value}" decides whether dockerd starts it again.`, concept: 'restart-policy' };
    case 'tmpfs':
      return { label: 'memory-backed mount', explain: `Mounts a RAM-backed filesystem at ${value}.`, concept: 'tmpfs' };
    case 'tag':
      return { label: 'naming the result', explain: `Tags the built image as ${value}.`, concept: 'tag' };
    case 'signal':
      return { label: 'signal', explain: `Sends ${value} to the container's PID 1.`, concept: 'signals' };
    default:
      break;
  }
  switch (flag) {
    case '-d':
    case '--detach':
      return { label: 'background lifecycle', explain: 'Run detached: return the container ID immediately instead of attaching to its output.', concept: 'lifecycle' };
    case '--rm':
      return { label: 'cleanup', explain: 'Remove the container automatically when it exits (its writable layer is deleted).', concept: 'writable-layer' };
    case '-it':
    case '-i':
    case '-t':
    case '-ti':
      return { label: 'interactivity', explain: 'Keep stdin open / allocate a terminal. (Ignored in this simulator: no TTY.)' };
    case '--privileged':
      return { label: 'security', explain: 'Gives the container ALL capabilities and removes the seccomp filter: close to root on the host.', concept: 'capabilities' };
    case '--read-only':
      return { label: 'filesystem', explain: 'Mounts the container root filesystem read-only (no writable layer writes).', concept: 'writable-layer' };
    case '-f':
    case '--force':
      return { label: 'force', explain: 'Do it even if the object is in use (e.g. kill a running container first).' };
    case '-a':
    case '--all':
      return { label: 'scope', explain: 'Include stopped containers too.' };
    default:
      return { label: 'option', explain: `Option ${flag}.` };
  }
}

const mk = (t: Tok, role: SegRole, label: string, explain: string, concept?: string): Seg => ({ text: t.text, start: t.start, end: t.end, role, label, explain, concept });

export function parseCommand(w: World, line: string): Parsed {
  const raw = line;
  const toks = tokenize(line.trim() ? line : '');
  const p: Parsed = { raw, segs: [], plan: [] };
  if (!toks.length) return p;
  const first = toks[0]!;
  if (first.text === 'clear') return { ...p, local: 'clear' };
  if (first.text === 'help' || first.text === '?') return { ...p, local: 'help' };

  if (first.text === 'curl') return parseCurl(w, toks, p);
  if (first.text !== 'docker') {
    p.error = `bash: ${first.text}: command not found (this terminal understands docker commands, curl and help)`;
    return p;
  }
  p.segs.push(mk(first, 'bin', 'the CLI', 'The docker client. It only sends REST requests to the Docker daemon (dockerd) over /var/run/docker.sock.', 'docker-cli'));
  const sub = toks[1];
  if (!sub) {
    p.error = 'Usage: docker [OPTIONS] COMMAND   (try: docker run -d --name web -p 8080:80 nginx)';
    return p;
  }
  let args = toks.slice(2);
  let verb = sub.text;
  let subTok = sub;
  const GROUPS = new Set(['network', 'volume', 'compose', 'system', 'image', 'container']);
  if (GROUPS.has(verb) && args[0]) {
    const second = args[0]!;
    p.segs.push(mk(sub, 'sub', 'object group', `Management commands for ${verb}.`));
    verb = `${verb} ${second.text}`;
    subTok = second;
    args = args.slice(1);
  } else if (verb === 'container' || verb === 'image') {
    p.error = `docker ${verb}: a subcommand is required`;
    return p;
  }
  // docker container ls / image ls aliases
  verb = verb.replace(/^container (ls|list)$/, 'ps').replace(/^image (ls|list)$/, 'images').replace(/^container /, '').replace(/^image (pull|rm|build|history)$/, (_m, x) => (x === 'rm' ? 'rmi' : x));

  const flags = new Set<string>();
  const opts: Record<string, string[]> = {};
  const rest: Tok[] = [];
  const takesValues = verb === 'run' || verb === 'create' || verb === 'build' || verb === 'kill' || verb === 'update' || verb === 'logs' || verb === 'compose up' || verb === 'compose down';
  let afterImage = false; // for run/create: everything after the image is the command
  const segFor: Seg[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (afterImage) {
      rest.push(t);
      continue;
    }
    if (t.text.startsWith('-') && t.text.length > 1) {
      let flag = t.text;
      let val: string | undefined;
      const eq = flag.indexOf('=');
      if (eq > 0) {
        val = flag.slice(eq + 1);
        flag = flag.slice(0, eq);
      }
      const ok = flag in VALUE_FLAGS && !(flag === '-v' && verb === 'logs') && !(flag === '-f' && !verb.startsWith('compose') && verb !== 'logs');
      const isValue = ok && takesValues && val === undefined && !(flag === '-t' && (verb === 'run' || verb === 'create'));
      const isTTY = flag === '-t' && (verb === 'run' || verb === 'create');
      if (isValue) {
        const vt = args[i + 1];
        if (!vt) {
          p.error = `flag needs an argument: '${flag}'`;
          return p;
        }
        (opts[VALUE_FLAGS[flag]!] ??= []).push(vt.text);
        const ex = explainFlag(flag, vt.text);
        segFor.push(mk(t, 'flag', ex.label, ex.explain, ex.concept));
        segFor.push(mk(vt, 'value', ex.label, `Value for ${flag}.`, ex.concept));
        i++;
        continue;
      }
      if (ok && val !== undefined) {
        (opts[VALUE_FLAGS[flag]!] ??= []).push(val);
        const ex = explainFlag(flag, val);
        segFor.push(mk(t, 'flag', ex.label, ex.explain, ex.concept));
        continue;
      }
      // boolean (possibly combined short flags like -dit)
      const combined = /^-[a-zA-Z]{2,}$/.test(flag) && !BOOL_FLAGS.has(flag) ? flag.slice(1).split('').map((c) => '-' + c) : [flag];
      for (const f of combined) flags.add(isTTY ? '-it' : f);
      const ex = explainFlag(isTTY ? '-it' : combined[0]!, undefined);
      segFor.push(mk(t, 'flag', ex.label, ex.explain, ex.concept));
      continue;
    }
    rest.push(t);
    if ((verb === 'run' || verb === 'create') && !afterImage) {
      afterImage = true;
      // the first positional is the image: label below
      segFor.push(mk(t, 'image', 'image resolution', `Looks for ${normalizeRef(t.text)} in local storage; if missing, pulls it from the registry first. The image is the read-only template the container is stamped from.`, 'image'));
    }
  }

  // verb segment
  const verbExplain: Record<string, [string, string, string?]> = {
    run: ['container lifecycle', 'Create AND start a container: dockerd → containerd → shim → runc.', 'lifecycle'],
    create: ['container lifecycle', 'Create a container without starting it.', 'lifecycle'],
    start: ['container lifecycle', 'Start an existing stopped container (new process, same writable layer).', 'lifecycle'],
    stop: ['container lifecycle', 'SIGTERM, wait 10 s, then SIGKILL.', 'signals'],
    restart: ['container lifecycle', 'Stop then start: a new process in the same container.', 'lifecycle'],
    pause: ['container lifecycle', 'Freeze its processes with the cgroup freezer.', 'cgroups'],
    unpause: ['container lifecycle', 'Thaw a paused container.', 'cgroups'],
    kill: ['container lifecycle', 'Send a signal (default SIGKILL) to PID 1 inside the container.', 'signals'],
    rm: ['container lifecycle', 'Delete the container and its writable layer. Volumes and the image stay.', 'writable-layer'],
    rmi: ['image management', 'Delete a local image (refused while a container uses it).', 'image'],
    pull: ['image acquisition', 'Download an image (only missing layers) from the registry.', 'registry'],
    build: ['image build', 'Run the Dockerfile through BuildKit; unchanged steps come from cache.', 'build-cache'],
    update: ['live resource change', 'Rewrite a running container\'s cgroup limits.', 'cgroups'],
    ps: ['inspection', 'List containers (read-only).', 'container'],
    images: ['inspection', 'List local images (read-only).', 'image'],
    logs: ['inspection', 'Show the stdout/stderr of the container\'s PID 1.', 'logs'],
    inspect: ['inspection', 'Show the low-level JSON for an object.', 'docker-api'],
    exec: ['inspection', 'Run a command inside a running container\'s namespaces.', 'namespaces'],
    stats: ['inspection', 'Read the container\'s cgroup counters.', 'cgroups'],
    top: ['inspection', 'List the container\'s processes as seen from the host.', 'process'],
    port: ['inspection', 'Show published port mappings.', 'port-publish'],
    history: ['inspection', 'Show an image\'s layers and the instruction that made each.', 'layer'],
    'network create': ['network object', 'Create a user-defined bridge network with embedded DNS.', 'network'],
    'network rm': ['network object', 'Delete a network (refused while containers are attached).', 'network'],
    'network connect': ['network object', 'Attach a running container to another network.', 'network'],
    'network disconnect': ['network object', 'Detach a container from a network.', 'network'],
    'network ls': ['inspection', 'List networks.', 'network'],
    'volume create': ['storage object', 'Create a named volume.', 'volume'],
    'volume rm': ['storage object', 'Delete a volume and its data (refused while referenced).', 'volume'],
    'volume ls': ['inspection', 'List volumes.', 'volume'],
    'compose up': ['multi-container app', 'Create and start every service in dependency order.', 'compose'],
    'compose down': ['multi-container app', 'Remove containers and the network; keep volumes.', 'compose'],
    'compose stop': ['multi-container app', 'Stop one service.', 'compose'],
    'compose ps': ['inspection', 'List the project\'s containers.', 'compose'],
    'system df': ['inspection', 'Show what is using disk space.', 'disk'],
    info: ['inspection', 'Daemon-wide information.', 'dockerd'],
    version: ['inspection', 'Client and Server (dockerd) versions.', 'docker-api'],
  };
  const ve = verbExplain[verb];
  if (!ve) {
    p.error = `docker: '${subTok.text}' is not a docker command here. Try: run, ps, stop, rm, pull, images, logs, inspect, exec, stats, top, build, network, volume, compose, update, system df`;
    return p;
  }
  p.segs.push(mk(subTok, 'sub', ve[0], ve[1], ve[2]));
  // flags/values collected in order after the verb; positional args
  p.segs.push(...segFor);
  const positional = rest.filter((t) => !segFor.some((s) => s.start === t.start && s.role !== 'image'));
  const readVerbs = new Set(['ps', 'images', 'logs', 'inspect', 'exec', 'stats', 'top', 'port', 'history', 'network ls', 'volume ls', 'compose ps', 'system df', 'info', 'version']);

  const posSeg = (t: Tok, role: SegRole, label: string, explain: string, concept?: string): void => {
    p.segs.push(mk(t, role, label, explain, concept));
  };

  const err = (m: string): Parsed => ({ ...p, error: m });
  const cname = (t: Tok | undefined): string => (t ? t.text.replace(/^\//, '') : '');
  const need = (n: number, usage: string): string | null => (positional.length < n ? `"docker ${verb}" requires at least ${n} argument. Usage: ${usage}` : null);

  switch (verb) {
    case 'run':
    case 'create': {
      const imgTok = positional[0];
      if (!imgTok) return err(`"docker ${verb}" requires at least 1 argument. Usage: docker ${verb} [OPTIONS] IMAGE [COMMAND] [ARG...]`);
      const cmd = positional.slice(1).map((t) => t.text);
      if (cmd.length) p.segs.push(...positional.slice(1).map((t, i) => mk(t, 'cmd', 'command override', i === 0 ? 'Replaces the image\'s default command: this becomes PID 1 inside the container.' : 'Argument for the command.', 'pid1')));
      const mem = opts.memory?.[0];
      const act: Action = {
        action: verb === 'run' ? 'run_container' : 'create_container',
        image: imgTok.text,
        name: opts.name?.[0],
        ports: opts.publish,
        volumes: [...(opts.volume ?? []), ...(opts.tmpfs ?? []).map((t) => `tmpfs:${t.split(':')[0]}`)],
        network: opts.network?.[0],
        env: opts.env ? Object.fromEntries(opts.env.map((e) => (e.includes('=') ? [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)] : [e, '']))) : undefined,
        memory: mem,
        restart: opts.restart?.[0] as never,
        ...(verb === 'run' ? { cpus: opts.cpus ? parseFloat(opts.cpus[0]!) : undefined, pids: opts.pids ? parseInt(opts.pids[0]!, 10) : undefined, cmd: cmd.length ? cmd : undefined, detach: flags.has('-d') || flags.has('--detach'), privileged: flags.has('--privileged'), readOnly: flags.has('--read-only') } : {}),
      } as Action;
      stripUndefined(act);
      p.plan.push(act);
      p.autoRemove = flags.has('--rm');
      if (verb === 'run' && !(flags.has('-d') || flags.has('--detach'))) (act as { detach: boolean }).detach = false;
      return finish(p);
    }
    case 'start':
    case 'stop':
    case 'restart':
    case 'pause':
    case 'unpause': {
      const e = need(1, `docker ${verb} CONTAINER`);
      if (e) return err(e);
      for (const t of positional) {
        posSeg(t, 'arg', 'target', `The container to ${verb}.`, 'container');
        p.plan.push({ action: `${verb}_container`, target: `container:${cname(t)}` } as Action);
      }
      return finish(p);
    }
    case 'kill': {
      const e = need(1, 'docker kill [OPTIONS] CONTAINER');
      if (e) return err(e);
      posSeg(positional[0]!, 'arg', 'target', 'The container whose PID 1 receives the signal.', 'pid1');
      const sig = (opts.signal?.[0] ?? 'SIGKILL').toUpperCase().replace(/^(?!SIG)/, 'SIG');
      p.plan.push({ action: 'kill_process', target: `container:${cname(positional[0])}`, pid: 1, signal: sig });
      return finish(p);
    }
    case 'rm': {
      const e = need(1, 'docker rm [OPTIONS] CONTAINER');
      if (e) return err(e);
      for (const t of positional) {
        posSeg(t, 'arg', 'target', 'The container to delete.', 'container');
        p.plan.push({ action: 'remove_container', target: `container:${cname(t)}`, force: flags.has('-f') || flags.has('--force'), volumes: flags.has('-v') });
      }
      return finish(p);
    }
    case 'rmi': {
      const e = need(1, 'docker rmi [OPTIONS] IMAGE');
      if (e) return err(e);
      for (const t of positional) {
        posSeg(t, 'arg', 'target', 'The image to delete.', 'image');
        p.plan.push({ action: 'remove_image', target: `image:${normalizeRef(t.text)}`, force: flags.has('-f') || flags.has('--force') });
      }
      return finish(p);
    }
    case 'pull': {
      const e = need(1, 'docker pull IMAGE[:TAG]');
      if (e) return err(e);
      posSeg(positional[0]!, 'image', 'image resolution', 'The repository and tag to fetch from the registry.', 'registry');
      p.plan.push({ action: 'pull_image', ref: positional[0]!.text });
      return finish(p);
    }
    case 'build': {
      const tag = opts.tag?.[0];
      positional.forEach((t) => posSeg(t, 'arg', 'build context', 'The directory sent to BuildKit as the build context (the sample project here).', 'dockerfile'));
      p.plan.push({ action: 'build_image', tag });
      return finish(p);
    }
    case 'update': {
      const e = need(1, 'docker update [OPTIONS] CONTAINER');
      if (e) return err(e);
      const t = `container:${cname(positional[positional.length - 1])}`;
      posSeg(positional[positional.length - 1]!, 'arg', 'target', 'The running container whose cgroup limits change.', 'cgroups');
      if (opts.memory?.[0]) p.plan.push({ action: 'set_resource_limit', target: t, resource: 'memory', value: opts.memory[0] });
      if (opts.cpus?.[0]) p.plan.push({ action: 'set_resource_limit', target: t, resource: 'cpu', value: opts.cpus[0] });
      if (opts.pids?.[0]) p.plan.push({ action: 'set_resource_limit', target: t, resource: 'pids', value: opts.pids[0] });
      if (!p.plan.length) return err('docker update: provide --memory, --cpus or --pids-limit');
      return finish(p);
    }
    case 'network create': {
      const e = need(1, 'docker network create NAME');
      if (e) return err(e);
      posSeg(positional[0]!, 'arg', 'name', 'Name of the new bridge network.', 'network');
      p.plan.push({ action: 'create_network', name: positional[0]!.text });
      return finish(p);
    }
    case 'network rm': {
      const e = need(1, 'docker network rm NETWORK');
      if (e) return err(e);
      positional.forEach((t) => {
        posSeg(t, 'arg', 'target', 'Network to delete.', 'network');
        p.plan.push({ action: 'remove_network', name: t.text });
      });
      return finish(p);
    }
    case 'network connect':
    case 'network disconnect': {
      const e = need(2, `docker ${verb} NETWORK CONTAINER`);
      if (e) return err(e);
      posSeg(positional[0]!, 'arg', 'network', 'The network.', 'network');
      posSeg(positional[1]!, 'arg', 'container', 'The container.', 'container');
      p.plan.push({ action: verb === 'network connect' ? 'connect_network' : 'disconnect_network', container: `container:${cname(positional[1])}`, network: positional[0]!.text });
      return finish(p);
    }
    case 'volume create': {
      const e = need(1, 'docker volume create NAME');
      if (e) return err(e);
      posSeg(positional[0]!, 'arg', 'name', 'Name of the new volume.', 'volume');
      p.plan.push({ action: 'create_volume', name: positional[0]!.text });
      return finish(p);
    }
    case 'volume rm': {
      const e = need(1, 'docker volume rm VOLUME');
      if (e) return err(e);
      positional.forEach((t) => {
        posSeg(t, 'arg', 'target', 'Volume to delete (data is lost).', 'volume');
        p.plan.push({ action: 'remove_volume', name: t.text });
      });
      return finish(p);
    }
    case 'compose up':
      p.plan.push({ action: 'compose_up' });
      return finish(p);
    case 'compose down':
      p.plan.push({ action: 'compose_down' });
      return finish(p);
    case 'compose stop': {
      const e = need(1, 'docker compose stop SERVICE');
      if (e) return err(e);
      posSeg(positional[0]!, 'arg', 'service', 'The Compose service to stop.', 'compose');
      p.plan.push({ action: 'compose_stop_service', service: positional[0]!.text });
      return finish(p);
    }
    default:
      break;
  }
  if (readVerbs.has(verb)) {
    positional.forEach((t) => posSeg(t, 'arg', 'target', 'Object to look at.'));
    p.read = { kind: verb, args: positional.map((t) => t.text), flags: new Set([...flags, ...Object.keys(opts).map((k) => '--' + k)]) };
    (p.read as { tail?: number }).tail = opts.tail ? parseInt(opts.tail[0]!, 10) : undefined;
    return finish(p);
  }
  return err(`docker ${verb}: unsupported`);
}

function parseCurl(w: World, toks: Tok[], p: Parsed): Parsed {
  p.segs.push(mk(toks[0]!, 'bin', 'a client', 'curl sends an HTTP request from this host, like a browser would.'));
  const urlTok = toks.slice(1).find((t) => !t.text.startsWith('-'));
  if (!urlTok) {
    p.error = 'curl: try "curl localhost:8080"';
    return p;
  }
  p.segs.push(mk(urlTok, 'arg', 'destination', 'The address to call. localhost:PORT goes through a published port (iptables DNAT); a container IP is reached directly over the bridge.', 'port-publish'));
  const m = /^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/.exec(urlTok.text);
  if (!m) {
    p.error = `curl: (3) URL rejected: ${urlTok.text}`;
    return p;
  }
  const host = m[1]!;
  const port = m[2] ? parseInt(m[2], 10) : 80;
  let target: Container | undefined;
  let via: 'host-port' | 'ip' = 'host-port';
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    target = Object.values(w.containers).find((c) => c.ports.some((q) => q.host === port));
    if (!target) {
      // let the probe produce a good error against any container name-less target
      p.plan.push({ action: 'send_request', from: 'host', to: 'container:__none__', port });
      p.error = `curl: (7) Failed to connect to ${host} port ${port}: Connection refused (no container publishes host port ${port})`;
      p.plan = [];
      return p;
    }
  } else {
    via = 'ip';
    target = Object.values(w.containers).find((c) => Object.values(c.networks).some((n) => n.ip === host));
    if (!target) {
      p.error = `curl: (6) Could not resolve host: ${host} (the host cannot use container names; use localhost:PORT or a container IP)`;
      return p;
    }
  }
  p.plan.push({ action: 'send_request', from: 'host', to: `container:${target.name}`, port: via === 'ip' ? port : port });
  return p;
}

function stripUndefined(o: object): void {
  for (const k of Object.keys(o)) if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k];
}

function finish(p: Parsed): Parsed {
  p.segs.sort((a, b) => a.start - b.start);
  return p;
}

/* ------------------------------------------------------------ action -> text */

/** The docker command a semantic action corresponds to (used for timeline labels). */
export function actionToCommand(a: Action): string {
  switch (a.action) {
    case 'run_container': {
      const parts = ['docker run', a.detach === false ? '' : '-d'];
      if (a.name) parts.push(`--name ${a.name}`);
      for (const p of a.ports ?? []) parts.push(`-p ${p}`);
      for (const v of a.volumes ?? []) parts.push(`-v ${v}`);
      if (a.network) parts.push(`--network ${a.network}`);
      if (a.memory) parts.push(`-m ${a.memory}`);
      if (a.cpus) parts.push(`--cpus ${a.cpus}`);
      if (a.restart) parts.push(`--restart ${a.restart}`);
      parts.push(a.image, ...(a.cmd ?? []));
      return parts.filter(Boolean).join(' ');
    }
    case 'create_container':
      return `docker create ${a.name ? `--name ${a.name} ` : ''}${a.image}`;
    case 'pull_image':
      return `docker pull ${a.ref}`;
    case 'start_container':
    case 'stop_container':
    case 'restart_container':
    case 'pause_container':
    case 'unpause_container':
      return `docker ${a.action.replace('_container', '')} ${parseTarget(a.target).name}`;
    case 'remove_container':
      return `docker rm ${a.force ? '-f ' : ''}${parseTarget(a.target).name}`;
    case 'kill_process':
      return a.pid && a.pid !== 1 ? `docker exec ${parseTarget(a.target).name} kill ${a.pid}` : `docker kill ${parseTarget(a.target).name}`;
    case 'remove_image':
      return `docker rmi ${a.force ? '-f ' : ''}${parseTarget(a.target).name}`;
    case 'create_network':
      return `docker network create ${a.name}`;
    case 'remove_network':
      return `docker network rm ${a.name}`;
    case 'connect_network':
      return `docker network connect ${a.network} ${parseTarget(a.container).name}`;
    case 'disconnect_network':
      return `docker network disconnect ${a.network} ${parseTarget(a.container).name}`;
    case 'create_volume':
      return `docker volume create ${a.name}`;
    case 'remove_volume':
      return `docker volume rm ${a.name}`;
    case 'set_resource_limit':
      return `docker update --${a.resource === 'cpu' ? 'cpus' : a.resource === 'pids' ? 'pids-limit' : 'memory'} ${a.value ?? 'unlimited'} ${parseTarget(a.target).name}`;
    case 'stress':
      return `(stress) ${parseTarget(a.target).name} ${a.resource} ${a.amount >= 0 ? '+' : ''}${a.amount}${a.resource === 'memory' ? 'MB' : '%'}`;
    case 'write_data':
      return `(write ${a.count ?? 100} records) ${parseTarget(a.target).name}:${a.path}`;
    case 'fill_disk':
      return `(something outside Docker fills ${a.mb} MB of disk)`;
    case 'free_disk':
      return '(free the disk)';
    case 'set_condition':
      return `(lab) ${a.condition} → ${String(a.value)}`;
    case 'restart_host':
      return 'sudo reboot';
    case 'stop_daemon':
      return `systemctl stop ${a.daemon}`;
    case 'start_daemon':
      return `systemctl start ${a.daemon}`;
    case 'build_image':
      return `docker build -t ${a.tag ?? 'my-api:latest'} .`;
    case 'edit_dockerfile':
      return `(edit Dockerfile step ${a.step + 1})`;
    case 'compose_up':
      return 'docker compose up -d';
    case 'compose_down':
      return 'docker compose down';
    case 'compose_stop_service':
      return `docker compose stop ${a.service}`;
    case 'send_request':
      return `curl ${a.from === 'external' ? '(external) ' : a.from === 'host' ? '' : `(from ${parseTarget(a.from).name}) `}${parseTarget(a.to).name}${a.port ? ':' + a.port : ''}`;
    case 'advance_time':
      return `(time passes: ${a.ticks ?? 1})`;
    case 'connection_test':
      return '(connection test)';
  }
}

/* ------------------------------------------------------------ read-only output */

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n - 1) + ' ' : s + ' '.repeat(n - s.length));
const table = (rows: string[][]): string => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)) + 2);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, widths[i]!))).join('')).join('\n');
};

const ago = (w: World, tick: number | null): string => (tick === null ? '' : `${Math.max(0, w.tick - tick)} ticks`);
const statusOf = (w: World, c: Container): string => {
  if (c.state === 'running') return `Up ${ago(w, c.startedTick)}${c.health === 'healthy' ? ' (healthy)' : c.health === 'unhealthy' ? ' (unhealthy)' : ''}`;
  if (c.state === 'paused') return `Up ${ago(w, c.startedTick)} (Paused)`;
  if (c.state === 'exited') return `Exited (${c.exitCode}) ${ago(w, c.finishedTick)} ago`;
  return 'Created';
};

export function runRead(w: World, parsed: Parsed, events: WorldEvent[]): string {
  const r = parsed.read!;
  const all = r.flags.has('-a') || r.flags.has('--all');
  const ctr = (name: string | undefined): Container | undefined => (name ? findByName(w, name.replace(/^\//, '')) : undefined);
  switch (r.kind) {
    case 'ps': {
      const rows = [['CONTAINER ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS', 'PORTS', 'NAMES']];
      for (const c of Object.values(w.containers)) {
        if (!all && c.state !== 'running' && c.state !== 'paused') continue;
        rows.push([c.id.slice(0, 12), c.imageRef, `"${c.cmd.join(' ').slice(0, 20)}"`, ago(w, c.createdTick) + ' ago', statusOf(w, c), c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/${p.proto}`).join(', '), c.name]);
      }
      return table(rows);
    }
    case 'images': {
      const rows = [['REPOSITORY', 'TAG', 'IMAGE ID', 'ARCH', 'SIZE']];
      for (const i of Object.values(w.images)) {
        const [repo, tag] = i.ref.split(':');
        rows.push([repo!, tag!, short(i.id), i.arch, fmtMB(i.sizeMB)]);
      }
      return table(rows);
    }
    case 'logs': {
      const c = ctr(r.args[0]);
      if (!c) return `Error response from daemon: No such container: ${r.args[0] ?? ''}`;
      const lines = w.logs.filter((l) => l.container === c.name).map((l) => `[t=${l.tick}] ${l.msg}`);
      const tail = (r as { tail?: number }).tail;
      return (tail ? lines.slice(-tail) : lines).join('\n') || '(no output yet)';
    }
    case 'inspect': {
      const name = r.args[0] ?? '';
      const c = ctr(name);
      if (c) return JSON.stringify([inspectJson(w, c)], null, 2);
      const img = w.images[normalizeRef(name)];
      if (img) return JSON.stringify([{ Id: img.id, RepoTags: [img.ref], Architecture: img.arch, Os: img.os, Size: Math.round(img.sizeMB * 1048576), RootFS: { Type: 'layers', Layers: img.layers }, Config: { Cmd: img.config.cmd, Env: img.config.env, ExposedPorts: Object.fromEntries(img.config.exposed.map((p) => [`${p}/tcp`, {}])) } }], null, 2);
      const v = w.volumes[name];
      if (v) return JSON.stringify([{ Name: v.name, Driver: v.driver, Mountpoint: v.mountpoint, Scope: 'local' }], null, 2);
      const n = w.networks[name];
      if (n) return JSON.stringify([{ Name: n.name, Driver: n.driver, IPAM: { Config: [{ Subnet: n.subnet, Gateway: n.gateway }] }, Containers: Object.fromEntries(Object.values(w.containers).filter((x) => name in x.networks).map((x) => [x.id, { Name: x.name, IPv4Address: x.networks[name]!.ip + '/16' }])) }], null, 2);
      return `Error: No such object: ${name}`;
    }
    case 'top': {
      const c = ctr(r.args[0]);
      if (!c || c.state !== 'running') return `Error response from daemon: Container ${r.args[0] ?? ''} is not running`;
      const lines = ['UID    PID    PPID   CMD', `root   ${c.pid}   ${c.pid - 3}   ${c.process}`];
      for (const p of c.childProcs) lines.push(`root   ${c.pid + p.nsPid}   ${c.pid}   ${p.name}`);
      return lines.join('\n');
    }
    case 'stats': {
      const rows = [['CONTAINER', 'NAME', 'CPU %', 'MEM USAGE / LIMIT', 'MEM %', 'PIDS']];
      for (const c of Object.values(w.containers)) {
        if (c.state !== 'running') continue;
        const lim = c.limits.memoryMB ?? w.host.ramMB;
        rows.push([c.id.slice(0, 12), c.name, `${c.usage.cpuPct.toFixed(1)}%`, `${Math.round(c.usage.memMB)}MiB / ${c.limits.memoryMB ? Math.round(lim) + 'MiB' : w.host.ramMB + 'MiB (host)'}`, `${((c.usage.memMB / lim) * 100).toFixed(1)}%`, String(1 + c.childProcs.length)]);
      }
      return table(rows);
    }
    case 'port': {
      const c = ctr(r.args[0]);
      if (!c) return `Error response from daemon: No such container: ${r.args[0] ?? ''}`;
      return c.ports.map((p) => `${p.container}/${p.proto} -> 0.0.0.0:${p.host}`).join('\n') || '(no published ports)';
    }
    case 'history': {
      const img = w.images[normalizeRef(r.args[0] ?? '')];
      if (!img) return `Error response from daemon: No such image: ${r.args[0] ?? ''}`;
      const rows = [['IMAGE', 'CREATED BY', 'SIZE']];
      for (const h of [...img.history].reverse()) rows.push([h.layer ? short(h.layer) : '<missing>', h.instr.slice(0, 50), h.layer ? fmtMB(w.layers[h.layer]?.sizeMB ?? 0) : '0B']);
      return table(rows);
    }
    case 'network ls': {
      const rows = [['NETWORK ID', 'NAME', 'DRIVER', 'SUBNET']];
      for (const n of Object.values(w.networks)) rows.push([short(n.bridgeIf || n.name, 12), n.name, n.driver, n.subnet || '—']);
      return table(rows);
    }
    case 'volume ls': {
      const rows = [['DRIVER', 'VOLUME NAME', 'RECORDS']];
      for (const v of Object.values(w.volumes)) rows.push([v.driver, v.name, String(v.items)]);
      return table(rows);
    }
    case 'compose ps': {
      const rows = [['NAME', 'SERVICE', 'STATUS', 'PORTS']];
      for (const c of Object.values(w.containers)) if (c.compose) rows.push([c.name, c.compose.service, statusOf(w, c), c.ports.map((p) => `${p.host}->${p.container}`).join(', ')]);
      return rows.length > 1 ? table(rows) : 'no project is running (docker compose up -d)';
    }
    case 'system df': {
      const rows = [['TYPE', 'TOTAL', 'ACTIVE', 'SIZE']];
      rows.push(['Images', String(Object.keys(w.images).length), String(new Set(Object.values(w.containers).map((c) => c.imageId)).size), fmtMB(imageSizeOnDisk(w))]);
      rows.push(['Containers', String(Object.keys(w.containers).length), String(Object.values(w.containers).filter((c) => c.state === 'running').length), fmtMB(Object.values(w.containers).reduce((a, c) => a + c.layerData.items * 0.04 + 0.1, 0))]);
      rows.push(['Local Volumes', String(Object.keys(w.volumes).length), String(Object.keys(w.volumes).length), fmtMB(Object.values(w.volumes).reduce((a, v) => a + v.sizeMB, 0))]);
      return table(rows) + `\n\nhost disk: ${fmtMB(diskUsedMB(w))} used, ${fmtMB(Math.max(0, diskFreeMB(w)))} free`;
    }
    case 'info':
      return [`Containers: ${Object.keys(w.containers).length} (running ${Object.values(w.containers).filter((c) => c.state === 'running').length})`, `Images: ${Object.keys(w.images).length}`, `Server Version: ${w.daemons.dockerd.version}`, 'Storage Driver: overlay2', 'Cgroup Version: 2', `Kernel Version: ${w.host.kernel}`, `Operating System: ${w.host.os}`, `CPUs: ${w.host.cpuCores}`, `Total Memory: ${w.host.ramMB} MiB (used ${Math.round(hostMemUsedMB(w))})`, `containerd version: ${w.daemons.containerd.version}`, `runc version: ${w.daemons.runc.version}`, 'Live Restore Enabled: false'].join('\n');
    case 'version':
      return `Client: Docker CLI (simulated)\nServer: Docker Engine ${w.daemons.dockerd.version}\n containerd ${w.daemons.containerd.version}\n runc ${w.daemons.runc.version}`;
    case 'exec': {
      const c = ctr(r.args[0]);
      if (!c) return `Error response from daemon: No such container: ${r.args[0] ?? ''}`;
      if (c.state !== 'running') return `Error response from daemon: container ${c.id} is not running`;
      return execIn(w, c, r.args.slice(1));
    }
    default:
      void events;
      return '';
  }
}

function inspectJson(w: World, c: Container): unknown {
  return {
    Id: c.id,
    Name: '/' + c.name,
    State: { Status: c.state, Running: c.state === 'running', Paused: c.state === 'paused', ExitCode: c.exitCode ?? 0, OOMKilled: c.oomKilled, Pid: c.pid, Error: c.error, Health: c.health === 'none' ? undefined : { Status: c.health } },
    Image: c.imageId,
    Config: { Image: c.imageRef, Cmd: c.cmd, Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`) },
    HostConfig: { Memory: c.limits.memoryMB ? c.limits.memoryMB * 1048576 : 0, NanoCpus: c.limits.cpus ? c.limits.cpus * 1e9 : 0, PidsLimit: c.limits.pids ?? 0, RestartPolicy: { Name: c.restartPolicy }, PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.container}/${p.proto}`, [{ HostPort: String(p.host) }]])), Privileged: c.security.privileged },
    NetworkSettings: { Networks: Object.fromEntries(Object.entries(c.networks).map(([n, a]) => [n, { IPAddress: a.ip, Gateway: w.networks[n]?.gateway }])) },
    Mounts: c.mounts.map((m) => ({ Type: m.type, Name: m.type === 'volume' ? m.source : undefined, Source: m.type === 'volume' ? w.volumes[m.source]?.mountpoint : m.source, Destination: m.target, RW: !m.readOnly })),
  };
}

function execIn(w: World, c: Container, argv: string[]): string {
  const cmd = argv.join(' ').trim();
  const kv = kernelView(w, c);
  if (!cmd || cmd === 'sh' || cmd === 'bash') return '(an interactive shell needs a TTY; try: docker exec web ps, ls /, hostname, ip a, cat /proc/1/cgroup)';
  if (/^(ps|ps aux|ps -ef)$/.test(cmd)) {
    const lines = ['PID   USER     COMMAND', `  1   root     ${c.cmd.join(' ')}`];
    for (const p of c.childProcs) lines.push(`${String(p.nsPid).padStart(3)}   ${c.security.user === 'root' ? 'root' : c.security.user}     ${p.name}`);
    lines.push(`${String(8 + c.childProcs.length).padStart(3)}   root     ps`);
    return lines.join('\n');
  }
  if (cmd === 'hostname') return c.id.slice(0, 12);
  if (cmd === 'whoami') return c.security.user;
  if (cmd === 'id') return c.security.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)' : `uid=1000(${c.security.user})`;
  if (cmd === 'uname -r') return w.host.kernel + '   # the HOST kernel: containers have none of their own';
  if (cmd === 'env') return Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join('\n') + `\nHOSTNAME=${c.id.slice(0, 12)}`;
  if (/^ip (a|addr|address)$/.test(cmd)) return kv.net.interfaces.map((i) => `${i.name}: inet ${i.ip}${i.peer ? `   (veth peer ${i.peer} on ${i.bridge})` : ''}`).join('\n');
  if (cmd === 'cat /etc/resolv.conf') return kv.net.resolv.join('\n');
  if (cmd === 'cat /proc/1/cgroup') return `0::/system.slice/docker-${c.id}.scope`;
  if (cmd === 'cat /sys/fs/cgroup/memory.max') return kv.cgroup.files.find((f) => f[0] === 'memory.max')![1];
  if (cmd === 'cat /sys/fs/cgroup/memory.current') return kv.cgroup.files.find((f) => f[0] === 'memory.current')![1];
  if (cmd === 'cat /sys/fs/cgroup/cpu.max') return kv.cgroup.files.find((f) => f[0] === 'cpu.max')![1];
  if (cmd === 'cat /sys/fs/cgroup/pids.max') return kv.cgroup.files.find((f) => f[0] === 'pids.max')![1];
  if (cmd === 'mount') return kv.mounts.map((m) => `${m.source} on ${m.target} type ${m.type} (${m.options})`).join('\n');
  if (/^df( -h)?$/.test(cmd)) return `Filesystem   Size  Used  Avail  Mounted on\noverlay      ${fmtMB(w.host.diskMB)}  ${fmtMB(diskUsedMB(w))}  ${fmtMB(Math.max(0, diskFreeMB(w)))}  /`;
  const ls = /^ls(?: -\w+)?(?: (\S+))?$/.exec(cmd);
  if (ls) {
    const path = ls[1] ?? '/';
    const m = c.mounts.find((x) => path === x.target || path.startsWith(x.target + '/'));
    if (m?.type === 'volume') return `${w.volumes[m.source]?.items ?? 0} records in volume ${m.source}`;
    if (m?.type === 'bind') return `${w.host.paths[m.source]?.items ?? 0} entries from host dir ${m.source}`;
    if (path === c.workload.dataDir && c.workload.imageHasData) return 'index.html  50x.html';
    if (path === '/') return 'bin  dev  etc  home  lib  proc  root  sys  tmp  usr  var';
    return `(${path}: contents come from the image layers + this container's ${c.layerData.items} written records)`;
  }
  const echo = /^echo (.*)$/.exec(cmd);
  if (echo) return echo[1]!;
  if (/^kill (-\d+ )?\d+$/.test(cmd)) return '(use the Lab or `docker kill` — signals are simulated through the world actions)';
  return `sh: ${argv[0]}: not found (this simulated shell knows: ps, ls, hostname, whoami, id, env, uname -r, ip a, mount, df -h, cat /proc/1/cgroup, cat /sys/fs/cgroup/memory.max)`;
}

export function helpText(): string {
  return [
    'Try these (everything is simulated; nothing touches a real Docker daemon):',
    '  docker run -d --name web -p 8080:80 nginx',
    '  docker run -d --name db -v mydata:/var/lib/postgresql/data -m 256m postgres:16',
    '  docker ps -a            docker images          docker logs web',
    '  docker stop web         docker rm -f web       docker inspect web',
    '  docker exec web ps      docker exec web cat /proc/1/cgroup',
    '  docker network create appnet     docker network connect appnet web',
    '  docker update --memory 64m db',
    '  docker build -t my-api:latest .   docker compose up -d',
    '  curl localhost:8080',
  ].join('\n');
}

/** Process tree text used by `top`-style views elsewhere. */
export function treeText(n: ProcNode, d = 0): string {
  return [`${'  '.repeat(d)}${n.name} [${n.hostPid}]`, ...n.children.map((c) => treeText(c, d + 1))].join('\n');
}
void processTree;
