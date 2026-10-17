import { validateAction } from '../../shared/actions';
import type { Action, Level, Overlay, Prediction, RevealMode, Region, Target, WorldEvent } from './types';
import { ALL_OVERLAYS, LEVEL_NAMES } from './types';
import type { WorldEngine } from './engine';
import { CONCEPTS, conceptAt, conceptExact, CONCEPT_IDS, LEVEL_KEYS } from './concepts';
import * as graph from './conceptgraph';
import { diffWorlds } from './diff';
import { inspectTarget, relations, whyObject } from './inspect';
import { kernelView } from './derive';
import { SCENARIOS, SCENARIO_MAP } from './scenarios';
import { PRESETS, diskFreeMB, hostCpuPct, hostMemUsedMB } from './world';
import { actionToCommand } from './terminal';
import { parseTarget } from './util';

/**
 * MCP tool implementations. They run in the browser (the authoritative world);
 * the relay only forwards. Each returns plain JSON-able data.
 */

export interface ToolResult {
  data: unknown;
  isError?: boolean;
}

const err = (message: string, extra: Record<string, unknown> = {}): ToolResult => ({ isError: true, data: { ok: false, error: message, ...extra } });
const lvl = (v: unknown, fallback: Level): Level => (typeof v === 'number' && v >= 0 && v <= 6 ? (Math.round(v) as Level) : fallback);

export function compactEvent(e: WorldEvent): Record<string, unknown> {
  return { id: e.id, step: e.step, tick: e.tick, kind: e.kind, target: e.target, severity: e.severity, source: e.source, causedBy: e.causedBy, summary: e.summary };
}

/* ----------------------------------------------------------------- overview */

export function overview(en: WorldEngine): Record<string, unknown> {
  const w = en.world;
  const v = en.view;
  const containers = Object.values(w.containers).map((c) => ({
    target: `container:${c.name}`,
    image: c.imageRef,
    state: c.state,
    exitCode: c.exitCode,
    oomKilled: c.oomKilled,
    health: c.health,
    reachableFromOutside: c.ports.length ? c.service === 'up' : null,
    pid: c.pid || null,
    ports: c.ports.map((p) => `${p.host}:${p.container}`),
    mounts: c.mounts.map((m) => `${m.type}:${m.source || 'tmpfs'}→${m.target}${m.readOnly ? ':ro' : ''}`),
    networks: Object.entries(c.networks).map(([n, a]) => `${n}${a.ip ? '(' + a.ip + ')' : ''}`),
    limits: { memoryMB: c.limits.memoryMB, cpus: c.limits.cpus, pids: c.limits.pids },
    usage: { memMB: Math.round(c.usage.memMB), cpuPct: Math.round(c.usage.cpuPct) },
    restartPolicy: c.restartPolicy,
    restartCount: c.restartCount,
    writableLayerRecords: c.layerData.items,
    needs: c.workload.needs,
    compose: c.compose ? `${c.compose.project}/${c.compose.service}` : undefined,
    error: c.error || undefined,
  }));
  const hints: string[] = [];
  if (!containers.length) hints.push('The deck is empty: try world_reset {"preset":"welcome"} or world_mutate run_container.');
  if (containers.some((c) => c.state === 'exited' && c.exitCode !== 0)) hints.push('Some containers exited with errors: world_inspect scope="causal_trace" explains why.');
  if (!en.link.agent) hints.push('Call world_connection_test first so the learner sees Santa wave.');
  const pred = en.activePrediction;
  const cur = en.steps[en.cursor]!;
  return {
    online: { browser: true, agentConnected: en.link.agent, lastAgentCallAt: en.link.lastMcpAt },
    timeline: { step: en.cursor, totalSteps: en.steps.length, atEnd: en.atEnd, label: cur.label },
    view: viewJson(en),
    host: {
      name: w.host.name,
      online: w.host.online,
      arch: w.host.arch,
      kernel: w.host.kernel,
      cpu: `${Math.round(hostCpuPct(w))}% of ${w.host.cpuCores} cores`,
      memory: `${Math.round(hostMemUsedMB(w))} / ${w.host.ramMB} MB`,
      diskFreeMB: Math.round(Math.max(0, diskFreeMB(w))),
      conditions: { dnsUp: w.host.net.dnsUp, registryReachable: w.host.net.registryReachable, latencyMs: w.host.net.latencyMs, packetLossPct: w.host.net.packetLossPct, bandwidthMbps: w.host.net.bandwidthMbps, cpuLoadPct: w.host.cpuLoadPct, memPressureMB: w.host.memPressureMB },
    },
    daemons: { dockerd: w.daemons.dockerd.running, containerd: w.daemons.containerd.running, buildkit: w.daemons.buildkit.running },
    containers,
    images: Object.values(w.images).map((i) => ({ target: `image:${i.ref}`, sizeMB: i.sizeMB, arch: i.arch, layers: i.layers.length, usedBy: Object.values(w.containers).filter((c) => c.imageId === i.id).map((c) => c.name) })),
    networks: Object.values(w.networks).map((n) => ({ target: `network:${n.name}`, driver: n.driver, subnet: n.subnet || undefined, dns: n.dns, members: Object.values(w.containers).filter((c) => n.name in c.networks).map((c) => c.name) })),
    volumes: Object.values(w.volumes).map((x) => ({ target: `volume:${x.name}`, records: x.items, mountedBy: Object.values(w.containers).filter((c) => c.mounts.some((m) => m.source === x.name)).map((c) => c.name) })),
    build: { tag: w.build.tag, steps: w.build.steps.map((s, i) => `${i}: ${s.instr} ${s.arg}`), lastBuild: w.build.last ? w.build.last.steps.map((s) => (s.cached ? 'cached' : 'built')) : null },
    compose: w.compose ? { project: w.compose.name, up: w.compose.up, services: w.compose.services.map((s) => `${s.name} → ${s.dependsOn.join(',') || '—'}`) } : null,
    recentRequests: w.requests.slice(-3).map((r) => ({ from: r.from, to: r.to, ok: r.ok, status: r.status, latencyMs: r.latencyMs, reason: r.reason })),
    scenario: en.scenario,
    prediction: pred ? predictionJson(pred, false) : null,
    hints,
  };
}

