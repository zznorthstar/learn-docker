import type { Action, PredictionOption, World, WorldEvent } from './types';

/**
 * Experiments. Each one starts from a known preset, applies a deliberate
 * break, and carries a prediction question whose answer is machine-verified
 * against the simulation (see tests/unit/scenarios.test.ts) so the lesson can
 * never silently disagree with the simulator.
 */

export interface Scenario {
  id: string;
  title: string;
  /** one line: the "what if I…" */
  whatIf: string;
  concepts: string[];
  preset: 'empty' | 'welcome' | 'persistence' | 'shop';
  setup: Action[];
  steps: Action[];
  ask: { question: string; options: PredictionOption[]; answer: string; explanation: string };
  /** returns true when the simulation outcome matches ask.answer */
  verify: (w: World, events: WorldEvent[]) => boolean;
}

const opt = (...labels: string[]): PredictionOption[] => labels.map((label, i) => ({ id: String.fromCharCode(97 + i), label }));
const has = (events: WorldEvent[], kind: string): boolean => events.some((e) => e.kind === kind);

export const SCENARIOS: Scenario[] = [
  {
    id: 'delete-container',
    title: 'Delete the containers',
    whatIf: 'What if I delete a container that has data in it?',
    concepts: ['writable-layer', 'volume', 'container'],
    preset: 'persistence',
    setup: [],
    steps: [
      { action: 'remove_container', target: 'container:cache-vol', force: true },
      { action: 'remove_container', target: 'container:cache-tmp', force: true },
    ],
    ask: {
      question: 'Two redis containers each hold 120 records. cache-vol keeps them on a volume, cache-tmp in its own writable layer. We delete BOTH containers. What survives?',
      options: opt('Everything: Docker keeps all data', 'Only the 120 records on the volume', 'Nothing: all data is gone', 'Only the image, no data'),
      answer: 'b',
      explanation: 'A container\'s writable layer is deleted with the container. A volume is a separate object: it outlives any container that mounted it.',
    },
    verify: (w, ev) => w.volumes.mydata?.items === 120 && !w.containers['cache-tmp'] && has(ev, 'container.data_lost'),
  },
  {
    id: 'volume-survives',
    title: 'Re-attach the volume',
    whatIf: 'What if I replace a database container with a new one?',
    concepts: ['volume', 'container', 'lifecycle'],
    preset: 'empty',
    setup: [
      { action: 'run_container', image: 'redis:7', name: 'cache', volumes: ['mydata:/data'], detach: true },
      { action: 'write_data', target: 'container:cache', path: '/data', count: 80 },
    ],
    steps: [
      { action: 'remove_container', target: 'container:cache', force: true },
      { action: 'run_container', image: 'redis:7', name: 'cache2', volumes: ['mydata:/data'], detach: true },
    ],
    ask: {
      question: 'cache wrote 80 records to the volume mydata. We remove cache and start a brand-new container, cache2, mounting mydata. How many records can cache2 see?',
      options: opt('0: new container, empty start', '80: the volume kept everything', '40: half survive', 'It refuses to start: volume already used'),
      answer: 'b',
      explanation: 'The new container mounts the same directory on the host. The data was never inside the old container.',
    },
    verify: (w) => w.volumes.mydata?.items === 80 && w.containers.cache2?.state === 'running',
  },
  {
    id: 'delete-volume',
    title: 'Delete a volume in use',
    whatIf: 'What if I delete a volume that a stopped container still uses?',
    concepts: ['volume', 'container'],
    preset: 'persistence',
    setup: [],
    steps: [
      { action: 'stop_container', target: 'container:cache-vol' },
      { action: 'remove_volume', name: 'mydata' },
    ],
    ask: {
      question: 'cache-vol is STOPPED (not removed). We run `docker volume rm mydata`. What happens?',
      options: opt('The volume is deleted: the container is not running', 'Docker refuses: even a stopped container still references it', 'The volume is emptied but kept', 'The container is removed automatically'),
      answer: 'b',
      explanation: 'References from containers (running or not) protect a volume. Remove the container first; then the volume can be deleted, taking its data with it.',
    },
    verify: (w, ev) => !!w.volumes.mydata && ev.some((e) => e.kind === 'volume.remove.failed'),
  },
  {
    id: 'kill-pid1',
    title: 'Kill PID 1',
    whatIf: 'What if the main process of a container is killed?',
    concepts: ['pid1', 'signals', 'restart-policy', 'exit-codes'],
    preset: 'empty',
    setup: [{ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], restart: 'always', detach: true }],
    steps: [{ action: 'kill_process', target: 'container:web', pid: 1 }],
    ask: {
      question: 'web runs with --restart always. Someone runs `kill -9` on its PID 1. What do we see a moment later?',
      options: opt('Container gone for good', 'Container running again with a new PID and a restart count of 1', 'Container stays exited (137)', 'The host restarts'),
      answer: 'b',
      explanation: 'When PID 1 dies the whole PID namespace dies with it (the container exits 137). dockerd sees the exit and, because of the "always" policy, starts a fresh process.',
    },
    verify: (w) => w.containers.web?.state === 'running' && w.containers.web.restartCount === 1,
  },
  {
    id: 'kill-worker',
    title: 'Kill a worker process',
    whatIf: 'What if I kill a process that is NOT PID 1?',
    concepts: ['process', 'pid1', 'pid-ns'],
    preset: 'welcome',
    setup: [],
    steps: [{ action: 'kill_process', target: 'container:web', pid: 7 }],
    ask: {
      question: 'nginx runs a master (PID 1) and worker processes inside web. We kill worker PID 7. Does the container stop?',
      options: opt('Yes: any killed process stops the container', 'No: PID 1 is alive, and the master respawns the worker', 'It restarts the whole host', 'The container is paused'),
      answer: 'b',
      explanation: 'A container lives exactly as long as its PID 1. Other processes can come and go.',
    },
    verify: (w, ev) => w.containers.web?.state === 'running' && has(ev, 'process.respawned'),
  },
  {
    id: 'no-network',
    title: 'Cut a container off the network',
    whatIf: 'What if a container loses its network?',
    concepts: ['network', 'service-discovery', 'veth'],
    preset: 'empty',
    setup: [
      { action: 'create_network', name: 'appnet' },
      { action: 'run_container', image: 'redis:7', name: 'cache', network: 'appnet', detach: true },
      { action: 'run_container', image: 'alpine:3.20', name: 'client', network: 'appnet', cmd: ['sleep', '3600'], detach: true },
      { action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 },
    ],
    steps: [
      { action: 'disconnect_network', container: 'container:client', network: 'appnet' },
      { action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 },
    ],
    ask: {
      question: 'client reaches cache by name over the network appnet. We disconnect client from appnet and try again. What happens?',
      options: opt('Still works: Docker finds another route', 'Fails: no shared network, so no DNS name and no route', 'Works but slower', 'The cache container restarts'),
      answer: 'b',
      explanation: 'Reachability between containers needs a shared network. Disconnecting removes the veth pair, the DNS entry and the route.',
    },
    verify: (w) => {
      const last = w.requests[w.requests.length - 1];
      return !!last && !last.ok;
    },
  },
  {
    id: 'break-dns',
    title: 'Break DNS',
    whatIf: 'What if upstream DNS goes down?',
    concepts: ['dns', 'service-discovery', 'registry'],
    preset: 'empty',
    setup: [
      { action: 'create_network', name: 'appnet' },
      { action: 'run_container', image: 'redis:7', name: 'cache', network: 'appnet', detach: true },
      { action: 'run_container', image: 'alpine:3.20', name: 'client', network: 'appnet', cmd: ['sleep', '3600'], detach: true },
    ],
    steps: [
      { action: 'set_condition', condition: 'dns', value: false },
      { action: 'pull_image', ref: 'busybox' },
      { action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379 },
    ],
    ask: {
      question: 'The host\'s upstream DNS dies. Which of these still works? (a) docker pull busybox, (b) client reaching cache by name on the same user-defined network.',
      options: opt('Both still work', 'Only (b): container names are answered by Docker\'s own DNS', 'Only (a)', 'Neither works'),
      answer: 'b',
      explanation: 'Container-to-container names are answered by dockerd\'s embedded DNS (127.0.0.11) and never leave the host. The registry hostname needs real DNS.',
    },
    verify: (w, ev) => ev.some((e) => e.kind === 'action.failed' && /lookup registry/.test(e.summary)) && !!w.requests[w.requests.length - 1]?.ok,
  },
  {
    id: 'fill-disk',
    title: 'Fill the disk',
    whatIf: 'What if the disk fills up?',
    concepts: ['disk', 'overlayfs', 'volume'],
    preset: 'empty',
    setup: [
      { action: 'run_container', image: 'postgres:16', name: 'db', detach: true },
      { action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], detach: true },
    ],
    steps: [{ action: 'fill_disk', mb: 30000 }],
    ask: {
      question: 'A runaway process outside Docker fills the whole disk. A postgres container and an nginx container are running. Which is more likely to crash?',
      options: opt('nginx: it serves files from disk', 'postgres: it must write its transaction log', 'Both crash at the same moment', 'Neither: containers have private disks'),
      answer: 'b',
      explanation: 'Databases write constantly and fail hard on ENOSPC. A static web server mostly reads. All containers share the host\'s one filesystem.',
    },
    verify: (w) => w.containers.db?.state === 'exited' && w.containers.web?.state === 'running',
  },
  {
    id: 'reduce-memory',
    title: 'Squeeze the memory limit',
    whatIf: 'What if I lower a container\'s memory limit below what it is using?',
    concepts: ['memory-limit', 'cgroups', 'oom-killer', 'exit-codes'],
    preset: 'empty',
    setup: [
      { action: 'run_container', image: 'postgres:16', name: 'db', ports: ['5432:5432'], detach: true },
      { action: 'stress', target: 'container:db', resource: 'memory', amount: 40 },
    ],
    steps: [{ action: 'set_resource_limit', target: 'container:db', resource: 'memory', value: '64MB' }],
    ask: {
      question: 'db uses about 98 MB. We run `docker update --memory 64m db`. What happens?',
      options: opt('It slows down while the kernel swaps', 'The kernel kills it: OOM, exit code 137', 'Docker refuses the update', 'It keeps its 98 MB until restart'),
      answer: 'b',
      explanation: 'Writing memory.max below current usage makes the kernel reclaim memory; when it cannot, the cgroup OOM killer sends SIGKILL. Unlike CPU, memory is not compressible.',
    },
    verify: (w) => w.containers.db?.oomKilled === true && w.containers.db.exitCode === 137,
  },
  {
    id: 'memory-leak',
    title: 'A leaking app',
    whatIf: 'What if an app leaks memory under a limit?',
    concepts: ['memory-limit', 'oom-killer', 'process'],
    preset: 'empty',
    setup: [{ action: 'run_container', image: 'leaky:latest', name: 'leak', ports: ['9000:8080'], memory: '128MB', detach: true }],
    steps: [{ action: 'advance_time', ticks: 10 }],
    ask: {
      question: 'leaky grows 14 MB every tick from a 40 MB start; its limit is 128 MB. After 10 ticks…',
      options: opt('It is still running, just heavy', 'The kernel OOM-killed it when it crossed 128 MB', 'Docker restarted it politely', 'The host ran out of memory first'),
      answer: 'b',
      explanation: 'The limit caught it first: the cgroup OOM killer acts at 128 MB, long before the host (4 GB) is in danger. That is exactly what limits are for.',
    },
    verify: (w) => w.containers.leak?.oomKilled === true,
  },
  {
    id: 'port-conflict',
    title: 'Two containers, one port',
    whatIf: 'What if two containers want the same host port?',
    concepts: ['port-publish', 'iptables'],
    preset: 'empty',
    setup: [{ action: 'run_container', image: 'nginx', name: 'first', ports: ['8080:80'], detach: true }],
    steps: [{ action: 'run_container', image: 'nginx', name: 'second', ports: ['8080:80'], detach: true }],
    ask: {
      question: 'first already publishes host port 8080. We `docker run -p 8080:80` a second nginx. What state is the second container in?',
      options: opt('Running on 8081 automatically', 'Running, and first stops', 'Created but NOT started: "port is already allocated"', 'Never created at all'),
      answer: 'c',
      explanation: 'Docker creates the container first, then fails to start it when it cannot bind the host port. It exists in the "created" state until you fix the conflict.',
    },
    verify: (w) => w.containers.second?.state === 'created' && w.containers.first?.state === 'running',
  },
  {
    id: 'wrong-port',
    title: 'Publish the wrong port',
    whatIf: 'What if I map the host port to a port the app is not listening on?',
    concepts: ['port-publish', 'net-ns'],
    preset: 'empty',
    setup: [{ action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:8080'], detach: true }],
    steps: [{ action: 'send_request', from: 'external', to: 'container:web', port: 8080 }],
    ask: {
      question: 'nginx listens on port 80 inside the container, but we ran `-p 8080:8080`. A browser visits host port 8080. What happens?',
      options: opt('The page loads: Docker is smart about ports', 'Connection reset: the packet arrives but nothing listens on 8080 inside', 'Connection timeout: the packet is dropped', '404 from nginx'),
      answer: 'b',
      explanation: 'The DNAT rule faithfully forwards to container-ip:8080, where no process listens, so the kernel answers with a reset. The second number of -p must be the app\'s real port.',
    },
    verify: (w) => /reset/.test(w.requests[w.requests.length - 1]?.reason ?? ''),
  },
  {
    id: 'registry-down',
    title: 'Registry goes away',
    whatIf: 'What if the registry is unreachable?',
    concepts: ['registry', 'image', 'oci-distribution'],
    preset: 'empty',
    setup: [{ action: 'pull_image', ref: 'nginx' }],
    steps: [
      { action: 'set_condition', condition: 'registry', value: false },
      { action: 'pull_image', ref: 'redis:7' },
      { action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], detach: true },
    ],
    ask: {
      question: 'The registry becomes unreachable. We have nginx locally but not redis. What works?',
      options: opt('Nothing: Docker needs the registry for everything', 'Running nginx works; pulling redis fails', 'Both work: Docker caches everything', 'Only pulling redis works'),
      answer: 'b',
      explanation: 'Images already in local storage never need the registry again. Only pulls of missing layers do.',
    },
    verify: (w) => w.containers.web?.state === 'running' && !w.images['redis:7'],
  },
  {
    id: 'wrong-mount',
    title: 'Mount the wrong path',
    whatIf: 'What if I bind-mount the wrong host directory?',
    concepts: ['bind-mount', 'mnt-ns', 'volume'],
    preset: 'empty',
    setup: [],
    steps: [
      { action: 'run_container', image: 'nginx', name: 'web', ports: ['8080:80'], volumes: ['/srv/wrong:/usr/share/nginx/html'], detach: true },
      { action: 'send_request', from: 'external', to: 'container:web', port: 8080 },
    ],
    ask: {
      question: 'The real site lives in /srv/site, but we typed -v /srv/wrong:/usr/share/nginx/html (a directory that does not exist yet). What does the browser get?',
      options: opt('Docker errors: bind source does not exist', 'The default nginx page: the image content shows through', '403 Forbidden: an empty directory now hides the image\'s files', 'The site from /srv/site'),
      answer: 'c',
      explanation: 'With -v, Docker silently creates the missing host directory, then mounts it over the image\'s html folder. The mount hides what the image baked in.',
    },
    verify: (w) => w.requests[w.requests.length - 1]?.status === 403,
  },
  {
    id: 'restart-service',
    title: 'Restart a service',
    whatIf: 'What if I restart a container?',
    concepts: ['lifecycle', 'process', 'restart-policy'],
    preset: 'welcome',
    setup: [],
    steps: [{ action: 'restart_container', target: 'container:web' }],
    ask: {
      question: 'We `docker restart web`. Which is true afterwards?',
      options: opt('Same process, just reloaded', 'A new process with a new PID; memory starts clean; the writable layer is kept', 'A new container with a new ID', 'The image is re-pulled'),
      answer: 'b',
      explanation: 'Restart stops the old process (SIGTERM, then SIGKILL) and starts a new one in the same container: same ID and writable layer, new PID.',
    },
    verify: (w, ev) => w.containers.web?.state === 'running' && has(ev, 'process.started'),
  },
  {
    id: 'restart-host',
    title: 'Reboot the host',
    whatIf: 'What if the whole machine reboots?',
    concepts: ['restart-policy', 'daemon-restart', 'host'],
    preset: 'empty',
    setup: [
      { action: 'run_container', image: 'nginx', name: 'keeper', restart: 'unless-stopped', detach: true },
      { action: 'run_container', image: 'redis:7', name: 'plain', detach: true },
      { action: 'run_container', image: 'redis:7', name: 'parked', restart: 'unless-stopped', detach: true },
      { action: 'stop_container', target: 'container:parked' },
    ],
    steps: [{ action: 'restart_host' }],
    ask: {
      question: 'keeper (unless-stopped), plain (no policy) and parked (unless-stopped, but we stopped it by hand) all exist. After a reboot, which are running?',
      options: opt('All three', 'Only keeper', 'keeper and parked', 'None: containers never survive reboots'),
      answer: 'b',
      explanation: '"no" never restarts; "unless-stopped" restarts unless YOU stopped it, so parked stays down on purpose.',
    },
    verify: (w) => w.containers.keeper?.state === 'running' && w.containers.plain?.state === 'exited' && w.containers.parked?.state === 'exited',
  },
  {
    id: 'wrong-arch',
    title: 'Run the wrong architecture',
    whatIf: 'What if the image was built for a different CPU?',
    concepts: ['platform', 'kernel', 'image'],
    preset: 'empty',
    setup: [],
    steps: [{ action: 'run_container', image: 'arm-demo:latest', name: 'demo', detach: true }],
    ask: {
      question: 'This host is amd64. We run an image built only for arm64. What happens?',
      options: opt('Docker translates it transparently', 'It starts then exits at once with "exec format error"', 'Docker refuses to pull it', 'It runs at half speed'),
      answer: 'b',
      explanation: 'The kernel cannot execute a foreign instruction set. Docker pulls it (with a warning) and the exec fails. Emulation (qemu) must be set up explicitly.',
    },
    verify: (w) => w.containers.demo?.exitCode === 255,
  },
  {
    id: 'rebuild-one-layer',
    title: 'Change one layer',
    whatIf: 'What if I change one early step of the Dockerfile?',
    concepts: ['build-cache', 'layer', 'dockerfile'],
    preset: 'empty',
    setup: [{ action: 'build_image' }],
    steps: [
      { action: 'edit_dockerfile', step: 2 },
      { action: 'build_image' },
    ],
    ask: {
      question: 'The first build is done. Now package.json changes (step 3, COPY package*.json). Rebuild: which steps run again?',
      options: opt('Only step 3', 'Step 3 and everything after it, including npm ci', 'Nothing: everything is cached', 'Everything from FROM onwards'),
      answer: 'b',
      explanation: 'A layer is built on top of its parent. Change step 3 and every layer above it is invalid. This is why Dockerfiles copy dependency manifests BEFORE source code.',
    },
    verify: (w) => {
      const s = w.build.last!.steps;
      return s[1]!.cached && !s[2]!.cached && !s[3]!.cached && !s[4]!.cached;
    },
  },
  {
    id: 'cache-bust-order',
    title: 'Change only the source',
    whatIf: 'What if I change only application source code?',
    concepts: ['build-cache', 'layer'],
    preset: 'empty',
    setup: [{ action: 'build_image' }],
    steps: [
      { action: 'edit_dockerfile', step: 4 },
      { action: 'build_image' },
    ],
    ask: {
      question: 'We edit only app source (affecting step 5, COPY . .). Does `npm ci` (step 4) run again on rebuild?',
      options: opt('Yes, always', 'No: step 4 comes before the change, so it is cached', 'Only if the network is up', 'Docker asks you'),
      answer: 'b',
      explanation: 'Only steps at and after the changed one are rebuilt. Putting rarely-changing steps first keeps rebuilds fast.',
    },
    verify: (w) => {
      const s = w.build.last!.steps;
      return s[3]!.cached && !s[4]!.cached;
    },
  },
  {
    id: 'delete-local-image',
    title: 'Delete an image in use',
    whatIf: 'What if I delete an image a container is using?',
    concepts: ['image', 'container', 'layer'],
    preset: 'welcome',
    setup: [],
    steps: [
      { action: 'remove_image', target: 'image:nginx:latest' },
      { action: 'remove_container', target: 'container:web', force: true },
      { action: 'remove_image', target: 'image:nginx:latest' },
    ],
    ask: {
      question: 'web is running from nginx:latest. We `docker rmi nginx`. What happens?',
      options: opt('The image is deleted and web keeps running', 'Docker refuses: a container uses it', 'web is killed and the image deleted', 'The image is hidden but not deleted'),
      answer: 'b',
      explanation: 'A container\'s read-only layers come from its image, so Docker refuses (unless forced). After the container is removed, the image and any unshared layers are deleted.',
    },
    verify: (w, ev) => ev.some((e) => e.kind === 'action.failed' && /container .* is using/.test(e.summary)) && !w.images['nginx:latest'],
  },
  {
    id: 'break-compose-dependency',
    title: 'Break a Compose dependency',
    whatIf: 'What if the database of a Compose app stops?',
    concepts: ['compose', 'service-discovery', 'healthcheck'],
    preset: 'shop',
    setup: [],
    steps: [
      { action: 'compose_stop_service', service: 'db' },
      { action: 'send_request', from: 'external', to: 'container:shop-web-1', port: 8080 },
    ],
    ask: {
      question: 'The shop runs web → api → db. We stop ONLY db. A visitor loads the site on port 8080. What do they see?',
      options: opt('The normal page: web is still running', '502: web is up but its upstream (api → db) is failing', 'Connection refused', 'The whole project stops'),
      answer: 'b',
      explanation: 'Every container is still running except db, but api cannot reach it and web cannot reach api: running is not the same as working.',
    },
    verify: (w) => w.requests[w.requests.length - 1]?.status === 502,
  },
  {
    id: 'containerd-down',
    title: 'Stop containerd',
    whatIf: 'What if containerd stops while containers are running?',
    concepts: ['containerd', 'shim', 'daemon-restart'],
    preset: 'welcome',
    setup: [],
    steps: [
      { action: 'stop_daemon', daemon: 'containerd' },
      { action: 'run_container', image: 'redis:7', name: 'cache', detach: true },
      { action: 'send_request', from: 'external', to: 'container:web', port: 8080 },
    ],
    ask: {
      question: 'containerd is stopped. What about the already-running web container and a NEW redis run?',
      options: opt('web dies; the new run works', 'web keeps serving (its shim holds it); the new run fails', 'Both keep working', 'Both fail'),
      answer: 'b',
      explanation: 'Each container is held by its own shim process, independent of containerd and dockerd. But creating a NEW container needs containerd.',
    },
    verify: (w) => w.containers.web?.state === 'running' && !w.containers.cache?.pid && !!w.requests[w.requests.length - 1]?.ok,
  },
  {
    id: 'cpu-throttle',
    title: 'Burn the CPU',
    whatIf: 'What if a CPU-limited container tries to use more CPU?',
    concepts: ['cpu-limit', 'cgroups'],
    preset: 'empty',
    setup: [{ action: 'run_container', image: 'nginx', name: 'web', cpus: 0.5, detach: true }],
    steps: [{ action: 'stress', target: 'container:web', resource: 'cpu', amount: 300 }],
    ask: {
      question: 'web is limited to 0.5 CPU and suddenly tries to burn 3 cores. What happens?',
      options: opt('It is killed (like memory)', 'It is throttled: it runs slower but stays alive', 'It moves to another host', 'The limit is ignored'),
      answer: 'b',
      explanation: 'CPU is compressible: the kernel simply withholds CPU time (cpu.max quota). Memory is not, which is why memory overruns kill and CPU overruns slow.',
    },
    verify: (w, ev) => w.containers.web?.state === 'running' && has(ev, 'cgroup.cpu.throttled'),
  },
  {
    id: 'isolated-networks',
    title: 'Two separate networks',
    whatIf: 'What if two containers are on different networks?',
    concepts: ['network', 'iptables', 'bridge'],
    preset: 'empty',
    setup: [
      { action: 'create_network', name: 'frontend' },
      { action: 'create_network', name: 'backend' },
      { action: 'run_container', image: 'redis:7', name: 'cache', network: 'backend', detach: true },
      { action: 'run_container', image: 'alpine:3.20', name: 'proxy', network: 'frontend', cmd: ['sleep', '3600'], detach: true },
    ],
    steps: [
      { action: 'send_request', from: 'container:proxy', to: 'container:cache', port: 6379 },
      { action: 'connect_network', container: 'container:proxy', network: 'backend' },
      { action: 'send_request', from: 'container:proxy', to: 'container:cache', port: 6379 },
    ],
    ask: {
      question: 'proxy is on "frontend", cache on "backend". Can proxy reach cache? Then we also attach proxy to "backend".',
      options: opt('Yes both times', 'No at first, yes after attaching to backend', 'No both times', 'Yes at first, no after'),
      answer: 'b',
      explanation: 'Bridges are isolated by iptables. A container on two networks (two veth pairs) bridges between them.',
    },
    verify: (w) => w.requests.length >= 2 && !w.requests[w.requests.length - 2]!.ok && w.requests[w.requests.length - 1]!.ok,
  },
  {
    id: 'name-resolution',
    title: 'Names on the default bridge',
    whatIf: 'What if I try to use a container name on the default network?',
    concepts: ['service-discovery', 'network', 'dns'],
    preset: 'empty',
    setup: [
      { action: 'run_container', image: 'redis:7', name: 'cache', detach: true },
      { action: 'run_container', image: 'alpine:3.20', name: 'client', cmd: ['sleep', '3600'], detach: true },
    ],
    steps: [
      { action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379, by: 'name' },
      { action: 'send_request', from: 'container:client', to: 'container:cache', port: 6379, by: 'ip' },
    ],
    ask: {
      question: 'Both containers are on the DEFAULT bridge. client calls cache by name, then by IP. Which works?',
      options: opt('Both', 'Only by IP: the default bridge has no embedded DNS', 'Only by name', 'Neither'),
      answer: 'b',
      explanation: 'Name resolution is a feature of user-defined networks. That is why Compose creates its own network.',
    },
    verify: (w) => w.requests.length >= 2 && !w.requests[w.requests.length - 2]!.ok && w.requests[w.requests.length - 1]!.ok,
  },
  {
    id: 'signal-handling',
    title: 'Stop an app that ignores SIGTERM',
    whatIf: 'What if the app does not handle SIGTERM?',
    concepts: ['signals', 'pid1', 'exit-codes'],
    preset: 'empty',
    setup: [{ action: 'build_image' }, { action: 'run_container', image: 'my-api:latest', name: 'api', detach: true }],
    steps: [{ action: 'stop_container', target: 'container:api' }],
    ask: {
      question: 'api is a Node app running as PID 1 with no SIGTERM handler. We `docker stop api`. How does it end?',
      options: opt('Exit 0: gracefully on SIGTERM', 'Exit 137: SIGTERM was ignored, Docker waited 10 s then sent SIGKILL', 'Exit 143: killed by SIGTERM', 'It keeps running'),
      answer: 'b',
      explanation: 'The kernel ignores signals sent to PID 1 that have no handler. docker stop falls back to SIGKILL after the grace period. Use --init or handle SIGTERM.',
    },
    verify: (w, ev) => w.containers.api?.exitCode === 137 && has(ev, 'engine.timeout'),
  },
  {
    id: 'crash-loop',
    title: 'Crash loop',
    whatIf: 'What if a container keeps dying and restarts forever?',
    concepts: ['restart-policy', 'oom-killer', 'memory-limit'],
    preset: 'empty',
    setup: [],
    steps: [{ action: 'run_container', image: 'postgres:16', name: 'db', memory: '16MB', restart: 'always', detach: true }],
    ask: {
      question: 'postgres needs ~58 MB to boot but we cap it at 16 MB with --restart always. What do we observe?',
      options: opt('It runs fine at 16 MB', 'OOM kill → restart → OOM kill → … until Docker backs off', 'It starts and exits 0', 'Docker refuses the limit'),
      answer: 'b',
      explanation: 'Each start immediately exceeds memory.max and is killed; the policy keeps restarting it with growing back-off. A restart policy cannot fix a bad limit.',
    },
    verify: (w, ev) => has(ev, 'container.restarting') && has(ev, 'container.restart.backoff'),
  },
];

export const SCENARIO_MAP: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
