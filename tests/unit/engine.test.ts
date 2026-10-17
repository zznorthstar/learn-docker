import { describe, expect, it } from 'vitest';
import { WorldEngine } from '../../src/engine/engine';
import { CONCEPTS } from '../../src/engine/concepts';
import * as graph from '../../src/engine/conceptgraph';
import { SCENARIOS, SCENARIO_MAP } from '../../src/engine/scenarios';
import { handleTool } from '../../src/engine/tools';
import { inspectTarget, relations } from '../../src/engine/inspect';
import { parseCommand, runRead } from '../../src/engine/terminal';
import { applyAction } from '../../src/engine/sim';
import { ACTION_SPECS, validateAction } from '../../shared/actions';
import { TOOLS } from '../../shared/tools';
import type { Level } from '../../src/engine/types';

const fixedClock = () => 1_700_000_000_000;
const eng = () => new WorldEngine(fixedClock);

describe('concept graph integrity', () => {
  it('every referenced concept id exists', () => {
    for (const c of Object.values(CONCEPTS)) {
      for (const rel of ['dependsOn', 'parts', 'createdBy', 'managedBy', 'implementedBy', 'relatesTo', 'outward'] as const) {
        for (const t of c[rel]) expect(CONCEPTS[t], `${c.id}.${rel} -> ${t}`).toBeTruthy();
      }
    }
  });

  it('every suggested experiment is a real scenario, and every scenario concept exists', () => {
    for (const c of Object.values(CONCEPTS)) for (const e of c.experiments) expect(SCENARIO_MAP[e], `${c.id} experiment ${e}`).toBeTruthy();
    for (const s of SCENARIOS) for (const id of s.concepts) expect(CONCEPTS[id], `${s.id} concept ${id}`).toBeTruthy();
  });

  it('every concept used by simulator events exists', () => {
    const e = eng();
    e.reset('shop');
    e.dispatch({ action: 'set_resource_limit', target: 'container:shop-db-1', resource: 'memory', value: '20MB' });
    const ids = new Set(e.events.flatMap((x) => x.concepts));
    for (const id of ids) expect(CONCEPTS[id], `event concept ${id}`).toBeTruthy();
  });

  it('container reaches the kernel through namespaces and cgroups', () => {
    const { chains } = graph.toKernel('container');
    expect(chains.length).toBeGreaterThan(0);
    const flat = chains.flat();
    expect(flat).toContain('namespaces');
    expect(chains.every((c) => CONCEPTS[c[c.length - 1]!]!.domain === 'linux')).toBe(true);
  });

  it('image reaches OCI/ecosystem outward', () => {
    const { chains } = graph.toEcosystem('image');
    expect(chains.flat().some((id) => CONCEPTS[id]!.domain === 'ecosystem')).toBe(true);
  });

  it('reveal sub-graphs stay small (no spaghetti)', () => {
    for (const id of Object.keys(CONCEPTS)) {
      for (const m of ['depends_on', 'depended_by', 'made_of', 'used_by', 'why', 'follow'] as const) {
        expect(graph.reveal(m, id).nodes.length).toBeLessThanOrEqual(graph.MAX_NODES);
      }
    }
  });

  it('finds a relationship path between distant concepts', () => {
    const r = graph.between('port-publish', 'kernel');
    expect(r).not.toBeNull();
    expect(r!.path[0]).toBe('port-publish');
    expect(r!.path[r!.path.length - 1]).toBe('kernel');
  });

  it('why a concept exists is answered for every concept', () => {
    for (const c of Object.values(CONCEPTS)) {
      expect(c.why.length).toBeGreaterThan(10);
      expect(c.summary.length).toBeGreaterThan(20);
    }
  });
});