function viewJson(en: WorldEngine): Record<string, unknown> {
  const v = en.view;
  return {
    level: v.level,
    levelName: LEVEL_NAMES[v.level],
    selected: v.selected,
    focusConcept: v.focusConcept,
    reveal: v.reveal,
    overlays: v.overlays,
    region: v.region,
    zoom: v.zoom,
    labMode: v.labMode,
    timeFlows: v.timeFlows,
    compare: v.compare,
    visibleConcepts: visibleConcepts(en),
  };
}

export function visibleConcepts(en: WorldEngine): string[] {
  const set = new Set<string>();
  const v = en.view;
  if (v.selected) for (const c of graph.conceptsForTarget(v.selected)) set.add(c);
  if (v.focusConcept) set.add(v.focusConcept);
  if (v.reveal) for (const c of graph.reveal(v.reveal.mode, v.reveal.root).nodes) set.add(c);
  return [...set];
}

function predictionJson(p: Prediction, includeAnswer: boolean): Record<string, unknown> {
  return {
    id: p.id,
    status: p.status,
    question: p.question,
    options: p.options,
    chosen: p.chosenId ?? null,
    correct: p.correct ?? null,
    ...(includeAnswer || p.status === 'revealed' ? { answer: p.answerId, explanation: p.explanation } : {}),
    resultStep: p.resultStep ?? null,
  };
}

/* ------------------------------------------------------------- causal trace */

