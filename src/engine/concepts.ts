import type { Level } from './types';

/**
 * The Docker knowledge graph. Machine-readable, queried by the inspector, the
 * "reveal relationships" interactions and the MCP concept tools.
 *
 * Edges (all point from the concept to what it needs/uses):
 *   dependsOn     can't exist or work without
 *   parts         is made of
 *   createdBy     what brings it into being
 *   managedBy     what controls its lifecycle
 *   implementedBy what actually does the work underneath (lower level)
 *   relatesTo     meaningful association (not a dependency)
 *   outward       where it connects to the wider ecosystem
 */

export type Domain = 'docker' | 'engine' | 'linux' | 'oci' | 'ecosystem';
/** colour roles: one colour per system, used everywhere */
export type Role = 'runtime' | 'network' | 'storage' | 'kernel' | 'resource' | 'failure' | 'registry' | 'build' | 'standard';

export type LevelKey = 's' | 'o' | 'e' | 'p' | 'k' | 'i' | 'w';
export const LEVEL_KEYS: LevelKey[] = ['s', 'o', 'e', 'p', 'k', 'i', 'w'];

export interface Concept {
  id: string;
  name: string;
  domain: Domain;
  role: Role;
  /** the one accurate sentence */
  summary: string;
  /** why does this exist at all */
  why: string;
  /** text per abstraction level: s=story o=objects e=engine p=linux process k=kernel i=oci w=wider world */
  lv: Partial<Record<LevelKey, string>>;
  metaphor?: string;
  dependsOn: string[];
  parts: string[];
  createdBy: string[];
  managedBy: string[];
  implementedBy: string[];
  relatesTo: string[];
  outward: string[];
  misconceptions: string[];
  experiments: string[];
  commands: string[];
  kernel: string[];
}

type Input = Partial<Pick<Concept, 'dependsOn' | 'parts' | 'createdBy' | 'managedBy' | 'implementedBy' | 'relatesTo' | 'outward' | 'misconceptions' | 'experiments' | 'commands' | 'kernel' | 'metaphor' | 'lv'>>;

function C(id: string, name: string, domain: Domain, role: Role, summary: string, why: string, x: Input = {}): Concept {
  return {
    id,
    name,
    domain,
    role,
    summary,
    why,
    lv: x.lv ?? {},
    metaphor: x.metaphor,
    dependsOn: x.dependsOn ?? [],
    parts: x.parts ?? [],
    createdBy: x.createdBy ?? [],
    managedBy: x.managedBy ?? [],
    implementedBy: x.implementedBy ?? [],
    relatesTo: x.relatesTo ?? [],
    outward: x.outward ?? [],
    misconceptions: x.misconceptions ?? [],
    experiments: x.experiments ?? [],
    commands: x.commands ?? [],
    kernel: x.kernel ?? [],
  };
}