describe('scenarios: the lesson can never disagree with the simulation', () => {
  for (const s of SCENARIOS) {
    it(`${s.id}: answer "${s.ask.answer}" is what actually happens`, () => {
      expect(s.ask.options.some((o) => o.id === s.ask.answer)).toBe(true);
      expect(s.ask.options.length).toBeGreaterThanOrEqual(3);
      const e = eng();
      e.runScenario(s, { source: 'user' });
      const evs = e.events.filter((x) => x.step >= 1);
      expect(s.verify(e.world, evs), `scenario ${s.id} outcome does not match its stated answer`).toBe(true);
    });
  }

  it('prediction flow: baseline first, answer, commit, verdict', () => {
    const e = eng();
    const s = SCENARIO_MAP['delete-container']!;
    const p = e.createPrediction({ question: s.ask.question, options: s.ask.options, answerId: s.ask.answer, explanation: s.ask.explanation, scenario: s.id, concepts: s.concepts }, 'ai');
    expect(Object.keys(e.world.containers).sort()).toEqual(['cache-tmp', 'cache-vol']); // baseline visible before answering
    e.answerPrediction(p.id, 'a');
    const r = e.runPrediction(p.id, 'user')!;
    expect(r.status).toBe('revealed');
    expect(r.correct).toBe(false);
    expect(e.progress.predictions[0]!.correct).toBe(false);
    expect(e.world.volumes.mydata!.items).toBe(120);
  });
});