export function causalTrace(en: WorldEngine, eventId?: number): Record<string, unknown> {
  const evs = en.visibleEvents;
  const byId = new Map(evs.map((e) => [e.id, e]));
  let focus: WorldEvent | undefined = eventId !== undefined ? byId.get(eventId) : undefined;
  if (!focus) {
    const rev = [...evs].reverse();
    // the most recent symptom: last warn/error event that is a leaf of a chain, else the last event
    focus = rev.find((e) => e.severity === 'error') ?? rev.find((e) => e.severity === 'warn') ?? rev[0];
  }
  if (!focus) return { ok: false, error: 'no events yet' };
  const chain: WorldEvent[] = [];
  for (let e: WorldEvent | undefined = focus; e; e = e.causedBy !== null ? byId.get(e.causedBy) : undefined) chain.unshift(e);
  const children = new Map<number, WorldEvent[]>();
  for (const e of evs) if (e.causedBy !== null) (children.get(e.causedBy) ?? children.set(e.causedBy, []).get(e.causedBy)!).push(e);
  const effects: Record<string, unknown>[] = [];
  const walk = (id: number, depth: number): void => {
    for (const c of children.get(id) ?? []) {
      if (effects.length > 40) return;
      effects.push({ depth, ...compactEvent(c) });
      walk(c.id, depth + 1);
    }
  };
  walk(focus.id, 1);
  return {
    ok: true,
    focus: compactEvent(focus),
    rootCause: compactEvent(chain[0]!),
    chain: chain.map(compactEvent),
    narration: chain.map((e) => e.summary).join('  →  '),
    downstreamEffects: effects,
  };
}

/* ------------------------------------------------------------------ handler */

export function handleTool(en: WorldEngine, name: string, args: Record<string, unknown> = {}): ToolResult {
  try {
    switch (name) {
      case 'world_inspect':
        return worldInspect(en, args);
      case 'world_focus':
        return worldFocus(en, args);
      case 'world_mutate':
        return worldMutate(en, args);
      case 'world_run_scenario':
        return worldRunScenario(en, args);
      case 'world_set_view':
        return worldSetView(en, args);
      case 'world_set_overlay':
        return worldSetOverlay(en, args);
      case 'world_compare':
        return worldCompare(en, args);
      case 'world_rewind':
        return worldRewind(en, args);
      case 'world_reset':
        return worldReset(en, args);
      case 'world_connection_test': {
        const r = en.dispatch({ action: 'connection_test' }, 'ai', 'AI connection test'); // the dispatch cues the wave
        return { data: { ok: r.ok, message: 'Santa is waving on the learner\'s screen. Your AI is connected.', events: r.events.map(compactEvent) } };
      }
      case 'concept_inspect':
        return conceptInspect(en, args);
      case 'concept_trace_relationship':
        return conceptTrace(en, args);
      case 'lesson_check_understanding':
        return lessonCheck(en, args);
      case 'lesson_get_progress':
        return lessonProgress(en);
      default:
        return err(`unknown tool "${name}"`);
    }
  } catch (e) {
    return err(`tool "${name}" failed: ${(e as Error).message}`);
  }
}