const list: Concept[] = [
  /* ================================ DOCKER OBJECTS ================================ */
  C('host', 'Host machine', 'docker', 'runtime', 'The computer (physical, VM or cloud instance) whose single Linux kernel runs every container on it.', 'Containers are not machines. Something has to provide the CPU, RAM, disk, network card and the kernel they all share.', {
    metaphor: 'The giant flying whale. Everything rides on it.',
    lv: {
      s: 'The whale: big, alive, and carrying everything. Its brain is the CPU, its body holds RAM and storage, its nervous system is the kernel.',
      o: 'A machine with CPU cores, RAM, a disk and a network card, running Docker Engine.',
      e: 'dockerd and containerd run on the host as ordinary system services (managed by systemd).',
      p: 'Just a Linux machine: PID 1 is systemd, with dockerd and containerd as children and one shim per container.',
      k: 'One kernel for everyone. All containers make syscalls into the SAME kernel; namespaces and cgroups only change what each process can see and use.',
      i: 'The runtime spec is written for "a Linux host": it defines what a runtime must do on one.',
      w: 'In Kubernetes a host is a Node; in the cloud it is usually a VM (or a microVM) you never see.',
    },
    parts: ['kernel', 'disk', 'dockerd', 'containerd'],
    relatesTo: ['container', 'network'],
    outward: ['kubernetes', 'cloud-runtimes'],
    misconceptions: ['"Docker runs in its own virtual machine" — on Linux there is no VM: containers are processes on the host kernel. (Docker Desktop on Mac/Windows does hide a Linux VM, which is why this misconception persists.)'],
    experiments: ['restart-host', 'fill-disk'],
    commands: ['docker info', 'docker system df'],
    kernel: ['/proc', 'systemd'],
  }),
  C('container', 'Container', 'docker', 'runtime', 'A normal Linux process (or process tree) started from an image, wrapped in namespaces for isolation and cgroups for resource limits.', 'To run software with its dependencies packaged in, reproducibly, with isolation from its neighbours, without paying for a whole virtual machine.', {
    metaphor: 'A shipping container bolted to the whale: same box shape, any cargo.',
    lv: {
      s: 'A shipping container on the deck. You can lift it off, stack another one, or lose one overboard without the whale noticing.',
      o: 'An object with an image, a state (created/running/exited), ports, mounts, networks and resource limits.',
      e: 'dockerd created it through containerd; a shim keeps it alive; runc set up the isolation and exec\'d your program.',
      p: 'The shipping box dissolves: what is left is a process tree. PID 1 inside is some PID like 4117 on the host.',
      k: 'The process lives in its own namespaces (pid, net, mnt, uts, ipc), inside a cgroup that caps its resources, with a restricted syscall and capability set.',
      i: 'Defined by an OCI runtime bundle: a root filesystem plus config.json describing process, mounts, namespaces and cgroups.',
      w: 'The unit that Kubernetes schedules (inside Pods), CI pipelines build and clouds run.',
    },
    dependsOn: ['image', 'process', 'namespaces', 'cgroups', 'dockerd', 'containerd', 'runc', 'kernel'],
    parts: ['process', 'writable-layer', 'namespaces', 'cgroups'],
    createdBy: ['dockerd'],
    managedBy: ['dockerd', 'containerd'],
    implementedBy: ['runc', 'namespaces', 'cgroups', 'overlayfs'],
    relatesTo: ['network', 'volume', 'port-publish', 'restart-policy', 'healthcheck', 'logs', 'lifecycle'],
    outward: ['pod', 'orchestration'],
    misconceptions: ['"A container is a lightweight VM." No guest kernel, no virtual hardware: it is a process using the host kernel with restricted visibility.', '"Containers are secure sandboxes by default." Shared kernel means a kernel bug can cross the boundary; defence is namespaces + capabilities + seccomp, not a hypervisor.'],
    experiments: ['kill-pid1', 'delete-container', 'volume-survives'],
    commands: ['docker run', 'docker ps', 'docker inspect', 'docker top'],
    kernel: ['clone(CLONE_NEW*)', 'unshare', 'cgroup.procs'],
  }),
  C('image', 'Image', 'docker', 'build', 'A read-only, content-addressed package: an ordered stack of filesystem layers plus a config (default command, env, ports) described by a manifest.', 'So the exact same filesystem and startup recipe can be built once, shipped anywhere, and instantiated many times identically.', {
    metaphor: 'A blueprint: not a building, a precise plan for making identical ones.',
    lv: {
      s: 'A blueprint stored in the harbor: you can stamp out as many containers from it as you like, and it never changes.',
      o: 'A named object (repo:tag) with a size, an architecture, a list of layers and a default command.',
      e: 'The blueprint separates into the Dockerfile that built it and the layers each instruction produced.',
      p: 'Not running anything: it is data on disk, unpacked into /var/lib/docker/overlay2 so containers can mount it.',
      k: 'Layers are filesystem changesets; overlayfs stacks them as read-only lowerdirs under every container.',
      i: 'OCI image: manifest (points to config blob + layer blobs by sha256 digest) + config JSON + layer tarballs.',
      w: 'Pushed to registries, signed, scanned, referenced by digest in deployments: the unit of software delivery.',
    },
    parts: ['layer', 'manifest', 'digest'],
    dependsOn: ['layer', 'manifest'],
    createdBy: ['build', 'registry'],
    managedBy: ['dockerd', 'containerd'],
    implementedBy: ['oci-image', 'overlayfs'],
    relatesTo: ['tag', 'registry', 'dockerfile', 'platform'],
    outward: ['supply-chain', 'ci-cd'],
    misconceptions: ['"An image is a running thing." It is inert data; running it creates a container.', '"Tags are the image." A tag is a movable label; the digest is the image\'s true identity.'],
    experiments: ['delete-local-image', 'rebuild-one-layer', 'wrong-arch'],
    commands: ['docker pull', 'docker images', 'docker history', 'docker rmi'],
    kernel: ['overlayfs lowerdir'],
  }),
  C('layer', 'Layer', 'docker', 'storage', 'One filesystem changeset (files added, modified or deleted) packed as a tar archive and identified by a sha256 digest. Images are stacks of layers.', 'So shared work is stored and transferred once: ten images with the same base share the same base layer on disk and over the wire.', {
    metaphor: 'One plate in the blueprint stack. Identical plates are shared between blueprints.',
    lv: {
      s: 'A transparent sheet in the blueprint stack, stacked on others to give the whole picture.',
      o: 'Each Dockerfile instruction that changes files produces a layer; layers are listed in `docker history`.',
      e: 'containerd stores each layer as a blob and its snapshotter unpacks it into a directory.',
      p: 'A directory under /var/lib/docker/overlay2/<id>/diff on the host.',
      k: 'The filesystem change set: added files, changed files and whiteout markers for deleted files. Stacked by overlayfs.',
      i: 'A blob: a (compressed) tar archive with a media type, a digest and a size. Its uncompressed digest is the diffID.',
      w: 'Layer deduplication is why registries and CI caches are fast.',
    },
    parts: ['digest'],
    createdBy: ['build'],
    relatesTo: ['image', 'build-cache', 'overlayfs'],
    implementedBy: ['overlayfs', 'oci-image'],
    misconceptions: ['"Deleting a file in a later layer shrinks the image." The earlier layer still holds the bytes; a whiteout only hides them.'],
    experiments: ['rebuild-one-layer', 'cache-bust-order'],
    commands: ['docker history'],
  }),
  C('tag', 'Tag', 'docker', 'registry', 'A human-friendly, movable name (like latest or 16) pointing at one image manifest digest.', 'Digests are precise but unreadable; tags give humans stable-enough names and let publishers roll forward.', {
    metaphor: 'A paper label on a blueprint tube. Labels get moved; contents do not.',
    lv: { o: 'repo:tag, e.g. nginx:latest. No tag means :latest.', i: 'In OCI distribution a tag is just a mutable reference in the registry to a manifest digest.', w: 'Production deployments pin to digests (nginx@sha256:…) so tags moving cannot change what runs.' },
    dependsOn: ['digest', 'registry'],
    relatesTo: ['image', 'manifest'],
    misconceptions: ['":latest means the newest version." It is only a default tag name; nothing enforces what it points to.'],
  }),
  C('registry', 'Registry', 'docker', 'registry', 'A server that stores and serves images over HTTP so any machine can pull what another pushed.', 'To distribute images: build once, pull anywhere.', {
    metaphor: 'The harbor: warehouses of blueprints that ships dock at to collect copies.',
    lv: {
      s: 'The harbor on the left. A pull is a crane lowering copies of blueprint plates onto the deck.',
      o: 'Docker Hub, GHCR, ECR… you pull from and push to them by name.',
      e: 'dockerd (via containerd) authenticates, then negotiates manifests and blobs with the registry.',
      p: 'An ordinary HTTPS server; pulls are HTTP GETs of blobs, resumable and parallel.',
      k: 'Needs the host network: DNS resolution, TCP, TLS. If the host cannot reach it, pulls fail even though local images keep working.',
      i: 'Implements the OCI Distribution Spec: /v2/<name>/manifests/<ref> and /v2/<name>/blobs/<digest>.',
      w: 'Docker Hub, GitHub Container Registry, AWS ECR, Google Artifact Registry, Harbor: all speak the same API.',
    },
    dependsOn: ['oci-distribution', 'dns', 'network'],
    relatesTo: ['image', 'tag', 'digest', 'manifest'],
    implementedBy: ['oci-distribution'],
    outward: ['registry-products', 'supply-chain', 'ci-cd'],
    misconceptions: ['"Docker Hub IS the registry." It is the default one; the protocol is open and anyone can host one.'],
    experiments: ['registry-down'],
    commands: ['docker pull', 'docker push', 'docker login'],
  }),
  C('dockerfile', 'Dockerfile', 'docker', 'build', 'A text recipe: a base image (FROM) plus ordered instructions (COPY, RUN, ENV, CMD…) that BuildKit turns into layers and image config.', 'To make image creation repeatable, reviewable and versionable instead of a manual snapshot.', {
    metaphor: 'The shipyard\'s construction notes: do step 1, then 2, then 3, and record each result.',
    lv: {
      s: 'The blueprint separates into the construction notes that made it, one plate per step.',
      o: 'FROM picks a base; RUN/COPY/ADD make layers; ENV/EXPOSE/CMD/USER only add metadata.',
      e: 'The CLI sends the context to BuildKit which executes the steps, using the cache when inputs are unchanged.',
      p: 'Each RUN executes a real process in a throwaway container whose filesystem diff becomes the next layer.',
      k: 'RUN steps run in namespaces over an overlayfs; the diff of the upper layer is captured as the layer tar.',
      i: 'The Dockerfile itself is not part of the OCI image: only its results (layers + history + config) are.',
      w: 'Alternatives produce the same OCI output: Buildah, Kaniko, Bazel rules_oci, Cloud Native Buildpacks.',
    },
    dependsOn: ['buildkit', 'image'],
    createdBy: [],
    managedBy: ['buildkit'],
    relatesTo: ['build', 'layer', 'build-cache'],
    outward: ['ci-cd', 'supply-chain'],
    experiments: ['rebuild-one-layer', 'cache-bust-order'],
    commands: ['docker build', 'docker history'],
  }),
  C('build', 'Image build', 'docker', 'build', 'Executing a Dockerfile step by step, creating a layer for each filesystem-changing step, and tagging the result as an image.', 'To turn source code plus a recipe into a runnable, shareable artifact.', {
    metaphor: 'The shipyard dock: parts go in, a finished blueprint-backed container comes out.',
    lv: { s: 'The shipyard at the right: sparks fly where a new plate is made; reused plates slide in untouched.', o: 'docker build -t name:tag . Output: a new image.', e: 'dockerd delegates to BuildKit, which solves a dependency graph of build steps in parallel where it can.', p: 'Each RUN is a process in a temporary container.', i: 'Output is an OCI image (or an OCI archive/index) that any OCI tool can read.', w: 'Usually done in CI so that the image that was tested is the image that ships.' },
    dependsOn: ['dockerfile', 'buildkit', 'build-cache', 'registry'],
    managedBy: ['buildkit'],
    createdBy: [],
    relatesTo: ['image', 'layer'],
    experiments: ['rebuild-one-layer', 'cache-bust-order'],
    commands: ['docker build'],
  }),
  C('build-cache', 'Build cache', 'docker', 'build', 'Reuse of earlier layers when a step and everything it depends on is unchanged. A changed step invalidates every step after it.', 'Rebuilding unchanged work wastes minutes; caching makes iteration fast.', {
    metaphor: 'Plates already made are slid back in. Change one plate and every plate stacked on it must be re-made.',
    lv: { o: 'Lines say CACHED in build output.', e: 'BuildKit hashes (parent layer, instruction, and for COPY the file contents) to find a reusable result.', p: 'Cache hits skip running the process entirely.', k: 'Layers are immutable, so a stacked layer cannot survive a change underneath it.', w: 'CI systems export/import this cache (registry cache, GitHub Actions cache) to speed up builds.' },
    dependsOn: ['layer', 'digest'],
    relatesTo: ['dockerfile', 'build'],
    misconceptions: ['"Docker caches by instruction text only." For COPY/ADD the file contents are hashed too; changing a file busts the cache.'],
    experiments: ['cache-bust-order', 'rebuild-one-layer'],
  }),
  C('volume', 'Volume', 'docker', 'storage', 'Docker-managed storage that lives outside any container: it is mounted into containers at a path and survives their removal.', 'A container\'s own filesystem dies with it. Anything worth keeping (a database) must live somewhere else.', {
    metaphor: 'Strapped cargo: lashed onto the whale, not inside any one container. Remove the container and the cargo stays aboard.',
    lv: {
      s: 'A strapped barrel on the whale\'s hold. Straps connect it to a container; cutting the container loose leaves the barrel.',
      o: 'A named object you create or Docker creates for you; mounted with -v name:/path.',
      e: 'dockerd manages volumes via a volume driver (local by default) and records which containers reference them.',
      p: 'A plain directory on the host: /var/lib/docker/volumes/<name>/_data.',
      k: 'Attached to the container with a bind mount in its mount namespace, so the process sees it at the target path.',
      i: 'In the runtime spec this is one entry in config.json mounts[] with type=bind.',
      w: 'In Kubernetes: PersistentVolumes; in the cloud: network-attached disks (EBS, Persistent Disk).',
    },
    dependsOn: ['mnt-ns', 'disk'],
    createdBy: ['dockerd'],
    managedBy: ['dockerd'],
    implementedBy: ['bind-mount', 'mnt-ns'],
    relatesTo: ['container', 'writable-layer', 'bind-mount'],
    outward: ['orchestration'],
    misconceptions: ['"Stopping a container saves its data." Stopping keeps the writable layer, but REMOVING the container deletes it; only volumes/bind mounts are independent.'],
    experiments: ['volume-survives', 'delete-container', 'delete-volume'],
    commands: ['docker volume create', 'docker run -v', 'docker volume ls'],
    kernel: ['mount --bind'],
  }),
  C('bind-mount', 'Bind mount', 'docker', 'storage', 'Mapping an existing host directory into a container path. The container and the host see the same files.', 'To share source code, config or data with a container directly from the host filesystem.', {
    metaphor: 'A gangway straight to the dock: the container reaches onto the pier itself.',
    lv: { o: '-v /host/path:/container/path; the host path must be right or you mount an empty directory.', p: 'No copying: the same inodes are visible on both sides.', k: 'A bind mount in the container\'s mount namespace. It HIDES whatever the image had at that path.', i: 'mounts[] entry with type bind and options rbind.', w: 'Kubernetes hostPath is the equivalent (and similarly discouraged for production).' },
    dependsOn: ['mnt-ns'],
    relatesTo: ['volume', 'tmpfs', 'container'],
    misconceptions: ['"A wrong host path errors." With -v Docker silently creates an empty directory there and mounts it, hiding the image\'s own files.'],
    experiments: ['wrong-mount'],
    kernel: ['mount --bind', 'MS_BIND'],
  }),
  C('tmpfs', 'tmpfs mount', 'docker', 'storage', 'A memory-backed filesystem mounted into a container. Fast, never touches disk, gone when the container stops.', 'For scratch data and secrets that must not persist.', {
    lv: { o: '--tmpfs /tmp', k: 'A tmpfs filesystem mounted in the container\'s mount namespace; its pages count toward the container\'s memory cgroup.' },
    dependsOn: ['mnt-ns'],
    relatesTo: ['volume', 'memory-limit'],
    kernel: ['tmpfs'],
  }),
  C('writable-layer', 'Writable layer', 'docker', 'storage', 'The thin read-write layer every container gets on top of its image. It is deleted with the container.', 'So a container can change files without ever modifying the shared, immutable image.', {
    metaphor: 'A whiteboard laid over the blueprint: scribble freely; wipe it and the blueprint is untouched.',
    lv: { o: 'Anything the app writes outside a volume lands here.', p: 'A directory (…/overlay2/<id>/diff) owned by this one container.', k: 'overlayfs upperdir. Writes use copy-on-write: a file from a lower layer is copied up before it is changed.', w: 'Why stateless containers are easy to replace — and why databases need volumes.' },
    dependsOn: ['overlayfs', 'layer'],
    relatesTo: ['container', 'volume'],
    implementedBy: ['overlayfs'],
    misconceptions: ['"My data is safe, the container is just stopped." Safe until the container is removed.'],
    experiments: ['volume-survives', 'delete-container'],
    kernel: ['overlayfs upperdir', 'copy-up'],
  }),
  C('network', 'Network', 'docker', 'network', 'A virtual network that connects containers: by default a Linux bridge with its own subnet, plus NAT to the outside world and embedded DNS on user-defined networks.', 'So containers can talk to each other and to the world without each needing a real network card, and without being reachable by everyone by default.', {
    metaphor: 'Signal lines strung between cargo containers. Containers on different lines cannot hear each other.',
    lv: {
      s: 'Coloured communication lines between containers on the deck. Only containers on the same line can talk.',
      o: 'A named object with a subnet; containers attach with an IP address.',
      e: 'dockerd\'s networking library (libnetwork) creates and wires the bridge, veths, NAT rules and DNS.',
      p: 'On the host: a bridge interface (docker0 or br-xxxx) with one veth per container.',
      k: 'Network namespaces + veth pairs + a Linux bridge + iptables NAT; routing sends container traffic through the host.',
      i: 'The runtime spec only says "give this container a network namespace"; wiring it up is the engine\'s (or a CNI plugin\'s) job.',
      w: 'Kubernetes replaces this with CNI plugins (Calico, Cilium, Flannel) giving every Pod a routable IP.',
    },
    dependsOn: ['net-ns', 'bridge', 'veth', 'iptables'],
    parts: ['bridge', 'veth', 'dns'],
    createdBy: ['dockerd'],
    managedBy: ['dockerd'],
    implementedBy: ['bridge', 'veth', 'iptables', 'net-ns'],
    relatesTo: ['container', 'port-publish', 'service-discovery'],
    outward: ['kubernetes'],
    misconceptions: ['"Containers on the default bridge can use each other\'s names." Name resolution only exists on user-defined networks.', '"Every container can reach every other." Different networks are isolated from each other.'],
    experiments: ['no-network', 'isolated-networks', 'name-resolution'],
    commands: ['docker network create', 'docker network connect', 'docker network ls'],
    kernel: ['bridge', 'veth', 'netfilter'],
  }),
  C('port-publish', 'Port publishing', 'docker', 'network', 'Making a container port reachable from outside the host by forwarding a host port to it (-p host:container).', 'Containers live on private networks; publishing is the deliberate door from the outside world in.', {
    metaphor: 'A gangplank from the container to the pier, with a numbered gate.',
    lv: {
      s: 'A gangplank lowering from a container to a numbered gate on the whale\'s flank.',
      o: '-p 8080:80 maps host port 8080 to container port 80.',
      e: 'dockerd programs the forwarding rule and starts docker-proxy for hairpin traffic.',
      p: 'docker-proxy listens on the host port; the real forwarding is done in the kernel.',
      k: 'An iptables DNAT rule in the nat table (DOCKER chain): host:8080 → container-ip:80.',
      w: 'In Kubernetes: Services / Ingress / LoadBalancers play this role.',
    },
    dependsOn: ['iptables', 'network'],
    implementedBy: ['iptables'],
    relatesTo: ['container', 'network'],
    outward: ['kubernetes'],
    misconceptions: ['"EXPOSE publishes the port." EXPOSE is documentation only; -p does the work.', '"-p 8080:8080 always works." The second number must be the port the app really listens on.'],
    experiments: ['port-conflict', 'wrong-port'],
    commands: ['docker run -p', 'docker port'],
    kernel: ['iptables -t nat DOCKER', 'DNAT'],
  }),
  C('service-discovery', 'Service discovery (DNS)', 'docker', 'network', 'Containers find each other by name: Docker\'s embedded DNS server (127.0.0.11) answers for containers on the same user-defined network.', 'IP addresses change every restart. Names do not.', {
    lv: { o: 'Use the container or service name as the hostname (db, api).', e: 'dockerd runs an in-process DNS server per network and answers container names; everything else is forwarded to the host\'s resolvers.', p: 'Each container\'s /etc/resolv.conf points at 127.0.0.11.', k: 'Traffic to 127.0.0.11 is redirected by iptables to dockerd inside the container\'s network namespace.', w: 'Kubernetes does the same with CoreDNS and Service names.' },
    dependsOn: ['dns', 'network', 'dockerd'],
    relatesTo: ['compose', 'container'],
    outward: ['kubernetes'],
    experiments: ['name-resolution', 'break-dns'],
  }),
  C('dns', 'DNS', 'docker', 'network', 'The system that turns names into IP addresses. Containers use Docker\'s embedded resolver for container names and the host\'s upstream DNS for everything else.', 'Humans and configs use names; packets need addresses.', {
    lv: { o: 'If upstream DNS is down, pulls and external lookups fail; container-to-container names keep working.', e: 'Docker forwards unknown names to the host\'s configured resolvers.', k: 'UDP/TCP port 53; /etc/resolv.conf inside the container\'s mount namespace.' },
    relatesTo: ['service-discovery', 'registry', 'network'],
    experiments: ['break-dns'],
  }),
  C('compose', 'Docker Compose', 'docker', 'runtime', 'A declarative file describing a multi-container application (services, networks, volumes) that Docker creates and tears down together.', 'Real apps are several containers wired together. Typing ten docker run commands is error-prone and unreproducible.', {
    metaphor: 'A convoy manifest: which cargo, in which order, on which signal lines.',
    lv: { o: 'compose.yaml → services, a shared network, named volumes, depends_on ordering.', e: 'Compose (a CLI plugin) translates the file into the same API calls you would make by hand.', p: 'Each service becomes ordinary containers with predictable names (project-service-1).', w: 'Compose is single-host. Kubernetes manifests (Deployments, Services) are the multi-host cousin; `kompose` can convert.' },
    dependsOn: ['docker-api', 'network', 'volume', 'container'],
    createdBy: ['docker-cli'],
    managedBy: ['docker-cli'],
    relatesTo: ['service-discovery', 'healthcheck', 'restart-policy'],
    outward: ['orchestration', 'kubernetes'],
    misconceptions: ['"depends_on guarantees the dependency is ready." It orders startup; readiness needs a healthcheck and a condition.'],
    experiments: ['break-compose-dependency'],
    commands: ['docker compose up', 'docker compose down', 'docker compose ps'],
  }),
  C('healthcheck', 'Healthcheck', 'docker', 'runtime', 'A command Docker runs periodically inside the container to judge whether the app is actually working (starting / healthy / unhealthy).', '"Running" only means the process exists. Healthy means it can do its job.', {
    lv: { o: 'Shows in docker ps as (healthy) or (unhealthy).', e: 'dockerd runs the probe via exec on a timer. It marks status; it does not restart the container by itself.', w: 'Kubernetes probes (liveness/readiness) are the orchestrated version: they DO trigger restarts and routing changes.' },
    relatesTo: ['container', 'restart-policy', 'compose'],
    outward: ['orchestration', 'observability'],
    misconceptions: ['"unhealthy containers get restarted." Plain Docker only labels them; an orchestrator or autoheal tool acts on it.'],
  }),
  C('restart-policy', 'Restart policy', 'docker', 'runtime', 'Rules (no, on-failure, always, unless-stopped) telling dockerd whether to start a container again after it exits or the daemon/host restarts.', 'So a crashed or rebooted service comes back without a human.', {
    lv: { o: '--restart unless-stopped', e: 'dockerd watches exits and restarts with exponential backoff; policies are re-applied when dockerd starts.', p: 'A restart is a brand-new process (new PID, memory cleared).', w: 'Kubernetes controllers (Deployments) do this cluster-wide.' },
    dependsOn: ['dockerd'],
    managedBy: ['dockerd'],
    relatesTo: ['container', 'exit-codes', 'daemon-restart'],
    outward: ['orchestration'],
    misconceptions: ['"always restarts it even if I stopped it." A manual stop wins until the daemon restarts (always) or permanently (unless-stopped).'],
    experiments: ['restart-service', 'restart-host', 'crash-loop'],
    commands: ['docker run --restart'],
  }),
  C('logs', 'Logs', 'docker', 'runtime', 'The stdout/stderr of the container\'s main process, captured by dockerd\'s logging driver (json-file by default).', 'Containers have no console; logs are how you see what the app says.', {
    lv: { o: 'docker logs <container>', e: 'The shim streams the process output to dockerd, which writes it via the logging driver.', p: 'Only what PID 1 writes to stdout/stderr is captured, not files inside the container.', w: 'Production ships these to Loki, ELK, CloudWatch, Datadog.' },
    relatesTo: ['container', 'shim', 'observability'],
    outward: ['observability'],
    commands: ['docker logs -f'],
  }),
  C('lifecycle', 'Container lifecycle', 'docker', 'runtime', 'created → running → (paused) → exited → removed. Each transition is an explicit command or an event like the process exiting.', 'Understanding which state something is in explains almost every "why is it not working".', {
    lv: { o: 'create, start, stop, restart, pause, kill, rm.', e: 'dockerd records state; containerd/runc do the real start/stop work.', p: 'running = the process exists; exited = it ended with an exit code; removed = all its leftovers are deleted.' },
    relatesTo: ['container', 'exit-codes', 'signals'],
    experiments: ['delete-container', 'restart-service'],
    commands: ['docker run', 'docker stop', 'docker start', 'docker rm'],
  }),
  C('exit-codes', 'Exit codes', 'docker', 'failure', 'The number a process returns when it ends. 0 is success; 128+N means "killed by signal N" (137 = SIGKILL, 143 = SIGTERM).', 'The cheapest way to tell what killed a container.', {
    lv: { o: 'Shown in docker ps -a as Exited (137).', p: 'The kernel reports how the process ended; dockerd stores it.', k: '137 = 128+9 (SIGKILL), commonly delivered by the OOM killer or docker kill; 143 = SIGTERM; 139 = SIGSEGV.' },
    relatesTo: ['signals', 'oom-killer', 'container'],
    misconceptions: ['"137 means out of memory." It means SIGKILL; check State.OOMKilled to know if memory was the cause.'],
    experiments: ['reduce-memory', 'kill-pid1', 'signal-handling'],
  }),
  C('docker-cli', 'docker CLI', 'docker', 'runtime', 'The command-line client. It does no container work itself: it sends REST calls to the Docker daemon.', 'A thin, scriptable front end, so the same engine can be driven by CLIs, GUIs and CI.', {
    metaphor: 'Santa\'s radio: you shout orders, the whale\'s pilot does the flying.',
    lv: { s: 'Your voice over the radio to Santa.', o: 'docker run, docker ps, docker build…', e: 'Each command becomes an HTTP request to dockerd over a unix socket.', p: 'A short-lived process on your machine (or inside CI).', w: 'podman and nerdctl offer Docker-compatible CLIs over other engines.' },
    dependsOn: ['docker-api'],
    relatesTo: ['dockerd'],
    outward: ['podman'],
    misconceptions: ['"Docker is the CLI." The CLI is a client; the daemon is the engine.'],
  }),
  C('docker-api', 'Docker Engine API', 'docker', 'runtime', 'The REST API (HTTP over /var/run/docker.sock) that dockerd exposes. Everything the CLI does goes through it.', 'A stable contract between clients and the engine.', {
    lv: { e: 'GET /containers/json, POST /containers/create, POST /build…', p: 'Access to the socket is effectively root on the host: it can start privileged containers.', w: 'Tools like Portainer, Testcontainers and CI runners drive Docker through this API.' },
    dependsOn: ['dockerd'],
    relatesTo: ['docker-cli'],
    misconceptions: ['"Mounting docker.sock into a container is harmless." It hands that container control of the host.'],
  }),
  C('platform', 'Platform (architecture)', 'docker', 'build', 'The OS/CPU-architecture an image\'s binaries were built for (linux/amd64, linux/arm64…). It must match the host CPU (or be emulated).', 'Binaries are compiled for one instruction set; the kernel cannot run a foreign one natively.', {
    lv: { o: 'Images show their architecture; multi-arch tags hide several images behind one name.', k: 'exec of a foreign-architecture ELF fails with "exec format error" (ENOEXEC) before the program starts.', i: 'An image index lists one manifest per platform; the client picks the matching one.', w: 'Apple-silicon laptops (arm64) vs cloud (amd64) make this the daily gotcha; buildx builds multi-platform images.' },
    relatesTo: ['image', 'manifest', 'kernel'],
    experiments: ['wrong-arch'],
  }),
  C('disk', 'Disk space', 'docker', 'resource', 'The host filesystem capacity that holds images, container layers, volumes and logs (under /var/lib/docker).', 'Everything Docker stores lives on one finite disk. When it is full, writes fail.', {
    metaphor: 'The whale\'s storage hold. When it is full nothing more fits aboard.',
    lv: { s: 'The hold below deck, filling with plates, barrels and logs.', o: 'docker system df shows what uses space; docker system prune reclaims it.', k: 'A full filesystem returns ENOSPC to every write(); applications fail in application-specific ways.', w: 'Disk pressure is a classic cause of node problems in Kubernetes (evictions).' },
    relatesTo: ['volume', 'layer', 'writable-layer', 'host'],
    experiments: ['fill-disk'],
    commands: ['docker system df', 'docker system prune'],
  }),

  /* ============================== ENGINE INTERNALS ============================== */
  C('dockerd', 'dockerd (Docker daemon)', 'engine', 'runtime', 'The long-running daemon behind the docker CLI: API server, image/volume/network manager and build coordinator. It delegates actually running containers to containerd.', 'Someone has to own state (which containers, networks, volumes exist) and translate friendly commands into low-level work.', {
    metaphor: 'Santa at the controls: takes orders, plans, delegates, and keeps the books.',
    lv: {
      s: 'Santa in the cockpit, steering the whale and shouting orders to the reindeer crew.',
      o: 'The Docker Engine. `docker version` shows Client and Server (this).',
      e: 'Receives API calls, manages images/volumes/networks (libnetwork), calls BuildKit for builds and containerd for containers.',
      p: 'A single Go process (e.g. PID 812) with a unix socket.',
      k: 'Programs iptables/bridges, mounts and cgroup-aware paths on behalf of containers.',
      w: 'Kubernetes removed its built-in Docker support (dockershim) and talks to containerd or CRI-O directly.',
    },
    dependsOn: ['containerd', 'buildkit', 'kernel'],
    parts: ['docker-api'],
    managedBy: ['host'],
    createdBy: [],
    relatesTo: ['docker-cli', 'containerd', 'network', 'volume'],
    outward: ['kubernetes'],
    misconceptions: ['"dockerd runs the containers." It orders them; containerd, a shim and runc do.'],
    experiments: ['containerd-down', 'restart-host'],
    commands: ['systemctl status docker', 'docker info'],
  }),
  C('containerd', 'containerd', 'engine', 'runtime', 'An industry-standard container runtime daemon (CNCF) that manages images, snapshots and container lifecycles. Docker, Kubernetes and others build on it.', 'A small, stable core separate from Docker\'s UX so everyone could share one runtime.', {
    metaphor: 'The foreman reindeer: takes Santa\'s orders and organises the crew.',
    lv: {
      s: 'The foreman reindeer: reads the plan and sends the runner to do the dangerous bit.',
      o: 'Not something you call directly with docker commands, but it holds your images and containers.',
      e: 'Pulls and unpacks images (snapshotters), then starts containers by launching a shim and asking runc to create the process.',
      p: 'A separate daemon process (e.g. PID 640) with child shim processes.',
      k: 'Prepares the overlay snapshot (rootfs) the container will see.',
      i: 'Generates the OCI runtime bundle (config.json) for runc.',
      w: 'Used directly by Kubernetes through the CRI plugin; also by nerdctl and many clouds.',
    },
    dependsOn: ['runc', 'shim', 'oci-image'],
    parts: ['shim'],
    managedBy: ['host'],
    relatesTo: ['dockerd', 'oci-runtime'],
    outward: ['cri', 'kubernetes'],
    misconceptions: ['"containerd is part of Docker only." It is a separate CNCF project Docker uses.'],
    experiments: ['containerd-down'],
  }),
  C('shim', 'containerd-shim', 'engine', 'runtime', 'A tiny per-container helper process that stays as the container\'s parent after runc exits, holds its stdio and reports its exit code.', 'So containerd and dockerd can restart or upgrade without killing running containers.', {
    metaphor: 'The runner\'s handler, standing beside each container so the foreman can step away.',
    lv: { e: 'containerd-shim-runc-v2 is started by containerd; it talks to containerd over a ttrpc socket.', p: 'Visible in `ps`: one shim per container (or per pod).', k: 'The shim is the container process\'s parent; it reaps zombies and receives SIGCHLD.', i: 'Not in the OCI spec: it is a containerd design.', w: 'Alternative shims run other runtimes (gVisor, Kata) behind the same containerd.' },
    dependsOn: ['process'],
    managedBy: ['containerd'],
    relatesTo: ['runc', 'logs', 'daemon-restart'],
    outward: ['sandbox-runtimes'],
    experiments: ['containerd-down'],
    kernel: ['PR_SET_CHILD_SUBREAPER'],
  }),
  C('runc', 'runc', 'engine', 'runtime', 'The reference low-level OCI runtime: a CLI that reads a bundle (rootfs + config.json) and sets up namespaces, cgroups and mounts, then execs the container process and exits.', 'Creating a container is a delicate sequence of Linux system calls; runc is the standard, audited implementation.', {
    metaphor: 'The worker who actually bolts the container to the deck and pulls the lever, then walks away.',
    lv: {
      s: 'The runner reindeer: launches the container, then leaves.',
      p: 'Runs briefly, then exits: the container process is reparented to the shim.',
      k: 'clone() with namespace flags, write cgroup limits, pivot_root into the rootfs, drop capabilities, load the seccomp filter, execve the entrypoint.',
      i: 'Implements the OCI Runtime Spec: create, start, kill, delete, state.',
      w: 'Alternatives: crun (C, faster), youki (Rust), runsc (gVisor), kata-runtime (VMs): same interface.',
    },
    dependsOn: ['namespaces', 'cgroups', 'capabilities', 'seccomp', 'oci-runtime'],
    implementedBy: ['namespaces', 'cgroups'],
    managedBy: ['containerd', 'shim'],
    relatesTo: ['oci-runtime'],
    outward: ['sandbox-runtimes'],
    kernel: ['clone', 'pivot_root', 'execve', 'seccomp'],
  }),
  C('buildkit', 'BuildKit', 'engine', 'build', 'The modern build engine behind docker build: executes Dockerfile steps as a graph, in parallel where possible, with a content-addressed cache.', 'The original builder was sequential and cache-fragile; BuildKit is faster and more correct.', {
    lv: { e: 'dockerd (or docker buildx) hands the Dockerfile to BuildKit via a frontend; BuildKit solves a DAG of operations.', p: 'Runs as a daemon (embedded in dockerd, or a separate buildkitd).', i: 'Can export OCI images/archives and multi-platform indexes.', w: 'Also embedded in many CI tools; Buildah, Kaniko and Bazel are alternatives.' },
    dependsOn: ['containerd', 'layer'],
    managedBy: ['dockerd'],
    relatesTo: ['dockerfile', 'build', 'build-cache'],
    outward: ['ci-cd'],
  }),

  /* ================================= LINUX / KERNEL ================================= */
  C('kernel', 'Linux kernel', 'linux', 'kernel', 'The one operating-system core shared by the host and every container. It provides processes, memory, filesystems, networking, namespaces and cgroups.', 'Container isolation is not a Docker invention: it is Linux features that Docker wires together.', {
    metaphor: 'The whale\'s nervous system: every limb, every container, answers to it.',
    lv: { s: 'The nervous system running through the whale. Every container is wired into it.', k: 'Containers differ only in how the kernel presents resources to them (namespaces) and how much it lets them use (cgroups).', w: 'Stronger isolation (gVisor, Kata) interposes a second kernel layer or a VM.' },
    parts: ['namespaces', 'cgroups', 'overlayfs', 'iptables', 'bridge', 'veth', 'oom-killer', 'capabilities', 'seccomp'],
    relatesTo: ['host', 'process', 'container'],
    misconceptions: ['"Each container has its own kernel." They all share the host\'s; `uname -r` inside a container shows the host kernel version.'],
    kernel: ['syscalls'],
  }),
  C('process', 'Process', 'linux', 'runtime', 'A running program with its own PID, memory, open files and parent. A container is one process tree plus restrictions.', 'It is the actual thing that executes your code.', {
    metaphor: 'The glowing core inside the cargo box: the only thing actually running.',
    lv: { s: 'The glowing pip inside the shipping box.', p: 'ps on the host shows the container\'s processes with ordinary host PIDs.', k: 'task_struct in the kernel; its namespace membership decides what it can see.', w: 'Observability tools read /proc and cgroup files to measure it.' },
    relatesTo: ['container', 'pid1', 'signals', 'pid-ns'],
    commands: ['docker top', 'ps aux'],
    kernel: ['task_struct', '/proc/<pid>'],
  }),
  C('pid1', 'PID 1', 'linux', 'runtime', 'The first process in a container\'s PID namespace. When it exits the kernel kills everything else in that namespace. It also has special signal rules and must reap orphaned children.', 'It is the container\'s heartbeat: container life = PID 1 life.', {
    lv: { p: 'Inside the container it is PID 1; on the host it has a large PID (e.g. 4117).', k: 'Signals without a handler are ignored for PID 1: a program that never installed a SIGTERM handler will not die on docker stop (until the 10 s SIGKILL).', e: '`docker run --init` inserts a tiny init (tini) that forwards signals and reaps zombies.' },
    dependsOn: ['pid-ns', 'process'],
    relatesTo: ['signals', 'container', 'exit-codes'],
    misconceptions: ['"docker stop kills the container immediately." It sends SIGTERM, waits 10 s, then SIGKILL.'],
    experiments: ['kill-pid1', 'signal-handling'],
  }),
  C('signals', 'Signals', 'linux', 'runtime', 'Small asynchronous messages the kernel delivers to processes: SIGTERM asks politely, SIGKILL cannot be caught or ignored.', 'The mechanism for stopping, interrupting and killing processes.', {
    lv: { o: 'docker stop = SIGTERM then SIGKILL; docker kill = SIGKILL by default.', p: 'A program decides how to respond to SIGTERM; it cannot respond to SIGKILL.', k: 'kill(2) queues the signal; delivery to PID 1 of a namespace is restricted.' },
    relatesTo: ['pid1', 'exit-codes', 'lifecycle'],
    experiments: ['kill-pid1', 'signal-handling'],
    kernel: ['kill(2)', 'SIGTERM', 'SIGKILL'],
  }),
  C('namespaces', 'Namespaces', 'linux', 'kernel', 'A kernel feature that gives a process its own private view of one kind of global resource: process IDs, network stack, mounts, hostname, IPC, users.', 'It is what makes a process look like it is alone on a machine.', {
    metaphor: 'Frosted glass around the process: it only sees what is inside.',
    lv: { s: 'Frosted rings around the process that hide the rest of the whale.', p: 'Each container is a process in its own set of namespaces; `lsns` on the host lists them.', k: 'Types: mnt, pid, net, uts, ipc, user, cgroup, time. Created with clone/unshare flags, joined with setns.', i: 'config.json linux.namespaces lists which to create or join.', w: 'A Kubernetes Pod is containers that deliberately SHARE net/IPC namespaces.' },
    parts: ['pid-ns', 'net-ns', 'mnt-ns', 'user-ns'],
    implementedBy: [],
    managedBy: ['runc'],
    relatesTo: ['container', 'cgroups'],
    outward: ['pod'],
    misconceptions: ['"Namespaces limit resources." They only change visibility; cgroups limit usage.'],
    kernel: ['clone(CLONE_NEWPID|NEWNET|NEWNS|NEWUTS|NEWIPC)', 'setns', 'unshare'],
  }),
  C('pid-ns', 'PID namespace', 'linux', 'kernel', 'Gives a process its own numbering of processes: the first one is PID 1, and it cannot see the host\'s other processes.', 'So a container\'s ps shows only its own processes.', {
    lv: { p: 'The same process has two PIDs: 1 inside, 4117 on the host.', k: 'Processes are visible in the parent namespace under a different number.' },
    dependsOn: ['kernel'],
    relatesTo: ['pid1', 'process'],
    kernel: ['CLONE_NEWPID'],
  }),
  C('net-ns', 'Network namespace', 'linux', 'kernel', 'A private network stack: its own interfaces, IP addresses, routing table, firewall rules and ports.', 'So each container has its own eth0, its own localhost and can bind port 80 without clashing.', {
    lv: { p: 'ip addr inside the container shows eth0 and lo only.', k: 'One end of a veth pair lives inside; the other end is attached to a bridge on the host.' },
    dependsOn: ['kernel'],
    relatesTo: ['veth', 'bridge', 'network'],
    kernel: ['CLONE_NEWNET', 'ip netns'],
  }),
  C('mnt-ns', 'Mount namespace', 'linux', 'kernel', 'A private table of mounts: the container sees its own root filesystem and whatever volumes/binds were mounted in, not the host\'s.', 'It is how a container gets its own / built from image layers.', {
    lv: { p: 'The container\'s / is the overlay mount; /proc and /dev are fresh mounts.', k: 'runc builds the mount table then pivot_root()s into the new root, hiding the host filesystem.', i: 'config.json mounts[] and root.path.' },
    dependsOn: ['kernel', 'overlayfs'],
    relatesTo: ['volume', 'bind-mount', 'tmpfs'],
    kernel: ['CLONE_NEWNS', 'pivot_root', 'mount'],
  }),
  C('user-ns', 'User namespace', 'linux', 'kernel', 'Maps user IDs inside the container to different IDs outside, so root in the container can be an unprivileged user on the host.', 'It reduces the damage if a container is compromised.', {
    lv: { k: 'Not enabled by default in Docker (rootless mode and userns-remap enable it).', w: 'Podman rootless and Kubernetes user-namespace support rely on it.' },
    relatesTo: ['capabilities', 'container'],
    kernel: ['CLONE_NEWUSER', 'uid_map'],
  }),
  C('cgroups', 'Control groups (cgroups)', 'linux', 'resource', 'A kernel feature that groups processes and limits/accounts the resources they can use: memory, CPU, process count, I/O.', 'Without limits one container can eat the whole machine.', {
    metaphor: 'Weighted straps and gauges on each container, limiting how much of the whale it may consume.',
    lv: { s: 'Gauges and weight straps on each container: how much brain (CPU) and RAM it may use.', p: '`docker stats` is just reading these counters.', k: 'A directory tree under /sys/fs/cgroup; files like memory.max, cpu.max, pids.max hold limits and memory.current holds usage.', i: 'config.json linux.resources holds the limits runc writes.', w: 'Kubernetes requests/limits are translated into cgroup settings.' },
    parts: ['memory-limit', 'cpu-limit', 'pids-limit'],
    managedBy: ['runc'],
    relatesTo: ['container', 'namespaces', 'oom-killer'],
    outward: ['observability', 'kubernetes'],
    kernel: ['/sys/fs/cgroup', 'memory.max', 'cpu.max', 'pids.max'],
    misconceptions: ['"Containers are limited by default." No memory or CPU limits are set unless you ask.'],
  }),
  C('memory-limit', 'Memory limit', 'linux', 'resource', 'A cgroup cap on how much RAM a container may use. Beyond it the kernel tries to reclaim memory and, failing that, kills a process in the container.', 'So one leaking app cannot exhaust the whole host.', {
    lv: { o: '--memory 256m, or docker update --memory.', k: 'Writes memory.max; usage is memory.current; crossing it triggers the cgroup OOM killer.', e: 'dockerd sets the limit when it asks runc to create the container, and can change it live (docker update).', w: 'Kubernetes memory limits: exceeding them gives "OOMKilled".' },
    dependsOn: ['cgroups'],
    relatesTo: ['oom-killer', 'exit-codes'],
    experiments: ['reduce-memory', 'memory-leak'],
    commands: ['docker run --memory', 'docker update --memory', 'docker stats'],
    kernel: ['memory.max', 'memory.current'],
  }),
  C('cpu-limit', 'CPU limit', 'linux', 'resource', 'A cgroup quota that throttles a container\'s CPU time (e.g. 0.5 cores). It slows the container down; it never kills it.', 'Fair sharing of CPU between workloads.', {
    lv: { o: '--cpus 0.5', k: 'cpu.max = "50000 100000": 50 ms of CPU time per 100 ms window; beyond that the processes are paused until the next window.' },
    dependsOn: ['cgroups'],
    relatesTo: ['cgroups'],
    experiments: ['cpu-throttle'],
    kernel: ['cpu.max', 'CFS bandwidth'],
    misconceptions: ['"CPU limit exceeded = container killed." CPU is compressible: the container just runs slower.'],
  }),
  C('pids-limit', 'PIDs limit', 'linux', 'resource', 'A cgroup cap on how many processes/threads a container may create.', 'Stops fork bombs from taking down the host.', {
    lv: { o: '--pids-limit 100', k: 'pids.max; fork() returns EAGAIN beyond it.' },
    dependsOn: ['cgroups'],
    kernel: ['pids.max'],
  }),
  C('oom-killer', 'OOM killer', 'linux', 'failure', 'The kernel\'s last resort when memory runs out (in a cgroup or on the whole host): it picks a process by a badness score and sends it SIGKILL.', 'Keeping the system alive by sacrificing one process.', {
    metaphor: 'Lightning from the storm clouds: one cargo box is struck when the whale\'s memory is exhausted.',
    lv: { s: 'A storm strikes one container when memory runs out.', k: 'Cgroup OOM (limit reached) vs global OOM (host exhausted). Logged in dmesg as "Out of memory: Killed process".', p: 'The victim gets SIGKILL: no cleanup, exit code 137, State.OOMKilled=true.' },
    dependsOn: ['kernel', 'memory-limit'],
    relatesTo: ['exit-codes', 'signals', 'container'],
    experiments: ['reduce-memory', 'memory-leak', 'crash-loop'],
    kernel: ['oom_score', 'oom_kill_process'],
  }),
  C('overlayfs', 'OverlayFS', 'linux', 'storage', 'A union filesystem that presents several read-only lower directories plus one writable upper directory as a single merged tree.', 'It lets many containers share the same image layers while each keeps private changes, without copying anything.', {
    metaphor: 'Transparent plates stacked on a whiteboard: you see all of them as one picture, and scribbles go on top only.',
    lv: { p: 'Mounted as the container\'s root: lowerdir=layers…,upperdir=container diff,workdir=…', k: 'Copy-on-write: modifying a lower file copies it up first; deleting writes a whiteout marker.', i: 'The overlay snapshotter in containerd prepares these mounts per container.' },
    dependsOn: ['kernel', 'layer'],
    implementedBy: [],
    relatesTo: ['writable-layer', 'layer', 'mnt-ns'],
    kernel: ['overlay', 'lowerdir/upperdir/workdir', 'whiteout'],
  }),
  C('veth', 'veth pair', 'linux', 'network', 'A virtual Ethernet cable: two connected network interfaces, one placed inside the container\'s namespace (eth0) and the other attached to a bridge on the host.', 'It is how a namespaced container is physically "plugged in" to the host network.', {
    lv: { s: 'The cable plug between a container and its signal line.', k: 'Packets entering one end come out the other. `ip link` shows vethXXXX@ifN.' },
    dependsOn: ['net-ns', 'kernel'],
    relatesTo: ['bridge', 'network'],
    kernel: ['ip link add type veth'],
  }),
  C('bridge', 'Linux bridge', 'linux', 'network', 'A virtual Layer-2 switch inside the kernel that connects veth ends and gives the network its gateway address.', 'It makes all containers on a network able to talk as if plugged into one switch.', {
    lv: { s: 'The junction box where signal lines meet.', k: 'docker0 for the default network, br-<id> for user-defined ones; forwards frames by MAC address.' },
    dependsOn: ['kernel'],
    relatesTo: ['veth', 'network', 'iptables'],
    kernel: ['bridge', 'br_netfilter'],
  }),
  C('iptables', 'iptables / netfilter', 'linux', 'network', 'The kernel packet-filtering framework Docker programs to publish ports (DNAT), give containers internet access (MASQUERADE) and isolate networks from each other.', 'Port publishing, outbound NAT and network isolation are all just firewall rules.', {
    lv: { k: 'nat table: DOCKER chain (DNAT for -p), POSTROUTING MASQUERADE; filter table: DOCKER-USER, DOCKER-ISOLATION chains.', e: 'dockerd (libnetwork) installs the rules when containers start and removes them when they stop.', w: 'Kubernetes kube-proxy and Cilium do comparable work cluster-wide (iptables, IPVS, eBPF).' },
    dependsOn: ['kernel'],
    relatesTo: ['port-publish', 'network'],
    outward: ['kubernetes'],
    kernel: ['netfilter', 'nat', 'DNAT', 'MASQUERADE'],
  }),
  C('capabilities', 'Linux capabilities', 'linux', 'kernel', 'The kernel splits root\'s all-powerful rights into ~40 separate capabilities. Docker drops most of them by default (keeps 14).', 'So "root in a container" is much weaker than root on the host.', {
    lv: { o: '--cap-add / --cap-drop; --privileged grants everything.', k: 'e.g. NET_BIND_SERVICE lets a process bind ports <1024; SYS_ADMIN is nearly root.', i: 'config.json process.capabilities.' },
    dependsOn: ['kernel'],
    relatesTo: ['seccomp', 'user-ns', 'container'],
    kernel: ['capabilities(7)'],
  }),
  C('seccomp', 'seccomp', 'linux', 'kernel', 'A kernel syscall filter. Docker\'s default profile blocks ~44 dangerous system calls (like mount, reboot, kexec).', 'Shrinks the kernel surface a compromised container can attack.', {
    lv: { k: 'A BPF program evaluated on every syscall; blocked calls return EPERM.', i: 'config.json linux.seccomp.', w: 'Kubernetes RuntimeDefault seccomp profile = same idea.' },
    dependsOn: ['kernel'],
    relatesTo: ['capabilities', 'container'],
    kernel: ['seccomp-bpf'],
  }),

  /* ===================================== OCI ===================================== */
  C('oci-image', 'OCI Image Spec', 'oci', 'standard', 'The open standard for image format: a manifest, an image config and layer blobs, all content-addressed by digest.', 'So images built by any tool run on any compliant runtime.', {
    lv: { i: 'manifest → { config: {digest}, layers: [{mediaType, digest, size}] }; config → architecture, os, rootfs.diff_ids, history, Cmd/Env/ExposedPorts.', w: 'Docker, Podman, Buildah, containerd, Kubernetes all read the same format.' },
    parts: ['manifest', 'digest', 'image-index'],
    relatesTo: ['image', 'layer', 'oci-distribution', 'oci-runtime'],
    outward: ['supply-chain'],
  }),
  C('oci-runtime', 'OCI Runtime Spec', 'oci', 'standard', 'The open standard describing how to run a container: a bundle containing a root filesystem and config.json (process, mounts, namespaces, cgroups, capabilities, seccomp), and the create/start/kill/delete commands.', 'So the engine (Docker, containerd, CRI-O) and the low-level runtime (runc, crun, gVisor) are swappable.', {
    lv: { i: 'config.json: ociVersion, process{args,env,cwd,user,capabilities}, root{path}, mounts[], linux{namespaces,resources,seccomp}.', e: 'containerd writes this file; runc consumes it.', w: 'gVisor\'s runsc and Kata implement the same spec with different isolation.' },
    relatesTo: ['runc', 'containerd', 'container'],
    outward: ['sandbox-runtimes'],
  }),
  C('oci-distribution', 'OCI Distribution Spec', 'oci', 'standard', 'The open HTTP API for registries: how to list tags, fetch manifests and blobs by digest, and push images.', 'So any client can pull from any registry.', {
    lv: { i: 'GET /v2/<name>/manifests/<tag|digest>; GET /v2/<name>/blobs/<digest>; HEAD for existence; resumable uploads for push.', w: 'ghcr.io, ECR, GAR, Harbor and Docker Hub implement it.' },
    relatesTo: ['registry', 'manifest', 'digest'],
    outward: ['registry-products'],
  }),
  C('manifest', 'Image manifest', 'oci', 'standard', 'A small JSON document that names an image\'s config blob and layer blobs by digest, sizes and media types.', 'It is the table of contents that makes an image verifiable and downloadable in parallel.', {
    lv: { i: 'mediaType application/vnd.oci.image.manifest.v1+json; its own sha256 is "the image digest".', o: 'docker pull prints "Digest: sha256:…" (the manifest digest).' },
    dependsOn: ['digest'],
    relatesTo: ['image', 'tag', 'image-index'],
  }),
  C('digest', 'Content digest', 'oci', 'standard', 'A sha256 hash of exact bytes, used as an immutable name: same digest means byte-for-byte the same content.', 'Integrity and deduplication: you can verify what you got and never store or send the same blob twice.', {
    lv: { i: 'sha256:<64 hex>. Layers, configs and manifests are all addressed this way.', w: 'Pinning deployments to digests prevents tag-moves from changing what runs; signatures are made over digests.' },
    relatesTo: ['layer', 'manifest', 'tag'],
    outward: ['supply-chain'],
  }),
  C('image-index', 'Image index (multi-arch)', 'oci', 'standard', 'A manifest of manifests: one tag points at several platform-specific images so the client can pick the right one.', 'One name like nginx:latest works on amd64, arm64 and more.', {
    lv: { i: 'manifests[] each with platform {os, architecture, variant}.' },
    dependsOn: ['manifest'],
    relatesTo: ['platform', 'tag'],
  }),

  /* ================================== ECOSYSTEM =================================== */
  C('kubernetes', 'Kubernetes', 'ecosystem', 'runtime', 'An orchestrator that schedules containers (in Pods) across many machines, restarts and scales them and routes traffic to them.', 'One host is a single point of failure and a ceiling. Orchestration runs fleets.', {
    lv: { w: 'The kubelet on each node asks containerd (or CRI-O) to run Pods through the CRI; those use runc exactly like Docker does. Docker\'s own engine layer is not needed.' },
    dependsOn: ['cri', 'containerd', 'pod'],
    relatesTo: ['orchestration', 'compose'],
    outward: [],
    misconceptions: ['"Kubernetes replaced containers." It orchestrates them; the container runtime underneath is the same containerd/runc.'],
  }),
  C('cri', 'Container Runtime Interface (CRI)', 'ecosystem', 'standard', 'The gRPC API Kubernetes uses to talk to container runtimes: run Pods, manage images and container lifecycles.', 'So Kubernetes is not tied to Docker.', {
    lv: { w: 'containerd (CRI plugin) and CRI-O implement it; dockershim was removed in Kubernetes 1.24.' },
    relatesTo: ['containerd', 'kubernetes'],
  }),
  C('pod', 'Pod', 'ecosystem', 'runtime', 'Kubernetes\' smallest deployable unit: one or more containers that share a network namespace, IPC and volumes and are scheduled together.', 'Some processes (an app and its log shipper, say) must share localhost and storage.', {
    lv: { k: 'Implemented by a "pause" container that holds the shared namespaces while the real containers join them with setns().', w: 'Compare: a Docker container is a single process group with its own namespaces.' },
    dependsOn: ['namespaces', 'container'],
    relatesTo: ['kubernetes'],
  }),
  C('orchestration', 'Orchestration', 'ecosystem', 'runtime', 'Automating where containers run, scaling them, replacing failed ones and rolling out updates across a cluster.', 'Production needs self-healing and scale that one docker run cannot give.', {
    lv: { w: 'Kubernetes, Nomad, ECS, Docker Swarm. Compose is the single-host, development-scale cousin.' },
    relatesTo: ['compose', 'restart-policy', 'healthcheck', 'kubernetes'],
  }),
  C('podman', 'Podman', 'ecosystem', 'runtime', 'A daemonless, rootless-friendly container engine with a Docker-compatible CLI that uses the same OCI images and runtimes.', 'Shows that "Docker" is one implementation of open standards.', {
    lv: { w: 'Each container is a child of podman (via conmon), no central daemon; same Containerfile/Dockerfile and OCI images.' },
    relatesTo: ['docker-cli', 'runc', 'oci-image'],
  }),
  C('sandbox-runtimes', 'Sandboxed runtimes (gVisor, Kata)', 'ecosystem', 'kernel', 'OCI-compatible runtimes that add a stronger boundary than namespaces: gVisor reimplements the kernel in user space, Kata runs each Pod in a lightweight VM.', 'Because containers share the host kernel, running untrusted code needs more.', {
    lv: { w: 'Plug into containerd via a different shim/runtime handler; the image and the command line stay the same.' },
    relatesTo: ['runc', 'kernel', 'oci-runtime'],
  }),
  C('cloud-runtimes', 'Managed container platforms', 'ecosystem', 'runtime', 'Services (AWS ECS/Fargate, Google Cloud Run, Azure Container Apps) that run OCI images for you without you managing hosts.', 'Most teams want to ship images, not operate kernels.', {
    lv: { w: 'Fargate runs each task in a Firecracker microVM: namespaces/cgroups inside, a VM boundary outside.' },
    relatesTo: ['host', 'image'],
  }),
  C('ci-cd', 'CI/CD', 'ecosystem', 'build', 'Automated pipelines that build an image once from a Dockerfile, test it, push it to a registry by digest and deploy that exact artifact.', 'The image that passed tests must be the image that ships.', {
    lv: { w: 'GitHub Actions, GitLab CI, Jenkins: docker build → push → deploy to Kubernetes/ECS.' },
    relatesTo: ['build', 'registry', 'image'],
  }),
  C('supply-chain', 'Supply-chain security', 'ecosystem', 'failure', 'Knowing and verifying what is in your images and where they came from: SBOMs, vulnerability scans, signatures (cosign/sigstore) and provenance (SLSA).', 'Images pull in hundreds of packages; trust must be checkable.', {
    lv: { w: 'Signatures and attestations are stored as OCI artifacts next to the image, referenced by digest.' },
    relatesTo: ['image', 'digest', 'registry'],
  }),
  C('observability', 'Observability', 'ecosystem', 'resource', 'Logs, metrics and traces that show what containers are doing. Metrics tools mostly read cgroup counters.', 'You cannot fix what you cannot see.', {
    lv: { p: 'docker stats and cAdvisor read memory.current, cpu.stat and friends.', w: 'Prometheus + Grafana, Loki, OpenTelemetry, Datadog.' },
    relatesTo: ['logs', 'cgroups'],
  }),
  C('registry-products', 'Registry products', 'ecosystem', 'registry', 'Hosted and self-hosted registries (Docker Hub, GHCR, ECR, Artifact Registry, Harbor) that all implement the OCI distribution API.', 'Where images live in real projects.', {
    lv: { w: 'Private registries need credentials (docker login); some add scanning, signing and replication.' },
    relatesTo: ['registry', 'oci-distribution'],
  }),
  C('daemon-restart', 'Daemon restart behaviour', 'engine', 'runtime', 'What happens to containers when dockerd or the host restarts: without live-restore dockerd stops containers when it stops; restart policies bring chosen ones back.', 'It explains surprises after reboots and upgrades.', {
    lv: { e: 'containerd keeps shims alive across ITS restarts; dockerd stopping triggers container stops unless live-restore is on.', p: 'After reboot, dockerd re-reads its database and applies restart policies.', w: 'Orchestrators move this responsibility to the cluster.' },
    dependsOn: ['dockerd', 'restart-policy'],
    relatesTo: ['shim', 'containerd'],
    experiments: ['restart-host', 'containerd-down'],
  }),
];

export const CONCEPTS: Record<string, Concept> = Object.fromEntries(list.map((c) => [c.id, c]));
export const CONCEPT_IDS = list.map((c) => c.id);

export const LEVEL_TO_KEY: Record<Level, LevelKey> = { 0: 's', 1: 'o', 2: 'e', 3: 'p', 4: 'k', 5: 'i', 6: 'w' };

/** Text for a concept at a level; falls back downwards to the nearest defined level, then to the summary. */
export function conceptAt(c: Concept, level: Level): string {
  for (let l = level; l >= 0; l--) {
    const t = c.lv[LEVEL_TO_KEY[l as Level]];
    if (t) return t;
  }
  return c.summary;
}

/** exact text for a level, or null if that level has nothing specific to say */
export function conceptExact(c: Concept, level: Level): string | null {
  return c.lv[LEVEL_TO_KEY[level]] ?? null;
}
