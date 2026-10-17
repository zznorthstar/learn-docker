import type {
  Action,
  ActionResult,
  EventSource,
  Level,
  Prediction,
  Progress,
  Target,
  ViewState,
  World,
  WorldEvent,
} from './types';
import { DEFAULT_VIEW } from './types';
import { applyAction } from './sim';
import { emptyWorld, PRESETS, shopCompose } from './world';
import { SCENARIO_MAP, type Scenario } from './scenarios';
import { conceptsForTarget } from './conceptgraph';
import { actionToCommand } from './terminal';
import { clone } from './util';

/**
 * The semantic world engine: timeline + view + predictions + progress.
 *
 * Event-sourced: the persisted form is just the list of operations; replaying
 * them from the base reproduces every snapshot and every event exactly
 * (the simulator is deterministic). That is how a lab survives a page reload.
 */

export const ENGINE_VERSION = 1;
const MAX_STEPS = 500;

export type Op = { type: 'action'; action: Action } | { type: 'reset'; preset: string };

export interface Step {
  index: number;
  label: string;
  source: EventSource;
  ops: Op[];
  firstEvent: number;
  lastEvent: number;
  ok: boolean;
  world: World;
}

export interface UserLogEntry {
  n: number;
  at: number;
  kind: 'select' | 'level' | 'terminal' | 'lab' | 'rewind' | 'overlay' | 'predict' | 'focus' | 'view' | 'action' | 'inspect' | 'scenario';
  summary: string;
  target?: string;
}

export type ChangeReason = 'world' | 'view' | 'timeline' | 'prediction' | 'progress' | 'link' | 'toast' | 'cue';

export interface Link {
  state: 'offline' | 'connecting' | 'online';
  /** an MCP client has talked to us */
  agent: boolean;
  lastMcpAt: number | null;
  lastMcpClient: string | null;
}

export interface Cue {
  /** one-shot visual cues the renderer should play (not part of world state) */
  kind: 'wave' | 'pull' | 'build' | 'netpulse' | 'shake' | 'focus';
  at: number;
  target?: string;
}

export interface Persisted {
  v: number;
  base?: World;
  steps: { label: string; source: EventSource; ops: Op[] }[];
  cursor: number;
  view: ViewState;
  progress: Progress;
  predictions: Prediction[];
  userLog: UserLogEntry[];
}

export interface ScenarioRun {
  id: string;
  title: string;
  firstStep: number;
  lastStep: number;
}

export interface Captions {
  text: string;
  at: number;
}

const freshProgress = (): Progress => ({ concepts: {}, predictions: [], scenarios: [], levelsVisited: [0], userActions: 0, aiActions: 0 });

export class WorldEngine {
  steps: Step[] = [];
  cursor = 0;
  events: WorldEvent[] = [];
  nextEventId = 1;
  view: ViewState = { ...DEFAULT_VIEW };
  predictions: Prediction[] = [];
  progress: Progress = freshProgress();
  userLog: UserLogEntry[] = [];
  scenario: ScenarioRun | null = null;
  link: Link = { state: 'offline', agent: false, lastMcpAt: null, lastMcpClient: null };
  caption: Captions | null = null;
  cues: Cue[] = [];
  private subs = new Set<(r: ChangeReason) => void>();
  private logN = 0;
  private folded: World | null = null;

  constructor(private clock: () => number = () => Date.now()) {
    this.steps = [{ index: 0, label: 'Start: empty host', source: 'system', ops: [], firstEvent: 0, lastEvent: 0, ok: true, world: emptyWorld() }];
  }

  /* ------------------------------------------------------------ subscription */