function worldInspect(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const scope = (a.scope as string) ?? 'overview';
  const limit = Math.min(200, Math.max(1, Number(a.limit) || 25));
  const w = en.world;
  switch (scope) {
    case 'overview':
      return { data: overview(en) };
    case 'object': {
      const target = a.target as string | undefined;
      if (!target) return err('scope "object" needs a target such as "container:web"');
      const ins = inspectTarget(w, target, lvl(a.level, en.view.level));
      if (!ins) return err(`no such object "${target}"`, { hint: 'world_inspect scope="overview" lists every target' });
      const why = whyObject(w, target, en.visibleEvents);
      return { data: { ...ins, why: { headline: why.headline, chain: why.chain.map(compactEvent) } } };
    }
    case 'selected': {
      const sel = en.view.selected;
      return { data: { selected: sel, level: en.view.level, visibleConcepts: visibleConcepts(en), inspection: sel ? inspectTarget(w, sel, en.view.level) : null } };
    }
    case 'events': {
      const since = typeof a.since_event === 'number' ? a.since_event : 0;
      const evs = en.visibleEvents.filter((e) => e.id > since).slice(-limit);
      return { data: { count: evs.length, latestEventId: en.visibleEvents[en.visibleEvents.length - 1]?.id ?? 0, events: evs.map(compactEvent) } };
    }
    case 'user_activity': {
      const items = en.userLog.slice(-limit);
      return { data: { note: 'what the LEARNER did (and what you did) most recently, oldest first', activity: items.map((x) => ({ n: x.n, at: new Date(x.at).toISOString(), kind: x.kind, summary: x.summary, target: x.target })) } };
    }
    case 'causal_trace':
      return { data: causalTrace(en, typeof a.event_id === 'number' ? a.event_id : undefined) };
    case 'why': {
      const t = a.target as string | undefined;
      if (!t) return err('scope "why" needs a target');
      const why = whyObject(w, t, en.visibleEvents);
      return { data: { target: t, headline: why.headline, chain: why.chain.map(compactEvent), relations: relations(w, t) } };
    }
    case 'view':
      return { data: viewJson(en) };
    case 'timeline':
      return { data: { cursor: en.cursor, steps: en.steps.map((s) => ({ index: s.index, label: s.label, source: s.source, ok: s.ok, tick: s.world.tick })).slice(-60), scenario: en.scenario } };
    case 'requests':
      return { data: { requests: w.requests.map((r) => ({ id: r.id, tick: r.tick, from: r.from, to: r.to, ok: r.ok, status: r.status, latencyMs: r.latencyMs, reason: r.reason, hops: r.hops.map((h) => `${h.status === 'ok' ? '✓' : h.status === 'fail' ? '✗' : '·'} ${h.node} — ${h.detail}`) })) } };
    case 'logs': {
      const t = a.target as string | undefined;
      if (!t) return err('scope "logs" needs a target');
      const name = parseTarget(t).name || t;
      return { data: { target: t, lines: w.logs.filter((l) => l.container === name).slice(-limit).map((l) => `[t=${l.tick}] ${l.msg}`) } };
    }
    case 'kernel': {
      const t = a.target as string | undefined;
      const c = t ? w.containers[parseTarget(t).name] : undefined;
      if (!c) return err('scope "kernel" needs a container target');
      return { data: { target: t, ...kernelView(w, c) } };
    }
    default:
      return err(`unknown scope "${scope}"`);
  }
}

function worldFocus(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const target = a.target as string | undefined;
  const concept = a.concept as string | undefined;
  const mode = a.reveal as RevealMode | undefined;
  if (concept && !CONCEPTS[concept]) return err(`unknown concept "${concept}"`, { validConcepts: CONCEPT_IDS });
  if (target && !inspectTarget(en.world, target, 0)) return err(`no such object "${target}"`);
  if (a.level !== undefined) en.setView({ level: lvl(a.level, en.view.level) }, 'ai');
  if (a.region) en.setView({ region: a.region as Region }, 'ai');
  if (target) en.select(target, 'ai');
  if (concept) {
    en.setView({ focusConcept: concept }, 'ai');
    en.touchConcept(concept, en.view.level, true);
    en.note('focus', `AI focused concept ${concept}`, concept);
  }
  const root = concept ?? (target ? graph.conceptsForTarget(target)[0] : undefined);
  let sub: graph.Subgraph | null = null;
  if (mode) {
    if (!root) return err('reveal needs a target or concept to start from');
    sub = graph.reveal(mode, root);
    en.setView({ reveal: { mode, root } }, 'ai');
    for (const n of sub.nodes) en.touchConcept(n, en.view.level, false);
    en.note('focus', `AI revealed "${mode}" from ${root}`, root);
  }
  if (typeof a.say === 'string') en.say(a.say.slice(0, 240));
  en.cue('focus', target);
  return {
    data: {
      ok: true,
      focus: { target: en.view.selected, concept: en.view.focusConcept, level: en.view.level, region: en.view.region },
      reveal: sub ? { ...sub, concepts: sub.nodes.map((n) => ({ id: n, name: CONCEPTS[n]?.name, summary: CONCEPTS[n]?.summary })) } : null,
      inspection: target ? summarizeInspection(en, target) : undefined,
    },
  };
}

function summarizeInspection(en: WorldEngine, target: string): unknown {
  const i = inspectTarget(en.world, target, en.view.level);
  if (!i) return null;
  return { title: i.title, subtitle: i.subtitle, status: i.status, story: i.story, correction: i.correction, relations: i.relations };
}