describe('timeline: rewind restores prior state', () => {
  it('scrub back and forth', () => {
    const e = eng();
    e.reset('welcome');
    const afterWelcome = e.cursor;
    e.dispatch({ action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' }); // instant OOM
    expect(e.world.containers.web!.oomKilled).toBe(true);
    e.rewind(afterWelcome);
    expect(e.world.containers.web!.state).toBe('running');
    expect(e.world.containers.web!.limits.memoryMB).toBeNull();
    e.stepForward();
    expect(e.world.containers.web!.state).toBe('exited');
    e.rewind(0);
    expect(Object.keys(e.world.containers)).toHaveLength(0);
  });

  it('a new action after rewinding discards the redo branch', () => {
    const e = eng();
    e.reset('welcome');
    const k = e.cursor;
    e.dispatch({ action: 'stop_container', target: 'container:web' });
    e.rewind(k);
    e.dispatch({ action: 'pause_container', target: 'container:web' });
    expect(e.steps.length).toBe(k + 2);
    expect(e.world.containers.web!.state).toBe('paused');
    expect(e.events.every((x) => x.step <= e.cursor)).toBe(true);
  });

  it('visible events follow the cursor', () => {
    const e = eng();
    e.reset('welcome');
    const k = e.cursor;
    e.dispatch({ action: 'stop_container', target: 'container:web' });
    const n = e.visibleEvents.length;
    e.rewind(k);
    expect(e.visibleEvents.length).toBeLessThan(n);
  });
});

describe('persistence: event-sourced replay reproduces the lab exactly', () => {
  it('serialize → restore gives identical world, events and cursor', () => {
    const e = eng();
    e.reset('persistence');
    e.dispatch({ action: 'remove_container', target: 'container:cache-tmp', force: true });
    e.dispatchMany('two things', [{ action: 'create_network', name: 'n1' }, { action: 'create_volume', name: 'v1' }], 'user');
    e.setView({ level: 3, labMode: true });
    e.select('container:cache-vol');
    e.rewind(2);
    const saved = JSON.parse(JSON.stringify(e.serialize()));
    const r = WorldEngine.restore(saved, fixedClock);
    expect(r.cursor).toBe(e.cursor);
    expect(JSON.stringify(r.world)).toBe(JSON.stringify(e.world));
    expect(r.steps.length).toBe(e.steps.length);
    expect(JSON.stringify(r.steps[r.steps.length - 1]!.world)).toBe(JSON.stringify(e.steps[e.steps.length - 1]!.world));
    expect(r.view.level).toBe(3);
    expect(r.view.selected).toBe('container:cache-vol');
    expect(r.visibleEvents.map((x) => x.kind)).toEqual(e.visibleEvents.map((x) => x.kind));
  });

  it('rejects an incompatible version', () => {
    expect(() => WorldEngine.restore({ v: 999 } as never)).toThrow();
  });
});

describe('inspector reveals more truth at each level', () => {
  it('container: sections grow with level and the metaphor is corrected', () => {
    const e = eng();
    e.reset('welcome');
    const counts: number[] = [];
    for (let l = 0 as Level; l <= 6; l = (l + 1) as Level) {
      const i = inspectTarget(e.world, 'container:web', l)!;
      counts.push(i.sections.length);
      expect(i.correction).toMatch(/VM|process/);
    }
    for (let k = 2; k < 7; k++) expect(counts[k]!).toBeGreaterThanOrEqual(counts[k - 1]!);
    const l3 = inspectTarget(e.world, 'container:web', 3)!;
    expect(JSON.stringify(l3.sections)).toMatch(/containerd-shim-runc-v2/);
    const l4 = inspectTarget(e.world, 'container:web', 4)!;
    expect(JSON.stringify(l4.sections)).toMatch(/memory\.max/);
    expect(JSON.stringify(l4.sections)).toMatch(/DNAT/);
    const l5 = inspectTarget(e.world, 'container:web', 5)!;
    expect(JSON.stringify(l5.sections)).toMatch(/ociVersion/);
  });

  it('image: layers, manifest, changesets', () => {
    const e = eng();
    e.reset('welcome');
    const l2 = inspectTarget(e.world, 'image:nginx:latest', 2)!;
    expect(JSON.stringify(l2.sections)).toMatch(/Dockerfile steps/);
    const l5 = inspectTarget(e.world, 'image:nginx:latest', 5)!;
    expect(JSON.stringify(l5.sections)).toMatch(/application\/vnd\.oci\.image\.manifest\.v1\+json/);
  });

  it('inspection reflects semantic state (limits, oom)', () => {
    const e = eng();
    e.reset('welcome');
    e.dispatch({ action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' });
    const i = inspectTarget(e.world, 'container:web', 1)!;
    expect(i.status.label).toMatch(/OOM killed/);
    expect(JSON.stringify(i.sections)).toMatch(/memory 6 MB/);
  });

  it('relations: what depends on what', () => {
    const e = eng();
    e.reset('shop');
    const rel = relations(e.world, 'container:shop-db-1');
    expect(rel.dependedBy.map((r) => r.target)).toContain('container:shop-api-1');
    expect(rel.dependsOn.map((r) => r.target)).toContain('volume:shop_dbdata');
    expect(relations(e.world, 'volume:shop_dbdata').dependedBy.map((r) => r.target)).toContain('container:shop-db-1');
  });
});

describe('MCP tools (browser-side handlers)', () => {
  it('every tool has a handler and a valid schema', () => {
    const e = eng();
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(80);
      const r = handleTool(e, t.name, t.name === 'world_inspect' ? {} : {});
      expect(r).toHaveProperty('data'); // never throws
    }
    expect(TOOLS.length).toBeLessThanOrEqual(15);
  });

  it('every action in the manual validates and is executable', () => {
    for (const name of Object.keys(ACTION_SPECS)) {
      const bad = validateAction({ action: name });
      const spec = ACTION_SPECS[name]!;
      if (spec.params.some((p) => p.required)) expect(bad.ok).toBe(false);
      else expect(bad.ok).toBe(true);
    }
  });

  it('world_mutate runs semantic actions and returns changes + causal chain', () => {
    const e = eng();
    e.reset('welcome');
    const r = handleTool(e, 'world_mutate', { action: 'set_resource_limit', target: 'container:web', resource: 'memory', value: '6MB' });
    const d = r.data as { ok: boolean; changes: { what: string }[]; causalChain: string };
    expect(d.ok).toBe(true);
    expect(d.changes.some((c) => c.what === 'state')).toBe(true);
    expect(d.causalChain).toMatch(/memory\.max/);
    expect(e.events[e.events.length - 1]!.source).toBe('sim');
    expect(e.progress.aiActions).toBeGreaterThan(0);
  });

  it('world_mutate rejects bad payloads with helpful errors; AI cannot set positions', () => {
    const e = eng();
    expect(handleTool(e, 'world_mutate', { action: 'set_whale_x', value: 700 }).isError).toBe(true);
    const bad = handleTool(e, 'world_mutate', { action: 'run_container' });
    expect(JSON.stringify(bad.data)).toMatch(/missing required parameter/);
    const failing = handleTool(e, 'world_mutate', { action: 'start_container', target: 'container:nope' });
    expect((failing.data as { ok: boolean }).ok).toBe(false);
  });

  it('world_inspect scopes: overview, object, events, causal_trace, user_activity, kernel, logs', () => {
    const e = eng();
    e.reset('shop');
    e.select('container:shop-web-1', 'user');
    e.setView({ level: 4 }, 'user');
    const ov = handleTool(e, 'world_inspect', {}).data as { containers: unknown[]; view: { level: number; selected: string } };
    expect(ov.containers).toHaveLength(3);
    expect(ov.view.level).toBe(4);
    expect(ov.view.selected).toBe('container:shop-web-1');
    const obj = handleTool(e, 'world_inspect', { scope: 'object', target: 'container:shop-db-1', level: 4 }).data as { sections: unknown[]; relations: { dependedBy: unknown[] } };
    expect(obj.sections.length).toBeGreaterThan(4);
    expect(obj.relations.dependedBy.length).toBeGreaterThan(0);
    const ua = handleTool(e, 'world_inspect', { scope: 'user_activity' }).data as { activity: { kind: string }[] };
    expect(ua.activity.some((a) => a.kind === 'select')).toBe(true);
    expect(ua.activity.some((a) => a.kind === 'level')).toBe(true);
    handleTool(e, 'world_mutate', { action: 'compose_stop_service', service: 'db' });
    const ct = handleTool(e, 'world_inspect', { scope: 'causal_trace' }).data as { chain: unknown[]; rootCause: { kind: string }; narration: string };
    expect(ct.chain.length).toBeGreaterThan(1);
    expect(ct.narration).toMatch(/UNHEALTHY|no longer reachable/);
    const k = handleTool(e, 'world_inspect', { scope: 'kernel', target: 'container:shop-db-1' }).data as { cgroup: { path: string } };
    expect(k.cgroup.path).toMatch(/docker-.*\.scope/);
    const logs = handleTool(e, 'world_inspect', { scope: 'logs', target: 'container:shop-db-1' }).data as { lines: string[] };
    expect(logs.lines.length).toBeGreaterThan(0);
  });

  it('world_focus/set_view/set_overlay change the view, not the world', () => {
    const e = eng();
    e.reset('welcome');
    const before = JSON.stringify(e.world);
    handleTool(e, 'world_focus', { target: 'container:web', level: 3, reveal: 'to_kernel', say: 'Look: a process.' });
    expect(e.view.selected).toBe('container:web');
    expect(e.view.level).toBe(3);
    expect(e.view.reveal?.mode).toBe('to_kernel');
    expect(e.caption?.text).toBe('Look: a process.');
    handleTool(e, 'world_set_overlay', { overlays: ['network', 'storage'] });
    expect(e.view.overlays).toEqual(['network', 'storage']);
    handleTool(e, 'world_set_overlay', { overlays: ['network'], mode: 'remove' });
    expect(e.view.overlays).toEqual(['storage']);
    handleTool(e, 'world_set_view', { lab_mode: true, region: 'deck' });
    expect(e.view.labMode).toBe(true);
    expect(JSON.stringify(e.world)).toBe(before);
    expect((handleTool(e, 'world_focus', { target: 'container:ghost' }).data as { ok: boolean }).ok).toBe(false);
  });

  it('world_run_scenario: library, custom experiment, predict mode', () => {
    const e = eng();
    const list = handleTool(e, 'world_run_scenario', { list: true }).data as { scenarios: unknown[] };
    expect(list.scenarios.length).toBeGreaterThanOrEqual(25);
    const run = handleTool(e, 'world_run_scenario', { id: 'reduce-memory' }).data as { ok: boolean; causalTrace: { narration: string } };
    expect(run.ok).toBe(true);
    expect(run.causalTrace.narration).toMatch(/OOM|memory/);
    const custom = handleTool(e, 'world_run_scenario', {
      title: 'Break the cache',
      preset: 'empty',
      setup: [{ action: 'run_container', image: 'redis:7', name: 'c', detach: true }],
      steps: [{ action: 'kill_process', target: 'container:c' }],
    }).data as { ok: boolean };
    expect(custom.ok).toBe(true);
    expect(e.world.containers.c!.exitCode).toBe(137);
    const pred = handleTool(e, 'world_run_scenario', { id: 'port-conflict', predict: true }).data as { prediction: { options: unknown[]; status: string; answer?: string } };
    expect(pred.prediction.status).toBe('open');
    expect(pred.prediction.answer).toBeUndefined(); // answer is hidden until reveal
    expect(e.world.containers.first!.state).toBe('running');
    expect(e.world.containers.second).toBeUndefined(); // experiment has not run yet
  });

  it('lesson_check_understanding: custom prediction from steps; reveal marks correctness', () => {
    const e = eng();
    e.reset('welcome');
    const mk = handleTool(e, 'lesson_check_understanding', {
      action: 'predict',
      question: 'We pause web. Do requests time out or get refused?',
      options: [
        { id: 'a', label: 'refused' },
        { id: 'b', label: 'time out' },
      ],
      answer_id: 'b',
      explanation: 'A paused container is frozen.',
      steps: [{ action: 'pause_container', target: 'container:web' }, { action: 'send_request', from: 'external', to: 'container:web', port: 8080 }],
      concepts: ['cgroups'],
    }).data as { ok: boolean };
    expect(mk.ok).toBe(true);
    const p = e.activePrediction!;
    e.answerPrediction(p.id, 'b');
    const rev = handleTool(e, 'lesson_check_understanding', { action: 'reveal' }).data as { prediction: { correct: boolean; answer: string } };
    expect(rev.prediction.correct).toBe(true);
    expect(e.world.requests[e.world.requests.length - 1]!.reason).toMatch(/paused/);
    const prog = handleTool(e, 'lesson_get_progress', {}).data as { predictions: { total: number; right: number } };
    expect(prog.predictions.total).toBe(1);
    expect(prog.predictions.right).toBe(1);
  });

  it('world_compare / world_rewind / world_reset', () => {
    const e = eng();
    e.reset('welcome');
    handleTool(e, 'world_mutate', { action: 'stop_container', target: 'container:web' });
    const cmp = handleTool(e, 'world_compare', { show: true }).data as { changes: { target: string; what: string; before: string; after: string }[] };
    expect(cmp.changes.find((c) => c.what === 'state')).toMatchObject({ before: 'running', after: 'exited (0)' });
    expect(e.view.compare).toEqual({ a: e.cursor - 1, b: e.cursor });
    const rw = handleTool(e, 'world_rewind', { back: 1 }).data as { ok: boolean; atEnd: boolean };
    expect(rw.atEnd).toBe(false);
    expect(e.world.containers.web!.state).toBe('running');
    const rs = handleTool(e, 'world_reset', { preset: 'persistence' }).data as { ok: boolean };
    expect(rs.ok).toBe(true);
    expect(Object.keys(e.world.containers)).toContain('cache-vol');
  });

  it('concept tools', () => {
    const e = eng();
    const c = handleTool(e, 'concept_inspect', { id: 'container', level: 3 }).data as { atLevel: { text: string }; commonMisconceptions: string[]; kernelPrimitives: string[] };
    expect(c.atLevel.text).toMatch(/process tree/);
    expect(c.commonMisconceptions.join(' ')).toMatch(/lightweight VM/);
    expect(c.kernelPrimitives.length).toBeGreaterThan(0);
    const t = handleTool(e, 'concept_trace_relationship', { from: 'container', direction: 'down_to_kernel', show: true }).data as { chains: string[] };
    expect(t.chains.some((x) => /namespaces|control groups/i.test(x))).toBe(true);
    expect(e.view.reveal?.mode).toBe('to_kernel');
    expect((handleTool(e, 'concept_inspect', { id: 'nope' }).isError)).toBe(true);
    const b = handleTool(e, 'concept_trace_relationship', { from: 'image', to: 'kernel', direction: 'between' }).data as { path: string };
    expect(b.path).toMatch(/→/);
  });

  it('connection test is visible and harmless', () => {
    const e = eng();
    const before = JSON.stringify(e.world.containers);
    const r = handleTool(e, 'world_connection_test', {});
    expect((r.data as { ok: boolean }).ok).toBe(true);
    expect(JSON.stringify(e.world.containers)).toBe(before);
    expect(e.cues.some((c) => c.kind === 'wave')).toBe(true);
  });
});

describe('terminal: decomposition and execution', () => {
  const w = (() => {
    const e = eng();
    e.reset('welcome');
    return e.world;
  })();

  it('decomposes the example command into semantic parts', () => {
    const p = parseCommand(w, 'docker run -d --name web2 -p 8081:80 -v mydata:/data nginx');
    expect(p.error).toBeUndefined();
    const byLabel = Object.fromEntries(p.segs.map((s) => [s.text, s.label]));
    expect(byLabel['run']).toBe('container lifecycle');
    expect(byLabel['-d']).toBe('background lifecycle');
    expect(byLabel['--name']).toBe('identity');
    expect(byLabel['-p']).toBe('port exposure');
    expect(byLabel['-v']).toBe('volume mount');
    expect(byLabel['nginx']).toBe('image resolution');
    expect(p.plan[0]).toMatchObject({ action: 'run_container', image: 'nginx', name: 'web2', ports: ['8081:80'], volumes: ['mydata:/data'], detach: true });
    // segments are ordered and non-overlapping
    for (let i = 1; i < p.segs.length; i++) expect(p.segs[i]!.start).toBeGreaterThanOrEqual(p.segs[i - 1]!.end);
  });

  it('executes against the engine and shows up as one timeline step with events', () => {
    const e = eng();
    const p = parseCommand(e.world, 'docker run -d --name web -p 8080:80 -v mydata:/data -m 128m nginx');
    const res = e.dispatchMany(p.raw, p.plan, 'user');
    expect(res[0]!.ok).toBe(true);
    expect(e.world.containers.web!.limits.memoryMB).toBe(128);
    expect(e.world.volumes.mydata).toBeTruthy();
    expect(e.steps[e.steps.length - 1]!.label).toBe(p.raw);
  });

  it('parses stop/rm/kill/update/network/volume/compose and reports usage errors', () => {
    expect(parseCommand(w, 'docker stop web').plan[0]).toMatchObject({ action: 'stop_container', target: 'container:web' });
    expect(parseCommand(w, 'docker rm -f web').plan[0]).toMatchObject({ action: 'remove_container', force: true });
    expect(parseCommand(w, 'docker kill -s SIGTERM web').plan[0]).toMatchObject({ action: 'kill_process', signal: 'SIGTERM' });
    expect(parseCommand(w, 'docker update --memory 64m web').plan[0]).toMatchObject({ action: 'set_resource_limit', resource: 'memory', value: '64m' });
    expect(parseCommand(w, 'docker network create appnet').plan[0]).toMatchObject({ action: 'create_network', name: 'appnet' });
    expect(parseCommand(w, 'docker network connect appnet web').plan[0]).toMatchObject({ action: 'connect_network', network: 'appnet', container: 'container:web' });
    expect(parseCommand(w, 'docker volume rm v').plan[0]).toMatchObject({ action: 'remove_volume', name: 'v' });
    expect(parseCommand(w, 'docker compose up -d').plan[0]).toMatchObject({ action: 'compose_up' });
    expect(parseCommand(w, 'docker run').error).toMatch(/requires at least 1 argument/);
    expect(parseCommand(w, 'docker foo').error).toMatch(/not a docker command/);
    expect(parseCommand(w, 'ls').error).toMatch(/command not found/);
    expect(parseCommand(w, 'docker run -dit --rm alpine:3.20 sleep 5').plan[0]).toMatchObject({ action: 'run_container', detach: true, cmd: ['sleep', '5'] });
  });

  it('read-only commands print real state', () => {
    const e = eng();
    e.reset('welcome');
    const ps = runRead(e.world, parseCommand(e.world, 'docker ps'), []);
    expect(ps).toMatch(/web/);
    expect(ps).toMatch(/0\.0\.0\.0:8080->80\/tcp/);
    expect(runRead(e.world, parseCommand(e.world, 'docker images'), [])).toMatch(/nginx/);
    expect(runRead(e.world, parseCommand(e.world, 'docker exec web cat /proc/1/cgroup'), [])).toMatch(/docker-[0-9a-f]{64}\.scope/);
    expect(runRead(e.world, parseCommand(e.world, 'docker exec web ps'), [])).toMatch(/nginx: worker process/);
    expect(JSON.parse(runRead(e.world, parseCommand(e.world, 'docker inspect web'), []))[0].State.Status).toBe('running');
    expect(runRead(e.world, parseCommand(e.world, 'docker logs web'), [])).toMatch(/started/);
    expect(runRead(e.world, parseCommand(e.world, 'docker top web'), [])).toMatch(/nginx/);
  });

  it('curl goes through the published port', () => {
    const e = eng();
    e.reset('welcome');
    const ok = parseCommand(e.world, 'curl localhost:8080');
    expect(ok.plan[0]).toMatchObject({ action: 'send_request', from: 'host', to: 'container:web' });
    const refused = parseCommand(e.world, 'curl localhost:9999');
    expect(refused.error).toMatch(/Connection refused/);
  });
});

describe('purity: applyAction never mutates its input world', () => {
  it('input world is untouched', () => {
    const e = eng();
    e.reset('welcome');
    const w = e.world;
    const snap = JSON.stringify(w);
    applyAction(w, { action: 'stop_container', target: 'container:web' }, { source: 'user', step: 9, firstEventId: 1000 });
    expect(JSON.stringify(w)).toBe(snap);
  });
});