  subscribe(fn: (r: ChangeReason) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(r: ChangeReason): void {
    for (const f of this.subs) f(r);
  }

  /* -------------------------------------------------------------- accessors */

  get world(): World {
    return this.steps[this.cursor]!.world;
  }

  get atEnd(): boolean {
    return this.cursor === this.steps.length - 1;
  }

  /** events that belong to the current point in time */
  get visibleEvents(): WorldEvent[] {
    return this.events.filter((e) => e.step <= this.cursor);
  }

  stepAt(i: number): Step | undefined {
    return this.steps[i];
  }

  firstEventOfStep(step: number): number | null {
    const e = this.events.find((x) => x.step === step);
    return e ? e.id : null;
  }

  /* ----------------------------------------------------------------- timeline */

  private truncateFuture(): void {
    if (this.cursor < this.steps.length - 1) {
      this.steps.splice(this.cursor + 1);
      this.events = this.events.filter((e) => e.step <= this.cursor);
      this.scenario = this.scenario && this.scenario.lastStep > this.cursor ? null : this.scenario;
    }
  }

  private pushStep(label: string, source: EventSource, ops: Op[], world: World, evs: WorldEvent[], ok: boolean): Step {
    const index = this.steps.length;
    const step: Step = { index, label, source, ops, firstEvent: evs[0]?.id ?? 0, lastEvent: evs[evs.length - 1]?.id ?? 0, ok, world };
    this.steps.push(step);
    this.cursor = index;
    this.events.push(...evs);
    this.trim();
    this.countSource(source);
    this.trackEvents(evs);
    return step;
  }

  private trim(): void {
    if (this.steps.length <= MAX_STEPS) return;
    const drop = 100;
    const base = this.steps[drop]!.world;
    this.folded = base;
    this.steps.splice(0, drop);
    this.steps[0] = { ...this.steps[0]!, ops: [], label: 'Earlier history folded' };
    this.steps.forEach((s, i) => (s.index = i));
    this.events = this.events.filter((e) => e.step >= drop).map((e) => ({ ...e, step: e.step - drop }));
    this.cursor = Math.max(0, this.cursor - drop);
    for (const p of this.predictions) if (p.resultStep !== undefined) p.resultStep = Math.max(0, p.resultStep - drop);
    if (this.scenario) this.scenario = { ...this.scenario, firstStep: Math.max(0, this.scenario.firstStep - drop), lastStep: Math.max(0, this.scenario.lastStep - drop) };
  }

  private countSource(source: EventSource): void {
    if (source === 'user') this.progress.userActions++;
    else if (source === 'ai') this.progress.aiActions++;
  }

  private trackEvents(evs: WorldEvent[]): void {
    for (const e of evs) for (const c of e.concepts) this.touchConcept(c, 0, false);
  }

  /** Perform one semantic action as one timeline step. */
  dispatch(action: Action, source: EventSource = 'user', label?: string): ActionResult {
    this.truncateFuture();
    const r = applyAction(this.world, action, { source, step: this.steps.length, firstEventId: this.nextEventId });
    this.nextEventId = r.nextEventId;
    this.pushStep(label ?? actionToCommand(action), source, [{ type: 'action', action }], r.world, r.result.events, r.result.ok);
    if (source !== 'user') this.note('action', `${source === 'ai' ? 'AI' : 'system'}: ${label ?? actionToCommand(action)}`);
    else this.note('action', label ?? actionToCommand(action));
    this.cueFor(action, r.result);
    this.emit('world');
    this.emit('timeline');
    return r.result;
  }

  /** Several actions as ONE timeline step (e.g. one terminal command, or scenario setup). */
  dispatchMany(label: string, actions: Action[], source: EventSource = 'user', continueOnError = true): ActionResult[] {
    this.truncateFuture();
    let w = this.world;
    const evs: WorldEvent[] = [];
    const results: ActionResult[] = [];
    const step = this.steps.length;
    for (const a of actions) {
      const r = applyAction(w, a, { source, step, firstEventId: this.nextEventId });
      this.nextEventId = r.nextEventId;
      w = r.world;
      evs.push(...r.result.events);
      results.push(r.result);
      if (!r.result.ok && !continueOnError) break;
    }
    this.pushStep(label, source, actions.map((action) => ({ type: 'action', action })), w, evs, results.every((x) => x.ok));
    this.note('action', label);
    this.emit('world');
    this.emit('timeline');
    return results;
  }

  /** Replace the world with a preset. One timeline step; rewindable. */
  reset(presetId: string, source: EventSource = 'system', label?: string): ActionResult {
    const preset = PRESETS[presetId];
    if (!preset) throw new Error(`unknown preset ${presetId}`);
    this.truncateFuture();
    const step = this.steps.length;
    let w = emptyWorld();
    if (preset.compose) w.compose = shopCompose();
    const evs: WorldEvent[] = [];
    const id = this.nextEventId++;
    evs.push({ id, tick: 0, kind: 'world.reset', target: 'host', summary: `world reset: ${preset.label}`, severity: 'info', source, causedBy: null, concepts: ['host'], minLevel: 0, step });
    let ok = true;
    for (const a of preset.actions) {
      const r = applyAction(w, a, { source: 'sim', step, firstEventId: this.nextEventId });
      this.nextEventId = r.nextEventId;
      w = r.world;
      for (const e of r.result.events) evs.push({ ...e, causedBy: e.causedBy ?? id, source: 'system' });
      ok = ok && r.result.ok;
    }
    this.pushStep(label ?? `Reset: ${preset.label}`, source, [{ type: 'reset', preset: presetId }], w, evs, ok);
    this.scenario = null;
    this.note('action', `reset to "${preset.label}"`);
    this.emit('world');
    this.emit('timeline');
    return { ok, summary: `world reset: ${preset.label}`, events: evs };
  }

  rewind(to: number, source: EventSource = 'user'): number {
    const i = Math.max(0, Math.min(this.steps.length - 1, Math.round(to)));
    if (i === this.cursor) return i;
    this.cursor = i;
    this.note('rewind', `${source === 'user' ? 'moved' : 'AI moved'} the timeline to step ${i}: ${this.steps[i]!.label}`);
    this.view = { ...this.view, compare: this.view.compare };
    this.emit('world');
    this.emit('timeline');
    return i;
  }

  stepBack(source: EventSource = 'user'): number {
    return this.rewind(this.cursor - 1, source);
  }

  stepForward(source: EventSource = 'user'): number {
    return this.rewind(this.cursor + 1, source);
  }

  /* --------------------------------------------------------------------- view */

  setView(patch: Partial<ViewState>, source: EventSource = 'user'): void {
    const prevLevel = this.view.level;
    this.view = { ...this.view, ...patch };
    if (patch.level !== undefined && patch.level !== prevLevel) {
      if (!this.progress.levelsVisited.includes(this.view.level)) this.progress.levelsVisited.push(this.view.level);
      if (this.view.selected) for (const c of conceptsForTarget(this.view.selected)) this.touchConcept(c, this.view.level, false);
      this.note('level', `${source === 'ai' ? 'AI set' : 'set'} abstraction level to ${this.view.level}`);
    }
    this.emit('view');
    this.emit('progress');
  }

  select(target: Target | null, source: EventSource = 'user'): void {
    this.view = { ...this.view, selected: target };
    if (target) {
      for (const c of conceptsForTarget(target)) this.touchConcept(c, this.view.level, true);
      this.note('select', `${source === 'ai' ? 'AI selected' : 'selected'} ${target}`, target);
    }
    this.emit('view');
    this.emit('progress');
  }

  setOverlays(overlays: ViewState['overlays'], source: EventSource = 'user'): void {
    this.view = { ...this.view, overlays };
    this.note('overlay', `${source === 'ai' ? 'AI set' : 'set'} overlays: ${overlays.join(', ') || 'none'}`);
    this.emit('view');
  }

  say(text: string | null): void {
    this.caption = text ? { text, at: this.clock() } : null;
    this.emit('view');
  }

  /* ----------------------------------------------------------------- progress */

  touchConcept(id: string, level: Level | number, count: boolean): void {
    const p = (this.progress.concepts[id] ??= { seen: 0, maxLevel: 0 });
    if (count) p.seen += 1;
    else if (p.seen === 0) p.seen = 1;
    p.maxLevel = Math.max(p.maxLevel, level);
  }

  note(kind: UserLogEntry['kind'], summary: string, target?: string): void {
    this.userLog.push({ n: ++this.logN, at: this.clock(), kind, summary, target });
    if (this.userLog.length > 120) this.userLog.splice(0, this.userLog.length - 120);
  }

  /* -------------------------------------------------------------------- cues */

  private cueFor(a: Action, r: ActionResult): void {
    const now = this.clock();
    const push = (kind: Cue['kind'], target?: string): void => {
      this.cues.push({ kind, at: now, target });
      if (this.cues.length > 20) this.cues.shift();
    };
    if (a.action === 'connection_test') push('wave');
    if (a.action === 'pull_image' || r.events.some((e) => e.kind === 'image.pull.completed')) push('pull');
    if (a.action === 'build_image' || r.events.some((e) => e.kind === 'build.completed')) push('build');
    if (a.action === 'send_request') push('netpulse');
    if (r.events.some((e) => e.kind === 'kernel.oom_kill' || e.severity === 'error')) push('shake');
    this.emit('cue');
  }

  private emitCue(): void {
    this.emit('cue' as ChangeReason);
  }

  cue(kind: Cue['kind'], target?: string): void {
    this.cues.push({ kind, at: this.clock(), target });
    if (this.cues.length > 20) this.cues.shift();
    this.emit('cue' as ChangeReason);
  }

  /* -------------------------------------------------------------- scenarios */

  /**
   * Run an experiment as a group of timeline steps: [reset] + setup (one step) + one step per action.
   */
  runScenario(
    s: Pick<Scenario, 'id' | 'title' | 'preset' | 'setup' | 'steps'>,
    opts: { source?: EventSource; resetFirst?: boolean; skipSteps?: boolean } = {},
  ): { firstStep: number; ok: boolean; results: ActionResult[]; events: WorldEvent[] } {
    const source = opts.source ?? 'user';
    const resetFirst = opts.resetFirst ?? true;
    const first = this.steps.length;
    const results: ActionResult[] = [];
    if (resetFirst) this.reset(s.preset, source, `Setup: ${s.title}`);
    if (s.setup.length) results.push(...this.dispatchMany(resetFirst ? `Setup: ${s.title}` : `Setup (${s.title})`, s.setup, source));
    if (!opts.skipSteps) {
      for (const a of s.steps) results.push(this.dispatch(a, source));
    }
    const last = this.steps.length - 1;
    this.scenario = { id: s.id, title: s.title, firstStep: first, lastStep: last };
    if (!this.progress.scenarios.includes(s.id)) this.progress.scenarios.push(s.id);
    this.note('scenario', `${source === 'ai' ? 'AI ran' : 'ran'} experiment "${s.title}"`);
    this.emit('progress');
    this.emit('timeline');
    return { firstStep: first, ok: results.every((r) => r.ok || true), results, events: this.events.filter((e) => e.step >= first) };
  }

  /* -------------------------------------------------------------- predictions */

  get activePrediction(): Prediction | undefined {
    const live = this.predictions.filter((p) => !p.dismissed);
    return [...live].reverse().find((p) => p.status !== 'revealed') ?? live[live.length - 1];
  }

  /** Create a prediction. If it comes from a scenario, the baseline is built now so the learner can look at it. */
  createPrediction(p: Omit<Prediction, 'status' | 'id'> & { id?: string }, source: EventSource = 'ai'): Prediction {
    for (const old of this.predictions) if (old.status !== 'revealed') old.dismissed = true;
    const pred: Prediction = { ...p, id: p.id ?? `p${this.predictions.length + 1}`, status: 'open' };
    if (pred.scenario) {
      const s = SCENARIO_MAP[pred.scenario];
      if (s) this.runScenario(s, { source, skipSteps: true });
    }
    this.predictions.push(pred);
    this.note('predict', `${source === 'ai' ? 'AI posed' : 'posed'} a prediction: ${pred.question}`);
    this.emit('prediction');
    return pred;
  }

  answerPrediction(id: string, optionId: string): Prediction | null {
    const p = this.predictions.find((x) => x.id === id);
    if (!p || p.status === 'revealed') return p ?? null;
    p.chosenId = optionId;
    p.status = 'answered';
    this.note('predict', `predicted "${p.options.find((o) => o.id === optionId)?.label ?? optionId}"`);
    this.emit('prediction');
    return p;
  }

  /** Run the experiment and reveal. Returns the prediction with its verdict. */
  runPrediction(id: string, source: EventSource = 'user'): Prediction | null {
    const p = this.predictions.find((x) => x.id === id);
    if (!p || p.status === 'revealed') return p ?? null;
    const before = this.steps.length;
    const s = p.scenario ? SCENARIO_MAP[p.scenario] : undefined;
    if (s) for (const a of s.steps) this.dispatch(a, source);
    else for (const a of p.steps ?? []) this.dispatch(a, source);
    p.status = 'revealed';
    p.correct = p.chosenId !== undefined ? p.chosenId === p.answerId : undefined;
    p.resultStep = this.steps.length - 1;
    p.rootEventId = this.firstEventOfStep(before) ?? undefined;
    if (p.chosenId !== undefined) {
      this.progress.predictions.push({ id: p.id, question: p.question, chosen: p.options.find((o) => o.id === p.chosenId)?.label ?? p.chosenId, answer: p.options.find((o) => o.id === p.answerId)?.label ?? p.answerId, correct: !!p.correct });
    }
    for (const c of p.concepts) this.touchConcept(c, this.view.level, true);
    this.note('predict', `experiment run; prediction was ${p.correct === undefined ? 'unanswered' : p.correct ? 'right' : 'wrong'}`);
    this.emit('prediction');
    this.emit('progress');
    return p;
  }

  /** remove an unanswered prediction, or just hide a revealed one */
  cancelPrediction(): void {
    const open = this.predictions.find((x) => x.status !== 'revealed' && !x.dismissed);
    if (open) this.predictions.splice(this.predictions.indexOf(open), 1);
    else {
      const last = this.activePrediction;
      if (last) last.dismissed = true;
    }
    this.emit('prediction');
  }

  /* -------------------------------------------------------------- persistence */

  serialize(): Persisted {
    return {
      v: ENGINE_VERSION,
      base: this.folded ?? undefined,
      steps: this.steps.slice(1).map((s) => ({ label: s.label, source: s.source, ops: s.ops })),
      cursor: this.cursor,
      view: this.view,
      progress: this.progress,
      predictions: this.predictions,
      userLog: this.userLog.slice(-60),
    };
  }

  /** Rebuild from a persisted lab. Throws if the data is incompatible (caller falls back to a fresh lab). */
  static restore(data: Persisted, clock?: () => number): WorldEngine {
    if (!data || data.v !== ENGINE_VERSION) throw new Error('incompatible saved lab');
    const e = new WorldEngine(clock);
    if (data.base) {
      e.steps[0] = { ...e.steps[0]!, world: clone(data.base) };
      e.folded = clone(data.base);
    }
    for (const s of data.steps) {
      e.cursor = e.steps.length - 1;
      for (const op of s.ops) {
        if (op.type === 'reset') {
          e.replayReset(op.preset, s);
        }
      }
      if (s.ops.some((o) => o.type === 'reset')) continue;
      e.replayActions(s);
    }
    e.cursor = Math.max(0, Math.min(e.steps.length - 1, data.cursor));
    e.view = { ...DEFAULT_VIEW, ...data.view };
    e.progress = { ...freshProgress(), ...data.progress };
    e.predictions = data.predictions ?? [];
    e.userLog = data.userLog ?? [];
    e.logN = e.userLog.reduce((m, x) => Math.max(m, x.n), 0);
    return e;
  }

  private replayReset(preset: string, s: { label: string; source: EventSource }): void {
    const saved = this.subs;
    this.subs = new Set();
    const logLen = this.userLog.length;
    this.reset(preset, s.source, s.label);
    this.userLog.length = logLen;
    this.subs = saved;
  }

  private replayActions(s: { label: string; source: EventSource; ops: Op[] }): void {
    const saved = this.subs;
    this.subs = new Set();
    const logLen = this.userLog.length;
    const actions = s.ops.filter((o): o is Extract<Op, { type: 'action' }> => o.type === 'action').map((o) => o.action);
    if (actions.length === 1) this.dispatch(actions[0]!, s.source, s.label);
    else this.dispatchMany(s.label, actions, s.source);
    this.userLog.length = logLen;
    this.subs = saved;
  }
}