function worldMutate(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const v = validateAction(a);
  if (!v.ok) return err(v.error);
  const before = en.world;
  const act = v.action as unknown as Action;
  const r = en.dispatch(act, 'ai');
  const after = en.world;
  const diff = diffWorlds(before, after).slice(0, 14);
  const trace = r.events.length > 1 ? causalTrace(en, r.events.find((e) => e.severity === 'error')?.id ?? r.events[r.events.length - 1]!.id) : undefined;
  return {
    isError: false,
    data: {
      ok: r.ok,
      step: en.cursor,
      command: actionToCommand(act),
      summary: r.summary,
      error: r.error,
      output: r.output,
      changes: diff,
      events: r.events.slice(0, 40).map(compactEvent),
      eventsTruncated: r.events.length > 40,
      causalChain: trace && (trace as { narration?: string }).narration,
      result: r.data,
      tip: r.ok ? undefined : 'A failed action is a teaching moment: the events above say exactly which layer refused and why.',
    },
  };
}

function worldRunScenario(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  if (a.list) {
    return { data: { scenarios: SCENARIOS.map((s) => ({ id: s.id, title: s.title, whatIf: s.whatIf, concepts: s.concepts, preset: s.preset })) } };
  }
  const resetFirst = a.reset_first === undefined ? true : !!a.reset_first;
  let spec: { id: string; title: string; preset: 'empty' | 'welcome' | 'persistence' | 'shop'; setup: Action[]; steps: Action[] };
  let builtin = false;
  if (typeof a.id === 'string') {
    const s = SCENARIO_MAP[a.id];
    if (!s) return err(`unknown scenario "${a.id}"`, { valid: SCENARIOS.map((x) => x.id) });
    spec = s;
    builtin = true;
    if (a.predict) {
      const p = en.createPrediction({ question: s.ask.question, options: s.ask.options, answerId: s.ask.answer, explanation: s.ask.explanation, scenario: s.id, concepts: s.concepts }, 'ai');
      return { data: { ok: true, prediction: predictionJson(p, false), message: 'The baseline is on screen and a prediction card is waiting for the learner. Ask them to choose and run it; then call world_inspect scope="causal_trace".' } };
    }
  } else {
    const rawSetup = Array.isArray(a.setup) ? a.setup : [];
    const rawSteps = Array.isArray(a.steps) ? a.steps : [];
    if (!rawSteps.length && !rawSetup.length) return err('provide an "id", or custom "steps" (and optionally "setup")');
    const setup: Action[] = [];
    const steps: Action[] = [];
    for (const [list, out] of [[rawSetup, setup], [rawSteps, steps]] as const) {
      for (const x of list) {
        const v = validateAction(x);
        if (!v.ok) return err(`invalid action in scenario: ${v.error}`);
        out.push(v.action as unknown as Action);
      }
    }
    const preset = (a.preset as 'empty' | 'welcome' | 'persistence' | 'shop') ?? 'empty';
    if (!(preset in PRESETS)) return err(`unknown preset ${preset}`);
    spec = { id: 'custom', title: (a.title as string) || 'Custom experiment', preset, setup, steps };
  }
  const run = en.runScenario(spec, { source: 'ai', resetFirst });
  const last = run.events[run.events.length - 1];
  const sev = [...run.events].reverse().find((e) => e.severity === 'error') ?? last;
  return {
    data: {
      ok: true,
      scenario: spec.id,
      title: spec.title,
      steps: en.steps.slice(run.firstStep).map((s) => ({ step: s.index, label: s.label, ok: s.ok })),
      eventsCount: run.events.length,
      events: run.events.slice(-30).map(compactEvent),
      causalTrace: sev ? causalTrace(en, sev.id) : undefined,
      builtinQuestion: builtin ? { question: SCENARIO_MAP[spec.id]!.ask.question, answer: SCENARIO_MAP[spec.id]!.ask.options.find((o) => o.id === SCENARIO_MAP[spec.id]!.ask.answer)?.label, explanation: SCENARIO_MAP[spec.id]!.ask.explanation } : undefined,
      tip: 'Use world_rewind to undo, world_compare to show before/after, or lesson_check_understanding to make the learner predict first next time.',
    },
  };
}

function worldSetView(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const patch: Record<string, unknown> = {};
  if (a.level !== undefined) patch.level = lvl(a.level, en.view.level);
  if (a.region) patch.region = a.region;
  if (typeof a.zoom === 'number') patch.zoom = Math.max(0.5, Math.min(4, a.zoom));
  if (typeof a.lab_mode === 'boolean') patch.labMode = a.lab_mode;
  if (typeof a.time_flows === 'boolean') patch.timeFlows = a.time_flows;
  en.setView(patch, 'ai');
  if (typeof a.select === 'string') {
    if (!inspectTarget(en.world, a.select, 0)) return err(`no such object "${a.select}"`);
    en.select(a.select, 'ai');
  }
  return { data: { ok: true, view: viewJson(en) } };
}

function worldSetOverlay(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const asked = (Array.isArray(a.overlays) ? a.overlays : []) as Overlay[];
  const bad = asked.filter((o) => !ALL_OVERLAYS.includes(o));
  if (bad.length) return err(`unknown overlays: ${bad.join(', ')}`, { valid: ALL_OVERLAYS });
  const mode = (a.mode as string) ?? 'set';
  const cur = new Set(en.view.overlays);
  let next: Overlay[];
  if (mode === 'add') next = [...new Set([...cur, ...asked])];
  else if (mode === 'remove') next = [...cur].filter((o) => !asked.includes(o));
  else next = asked;
  en.setOverlays(next, 'ai');
  return { data: { ok: true, overlays: en.view.overlays, note: next.length > 3 ? 'More than 3 overlays at once gets hard to read; consider fewer.' : undefined } };
}

function worldCompare(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const b = typeof a.b === 'number' ? a.b : en.cursor;
  const aa = typeof a.a === 'number' ? a.a : Math.max(0, b - 1);
  const sa = en.stepAt(aa);
  const sb = en.stepAt(b);
  if (!sa || !sb) return err(`steps must be between 0 and ${en.steps.length - 1}`);
  const diff = diffWorlds(sa.world, sb.world);
  if (a.show) en.setView({ compare: { a: aa, b } }, 'ai');
  return { data: { a: { step: aa, label: sa.label }, b: { step: b, label: sb.label }, changes: diff, summary: diff.length ? `${diff.length} differences` : 'no differences' } };
}

function worldRewind(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  let to = en.cursor;
  if (typeof a.to_step === 'number') to = a.to_step;
  else if (typeof a.back === 'number') to = en.cursor - a.back;
  else if (typeof a.forward === 'number') to = en.cursor + a.forward;
  else return err('give to_step, back or forward');
  const at = en.rewind(to, 'ai');
  const s = en.steps[at]!;
  return { data: { ok: true, step: at, label: s.label, totalSteps: en.steps.length, atEnd: en.atEnd, note: at < en.steps.length - 1 ? 'Later steps are kept as redo until a new action is performed.' : undefined } };
}

function worldReset(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const preset = a.preset as string;
  if (!(preset in PRESETS)) return err(`unknown preset "${preset}"`, { valid: Object.keys(PRESETS) });
  const r = en.reset(preset, 'ai');
  return { data: { ok: r.ok, preset, description: PRESETS[preset]!.blurb, step: en.cursor, overview: overview(en) } };
}

function conceptInspect(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  if (a.list) return { data: { concepts: CONCEPT_IDS.map((id) => ({ id, name: CONCEPTS[id]!.name, domain: CONCEPTS[id]!.domain, summary: CONCEPTS[id]!.summary })) } };
  const id = a.id as string;
  const c = CONCEPTS[id];
  if (!c) return err(`unknown concept "${id}"`, { validConcepts: CONCEPT_IDS });
  const level = lvl(a.level, en.view.level);
  en.touchConcept(id, level, true);
  const levels: Record<string, string> = {};
  for (const [i, k] of LEVEL_KEYS.entries()) if (c.lv[k]) levels[`${i} ${LEVEL_NAMES[i as Level]}`] = c.lv[k]!;
  return {
    data: {
      id: c.id,
      name: c.name,
      domain: c.domain,
      colourRole: c.role,
      summary: c.summary,
      whyItExists: c.why,
      metaphor: c.metaphor,
      atLevel: { level, text: conceptAt(c, level), specific: conceptExact(c, level) !== null },
      levels,
      dependsOn: c.dependsOn,
      madeOf: c.parts,
      dependedBy: graph.reverse(id, ['dependsOn', 'implementedBy']).map((e) => e.from),
      createdBy: c.createdBy,
      managedBy: c.managedBy,
      implementedBy: c.implementedBy,
      relatesTo: c.relatesTo,
      outwardTo: c.outward,
      commonMisconceptions: c.misconceptions,
      suggestedExperiments: c.experiments.filter((e) => SCENARIO_MAP[e]),
      commands: c.commands,
      kernelPrimitives: c.kernel,
    },
  };
}

function conceptTrace(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const from = a.from as string;
  if (!CONCEPTS[from]) return err(`unknown concept "${from}"`, { validConcepts: CONCEPT_IDS });
  const dir = (a.direction as string) ?? 'depends_on';
  const nameOf = (id: string): string => CONCEPTS[id]?.name ?? id;
  let sub: graph.Subgraph;
  let extra: Record<string, unknown> = {};
  switch (dir) {
    case 'down_to_kernel': {
      const r = graph.toKernel(from);
      sub = r.subgraph;
      extra = { chains: r.chains.map((c) => c.map(nameOf).join(' → ')) };
      break;
    }
    case 'out_to_ecosystem': {
      const r = graph.toEcosystem(from);
      sub = r.subgraph;
      extra = { chains: r.chains.map((c) => c.map(nameOf).join(' → ')) };
      break;
    }
    case 'between': {
      const to = a.to as string;
      if (!to || !CONCEPTS[to]) return err('direction "between" needs a valid "to" concept');
      const r = graph.between(from, to);
      if (!r) return { data: { ok: true, path: null, note: 'no relationship path found' } };
      sub = { mode: 'follow', root: from, nodes: r.path, edges: r.edges, truncated: 0, caption: `How ${nameOf(from)} relates to ${nameOf(to)}.` };
      extra = { path: r.path.map(nameOf).join(' → '), edges: r.edges.map((e) => `${nameOf(e.from)} —${e.rel}→ ${nameOf(e.to)}`) };
      break;
    }
    case 'depended_by':
      sub = graph.dependedBy(from);
      break;
    case 'made_of':
      sub = graph.madeOf(from);
      break;
    case 'used_by':
      sub = graph.usedBy(from);
      break;
    case 'why':
      sub = graph.why(from);
      break;
    default:
      sub = graph.dependsOn(from);
  }
  if (a.show) {
    const mode = (dir === 'down_to_kernel' ? 'to_kernel' : dir === 'out_to_ecosystem' ? 'to_ecosystem' : dir === 'between' ? 'follow' : dir) as RevealMode;
    en.setView({ reveal: { mode, root: from }, focusConcept: from }, 'ai');
    en.note('focus', `AI traced ${dir} from ${from}`, from);
  }
  for (const n of sub.nodes) en.touchConcept(n, en.view.level, false);
  return {
    data: {
      ok: true,
      from,
      direction: dir,
      caption: sub.caption,
      nodes: sub.nodes.map((n) => ({ id: n, name: nameOf(n), domain: CONCEPTS[n]?.domain, summary: CONCEPTS[n]?.summary })),
      edges: sub.edges.map((e) => `${nameOf(e.from)} —${e.rel}→ ${nameOf(e.to)}`),
      truncatedNodes: sub.truncated || undefined,
      ...extra,
    },
  };
}

function lessonCheck(en: WorldEngine, a: Record<string, unknown>): ToolResult {
  const action = a.action as string;
  switch (action) {
    case 'predict': {
      const q = a.question as string;
      const options = a.options as { id: string; label: string }[] | undefined;
      const answer = a.answer_id as string;
      if (!q || !Array.isArray(options) || options.length < 2 || !answer) return err('predict needs question, options (2+), and answer_id');
      if (!options.some((o) => o.id === answer)) return err('answer_id must match one of the option ids');
      let steps: Action[] | undefined;
      if (Array.isArray(a.steps)) {
        steps = [];
        for (const x of a.steps) {
          const v = validateAction(x);
          if (!v.ok) return err(`invalid step: ${v.error}`);
          steps.push(v.action as unknown as Action);
        }
      }
      if (!steps && typeof a.scenario !== 'string') return err('predict needs either "scenario" (built-in id) or "steps" (actions to run on commit)');
      if (typeof a.scenario === 'string' && !SCENARIO_MAP[a.scenario]) return err(`unknown scenario "${a.scenario}"`);
      const p = en.createPrediction({ question: q, options, answerId: answer, explanation: (a.explanation as string) ?? '', scenario: a.scenario as string | undefined, steps, concepts: (a.concepts as string[]) ?? [] }, 'ai');
      return { data: { ok: true, prediction: predictionJson(p, false), message: 'The prediction card is on the learner\'s screen. Wait for them to choose; poll with action:"status".' } };
    }
    case 'status': {
      const p = en.activePrediction;
      return { data: p ? { ok: true, prediction: predictionJson(p, false) } : { ok: true, prediction: null } };
    }
    case 'reveal': {
      const p = en.predictions.find((x) => x.status !== 'revealed');
      if (!p) return err('no open prediction');
      const r = en.runPrediction(p.id, 'ai');
      return { data: { ok: true, prediction: r ? predictionJson(r, true) : null, causalTrace: causalTrace(en, r?.rootEventId) } };
    }
    case 'cancel':
      en.cancelPrediction();
      return { data: { ok: true } };
    default:
      return err('action must be predict, status, reveal or cancel');
  }
}

function lessonProgress(en: WorldEngine): ToolResult {
  const p = en.progress;
  const seen = Object.entries(p.concepts).map(([id, v]) => ({ id, name: CONCEPTS[id]?.name ?? id, seen: v.seen, deepestLevel: v.maxLevel })).sort((a, b) => b.seen - a.seen);
  const seenIds = new Set(Object.keys(p.concepts));
  // suggest unseen concepts adjacent to seen ones
  const adjacent = new Map<string, number>();
  for (const id of seenIds) for (const e of graph.forward(id)) if (!seenIds.has(e.to) && CONCEPTS[e.to]?.domain !== 'ecosystem') adjacent.set(e.to, (adjacent.get(e.to) ?? 0) + 1);
  const nextConcepts = [...adjacent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => ({ id, name: CONCEPTS[id]!.name, why: CONCEPTS[id]!.why }));
  const wrong = p.predictions.filter((x) => !x.correct);
  return {
    data: {
      conceptsSeen: seen.length,
      concepts: seen.slice(0, 40),
      levelsVisited: [...p.levelsVisited].sort(),
      neverReachedLevels: ([0, 1, 2, 3, 4, 5, 6] as Level[]).filter((l) => !p.levelsVisited.includes(l)),
      predictions: { total: p.predictions.length, right: p.predictions.length - wrong.length, wrong: wrong.map((x) => ({ question: x.question, theyChose: x.chosen, correctWas: x.answer })) },
      scenariosRun: p.scenarios,
      scenariosNotYetRun: SCENARIOS.filter((s) => !p.scenarios.includes(s.id)).slice(0, 8).map((s) => ({ id: s.id, whatIf: s.whatIf })),
      learnerActions: p.userActions,
      yourActions: p.aiActions,
      suggestions: [
        nextConcepts.length ? `Concepts adjacent to what they have seen: ${nextConcepts.map((c) => c.name).join(', ')}` : 'They have not explored concepts yet.',
        wrong.length ? `Revisit: "${wrong[0]!.question}" — they predicted "${wrong[0]!.chosen}".` : undefined,
        !p.levelsVisited.includes(3) ? 'They have not yet seen level 3 (the container is a process): the "not a little VM" moment.' : undefined,
      ].filter(Boolean),
      nextConcepts,
    },
  };
}

export type { Target };
