import { analyzeJson, lineAndColumn, locatePointer, reindentJson } from './json.js';

// UI rules (requirements E17/S16): typing only triggers an offline validate (parse/check); every other
// operation is an explicit button. Documents live in memory only; nothing is persisted by the browser.

const DOCS = {
  spec: {
    label: 'Spec',
    file: 'spec.json',
    suffix: '.spec.json',
    hint: 'adapter.spec/v1: the Function you want. Edit in the form or as JSON; every change is auto-checked offline.',
  },
  target: {
    label: 'Target',
    file: 'target.json',
    suffix: '.target.json',
    hint: 'adapter.target/v1: private environment expectations. Never commit real tenant values.',
  },
  snapshot: {
    label: 'Snapshot',
    file: 'snapshot.json',
    suffix: '.snapshot.json',
    hint: 'adapter.snapshot/v1: observed state (formula by hash only). Synthetic in Phase 1.',
  },
  plan: {
    label: 'Plan',
    file: 'plan.json',
    suffix: '.plan.json',
    hint: 'adapter.plan/v1: produced by Plan. Always a draft; never executable or approvable in Phase 1.',
  },
  approval: {
    label: 'Approval',
    file: 'approval.json',
    suffix: '.approval.json',
    hint: 'adapter.approval/v1: detached approval envelope. Phase 1 refuses every approval.',
  },
  journal: {
    label: 'Journal',
    file: 'run.journal.json',
    suffix: '.journal.json',
    hint: 'adapter.journal/v1: local operation journal, analysed read-only by Reconcile.',
  },
};

const PARAMETER_TYPES = ['Decimal', 'Boolean', 'String', 'Float', 'DateTime', 'Integer'];
const GROUP_TITLES = {
  check: 'Check',
  compare: 'Inspect & plan',
  gated: 'Gated — always blocked in Phase 1',
  recovery: 'Journal & recovery',
};
const PRIMARY_DOC = { validate: 'spec', plan: 'spec', verify: 'spec', inspect: 'snapshot', apply: 'plan', approve: 'plan', reconcile: 'journal' };
const STATUS_TEXT = {
  succeeded: 'Completed for the reported scope. Execution readiness stays blocked: nothing can be deployed in Phase 1.',
  blocked: 'Blocked by policy, missing evidence, or an unproven capability. Nothing was dispatched.',
  failed: 'Invalid input or a definite failure. See diagnostics.',
  partial: 'Some journaled operations completed and others did not.',
  outcome_unknown: 'A dispatched operation may have taken effect. Human review is required; nothing is retried.',
};
const SPEC_TEMPLATE = {
  schemaVersion: 'adapter.spec/v1',
  kind: 'function',
  identity: { uniqueName: '', displayName: '' },
  binding: 'unbound',
  solution: { uniqueName: '', publisherPrefix: '' },
  parameters: [
    { name: 'Input1', direction: 'input', type: 'Decimal' },
    { name: 'Result', direction: 'output', type: 'Decimal' },
  ],
  formula: { text: '', dialect: 'dataverse-function', locale: 'en-US', lineEndings: 'lf' },
  tableReferences: [],
  connectionReferences: [],
};

const state = {
  token: null,
  meta: null,
  docs: { spec: '', target: '', snapshot: '', plan: '', approval: '', journal: '' },
  active: 'spec',
  specView: 'form',
  history: [],
  dirty: false,
  busy: false,
};

const $ = (id) => document.getElementById(id);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

/** DOM builder; text is always inserted as text nodes, never parsed as HTML. */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let toastTimer = null;
function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = el('div', { class: 'toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- session + API

function initSession() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get('session');
  if (fromUrl) {
    sessionStorage.setItem('dv-native-session', fromUrl);
    history.replaceState(null, '', '/');
  }
  state.token = sessionStorage.getItem('dv-native-session');
}

function setSession(kind, text) {
  const node = $('session-status');
  node.className = `session ${kind}`;
  node.textContent = text;
}

async function api(path, body) {
  const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'X-DV-Session': state.token ?? '' }, cache: 'no-store' };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => null);
  if (response.status === 401) setSession('bad', 'Session invalid: open the link printed by "dv-native ui"');
  return { status: response.status, payload };
}

// ---------------------------------------------------------------- code editor

function createCodeEditor(container, { label, onChange }) {
  const gutter = el('pre', { class: 'gutter', 'aria-hidden': 'true' });
  const area = el('textarea', { spellcheck: 'false', wrap: 'off', autocapitalize: 'off', autocomplete: 'off', 'aria-label': label });
  container.append(gutter, area);
  let lines = 0;
  let trapTab = true;
  const refresh = () => {
    const count = area.value.split('\n').length;
    if (count !== lines) {
      lines = count;
      gutter.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
    }
    gutter.scrollTop = area.scrollTop;
  };
  area.addEventListener('input', () => {
    refresh();
    onChange?.(area.value);
  });
  area.addEventListener('scroll', () => (gutter.scrollTop = area.scrollTop));
  area.addEventListener('focus', () => (trapTab = true));
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      trapTab = false; // next Tab moves focus out, for keyboard users
      return;
    }
    if (event.key === 'Tab' && trapTab && !event.shiftKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  refresh();
  return {
    textarea: area,
    get value() {
      return area.value;
    },
    set value(text) {
      area.value = text;
      refresh();
    },
    select(start, end) {
      area.focus();
      area.setSelectionRange(start, end);
      const line = area.value.slice(0, start).split('\n').length - 1;
      const lineHeight = parseFloat(getComputedStyle(area).lineHeight) || 20;
      area.scrollTop = Math.max(0, (line - 4) * lineHeight);
      refresh();
    },
  };
}

let jsonEditor;
let formulaEditor;

// ---------------------------------------------------------------- documents

function renderTabs() {
  const tabs = $('doc-tabs');
  tabs.replaceChildren(
    ...Object.entries(DOCS).map(([kind, info]) =>
      el(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: kind === state.active ? 'active' : '',
          'aria-selected': kind === state.active ? 'true' : 'false',
          onclick: () => switchDoc(kind),
        },
        info.label,
        state.docs[kind].trim() !== '' ? el('span', { class: 'dot', title: 'has content', 'aria-hidden': 'true' }) : null,
      ),
    ),
  );
}

function renderExampleSelect() {
  const select = $('example-select');
  const names = (state.meta?.examples ?? []).filter((n) => n.endsWith(DOCS[state.active].suffix));
  select.replaceChildren(
    el('option', { value: '' }, names.length > 0 ? 'Load example…' : 'No examples'),
    ...names.map((n) => el('option', { value: n }, n)),
  );
  select.disabled = names.length === 0;
}

function refreshView() {
  const isSpec = state.active === 'spec';
  const showForm = isSpec && state.specView === 'form';
  $('spec-form').hidden = !showForm;
  $('json-editor').hidden = showForm;
  $('spec-view').hidden = !isSpec;
  $('btn-new').hidden = !isSpec;
  $('live-check').hidden = !isSpec;
  for (const button of $('spec-view').querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.view === state.specView);
  }
  $('doc-hint').textContent = DOCS[state.active].hint;
}

function switchDoc(kind) {
  state.active = kind;
  jsonEditor.value = state.docs[kind];
  if (kind === 'spec' && state.specView === 'form') populateForm();
  renderTabs();
  renderExampleSelect();
  refreshView();
}

function onDocChanged(kind, { markDirty = true } = {}) {
  if (markDirty) state.dirty = true;
  renderTabs();
  updateActionChips();
  if (kind === 'spec') scheduleAutoCheck();
}

function setDoc(kind, text, options) {
  state.docs[kind] = text;
  if (state.active === kind) {
    jsonEditor.value = text;
    if (kind === 'spec' && state.specView === 'form') populateForm();
  }
  onDocChanged(kind, options);
}

// ---------------------------------------------------------------- spec form <-> JSON

function field(name) {
  return $('spec-form').elements.namedItem(name);
}

function ensureOption(select, value) {
  if (value !== '' && ![...select.options].some((o) => o.value === value)) {
    select.append(el('option', { value }, value));
  }
  select.value = value;
}

function specObjectForForm() {
  const text = state.docs.spec;
  if (text.trim() === '') return { value: structuredClone(SPEC_TEMPLATE) };
  const analysis = analyzeJson(text);
  if (analysis.error) {
    const { line, column } = lineAndColumn(text, analysis.error.offset);
    return { error: `${analysis.error.message} (line ${line}, column ${column})` };
  }
  if (analysis.duplicate) return { error: `duplicate property at ${analysis.duplicate}` };
  if (!isObject(analysis.value)) return { error: 'the spec must be a JSON object' };
  return { value: analysis.value };
}

function renderParams(parameters) {
  const body = $('param-rows');
  body.replaceChildren();
  for (const p of parameters) addParamRow(isObject(p) ? p : {});
}

function addParamRow(p) {
  const direction = el('select', { 'aria-label': 'Direction', dataset: { param: 'direction' } }, el('option', { value: 'input' }, 'input'), el('option', { value: 'output' }, 'output'));
  const type = el('select', { 'aria-label': 'Type', dataset: { param: 'type' } }, PARAMETER_TYPES.map((t) => el('option', { value: t }, t)));
  ensureOption(direction, str(p.direction) || 'input');
  ensureOption(type, str(p.type) || 'Decimal');
  const name = el('input', { 'aria-label': 'Parameter name', placeholder: 'Name', dataset: { param: 'name' } });
  name.value = str(p.name);
  const row = el(
    'tr',
    {},
    el('td', {}, name),
    el('td', {}, direction),
    el('td', {}, type),
    el('td', {}, el('button', { type: 'button', title: 'Remove parameter', 'aria-label': 'Remove parameter', onclick: () => (row.remove(), applyFormToSpec()) }, '✕')),
  );
  $('param-rows').append(row);
}

function readParams() {
  return [...$('param-rows').querySelectorAll('tr')].map((row) => ({
    name: row.querySelector('[data-param="name"]').value,
    direction: row.querySelector('[data-param="direction"]').value,
    type: row.querySelector('[data-param="type"]').value,
  }));
}

const refsToText = (refs) => (Array.isArray(refs) ? refs.map((r) => (isObject(r) ? str(r.logicalName) : '')).filter(Boolean).join(', ') : '');
const textToRefs = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((logicalName) => ({ logicalName }));

function populateForm() {
  const result = specObjectForForm();
  const error = $('spec-form-error');
  error.hidden = !result.error;
  error.textContent = result.error ? `The form is read-only until the JSON is fixed: ${result.error}. Switch to JSON view to edit.` : '';
  $('spec-fields').disabled = Boolean(result.error);
  if (result.error) return;
  const s = result.value;
  const identity = isObject(s.identity) ? s.identity : {};
  const solution = isObject(s.solution) ? s.solution : {};
  const formula = isObject(s.formula) ? s.formula : {};
  field('uniqueName').value = str(identity.uniqueName);
  field('displayName').value = str(identity.displayName);
  field('solutionUniqueName').value = str(solution.uniqueName);
  field('publisherPrefix').value = str(solution.publisherPrefix);
  ensureOption(field('kind'), str(s.kind) || 'function');
  ensureOption(field('binding'), str(s.binding) || 'unbound');
  renderParams(Array.isArray(s.parameters) ? s.parameters : []);
  formulaEditor.value = str(formula.text);
  field('locale').value = str(formula.locale);
  ensureOption(field('lineEndings'), str(formula.lineEndings) || 'lf');
  field('tableReferences').value = refsToText(s.tableReferences);
  field('connectionReferences').value = refsToText(s.connectionReferences);
}

/** Writes form values into the spec JSON, keeping any fields the form does not show. */
function applyFormToSpec() {
  const result = specObjectForForm();
  if (result.error) return;
  const s = result.value;
  s.kind = field('kind').value;
  s.identity = { ...(isObject(s.identity) ? s.identity : {}), uniqueName: field('uniqueName').value, displayName: field('displayName').value };
  s.binding = field('binding').value;
  s.solution = { ...(isObject(s.solution) ? s.solution : {}), uniqueName: field('solutionUniqueName').value, publisherPrefix: field('publisherPrefix').value };
  s.parameters = readParams();
  const formula = isObject(s.formula) ? s.formula : {};
  s.formula = {
    ...formula,
    text: formulaEditor.value,
    dialect: formula.dialect ?? 'dataverse-function',
    locale: field('locale').value,
    lineEndings: field('lineEndings').value,
  };
  s.tableReferences = textToRefs(field('tableReferences').value);
  s.connectionReferences = textToRefs(field('connectionReferences').value);
  state.docs.spec = `${JSON.stringify(s, null, 2)}\n`;
  if (state.active === 'spec') jsonEditor.value = state.docs.spec;
  onDocChanged('spec');
}

// ---------------------------------------------------------------- auto-check (parse/check only)

let autoTimer = null;
let autoSequence = 0;

function scheduleAutoCheck() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(runAutoCheck, 450);
}

async function runAutoCheck() {
  const box = $('live-check');
  const text = state.docs.spec;
  if (!state.meta) return;
  if (text.trim() === '') {
    box.replaceChildren(el('span', { class: 'muted' }, 'Auto-check: the spec is empty.'));
    return;
  }
  const sequence = ++autoSequence;
  box.replaceChildren(el('span', { class: 'muted' }, 'Auto-check: validating offline…'));
  try {
    const { payload } = await api('/api/run', { operation: 'validate', documents: { spec: text }, offline: true });
    if (sequence !== autoSequence || !payload) return;
    renderLiveCheck(payload);
  } catch {
    if (sequence === autoSequence) box.replaceChildren(el('span', { class: 'status-failed' }, 'Auto-check unavailable: is the dv-native UI still running?'));
  }
}

function renderLiveCheck(result) {
  const phases = result.validation.map((v) =>
    el('span', { class: `status-${v.status}` }, `${v.phase} ${v.status === 'passed' ? '✓' : v.status === 'failed' ? '✗' : v.status}`),
  );
  const head = el(
    'div',
    {},
    el('strong', {}, 'Auto-check '),
    el('span', { class: 'muted' }, '(offline validate, nothing executed): '),
    phases.flatMap((p, i) => (i === 0 ? [p] : [' · ', p])),
  );
  const issues = result.diagnostics.filter((d) => d.severity !== 'info');
  const list =
    issues.length > 0
      ? el(
          'ul',
          {},
          issues.slice(0, 8).map((d) =>
            el(
              'li',
              { class: d.severity === 'error' ? 'status-failed' : 'status-unknown' },
              el('span', { class: 'mono' }, d.code),
              d.path ? [' at ', el('button', { type: 'button', class: 'link', onclick: () => jumpTo('validate', d.path) }, d.path)] : null,
              ` — ${d.message}`,
            ),
          ),
        )
      : el('div', { class: 'status-passed' }, 'Spec passes offline schema and policy checks. Host validation remains unknown (no proven non-executing validator).');
  $('live-check').replaceChildren(head, list);
}

// ---------------------------------------------------------------- actions

let offlineCheckbox;

const titleCase = (name) => name.replace(/(^|\s)\w/g, (m) => m.toUpperCase());

function renderActions() {
  const container = $('actions');
  container.replaceChildren();
  offlineCheckbox = el('input', { type: 'checkbox', checked: true, 'aria-label': 'Validate offline only' });
  const groups = {};
  for (const [name, spec] of Object.entries(state.meta.operations)) (groups[spec.group] ??= []).push([name, spec]);
  for (const group of ['check', 'compare', 'gated', 'recovery']) {
    if (!groups[group]) continue;
    const row = el('div', { class: 'action-row' });
    for (const [name, spec] of groups[group]) {
      const chips = [
        ...spec.required.map((k) => el('span', { class: 'chip required', dataset: { doc: k, required: 'true' } }, k)),
        ...spec.optional.map((k) => el('span', { class: 'chip', dataset: { doc: k } }, `${k}?`)),
      ];
      const button = el('button', { type: 'button', class: 'action', title: spec.summary, dataset: { operation: name }, onclick: () => runAction(name) }, titleCase(name), chips);
      row.append(name === 'validate' ? el('span', { class: 'action' }, button, el('label', { class: 'inline-option' }, offlineCheckbox, 'offline only')) : button);
    }
    container.append(el('div', { class: `action-group ${group}` }, el('h3', {}, GROUP_TITLES[group]), row));
  }
  updateActionChips();
}

function updateActionChips() {
  for (const chip of document.querySelectorAll('.chip[data-required="true"]')) {
    chip.classList.toggle('missing', state.docs[chip.dataset.doc].trim() === '');
  }
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of document.querySelectorAll('button.action')) button.disabled = busy;
  document.body.style.cursor = busy ? 'progress' : '';
}

async function runAction(name) {
  if (state.busy) return;
  const spec = state.meta.operations[name];
  const documents = {};
  for (const kind of [...spec.required, ...spec.optional]) {
    if (state.docs[kind].trim() !== '') documents[kind] = state.docs[kind];
  }
  const body = { operation: name, documents };
  if (spec.acceptsOffline) body.offline = offlineCheckbox.checked;
  setBusy(true);
  try {
    const { payload } = await api('/api/run', body);
    if (payload) {
      addHistory(name, payload);
      renderResult(payload, name);
      showPane('result');
    }
  } catch (error) {
    toast(`Request failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- results

const mono = (text) => el('span', { class: 'mono' }, text);
const section = (title, ...content) => el('section', {}, el('h4', {}, title), ...content);

function table(headers, rows) {
  return el(
    'table',
    { class: 'data' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', {}, c ?? ''))))),
  );
}

function keyValues(pairs) {
  return table(['Field', 'Value'], pairs);
}

function diagnosticsList(diagnostics, operation) {
  return el(
    'ul',
    { class: 'diag' },
    diagnostics.map((d) =>
      el(
        'li',
        { class: d.severity },
        el('span', { class: 'code' }, d.code),
        ` [${d.phase}] `,
        d.path ? el('button', { type: 'button', class: 'link', title: 'Show in document', onclick: () => jumpTo(operation, d.path) }, d.path) : null,
        d.path ? ' ' : null,
        d.message,
      ),
    ),
  );
}

function renderData(result, operation) {
  const data = result.data;
  if (!isObject(data)) return null;
  if (isObject(data.plan)) {
    const plan = data.plan;
    return section(
      'Plan',
      keyValues([
        ['State', `${plan.planState} · approval eligible: ${plan.approvalEligible}`],
        ['Observed', plan.observed.status],
        ['Completeness', plan.evidence.completeness],
        ['Environment', `${plan.target.effectiveEnvironmentClass} (${plan.target.classificationReason})`],
        ['Source sha256', mono(plan.desired.sourceSha256)],
      ]),
      plan.changes.length > 0
        ? table(['Path', 'Change', 'Impact', 'Reason'], plan.changes.map((c) => [mono(c.path), c.change, c.impact, c.reasonCode ?? '']))
        : el('p', { class: 'muted' }, plan.observed.status === 'present' ? 'No changes against the snapshot projection (convergence unverified).' : `No diff: observed state is ${plan.observed.status}.`),
      el('h4', {}, 'Preconditions'),
      table(['Id', 'Status', 'Reason'], plan.preconditions.map((p) => [mono(p.id), p.status, p.reasonCode])),
      el(
        'div',
        { class: 'button-row' },
        el('button', { type: 'button', onclick: () => (setDoc('plan', `${JSON.stringify(plan, null, 2)}\n`), switchDoc('plan'), toast('Plan copied to the Plan tab')) }, 'Send to Plan tab'),
        el('button', { type: 'button', onclick: () => downloadText('plan.json', `${JSON.stringify(plan, null, 2)}\n`) }, 'Download plan.json'),
      ),
    );
  }
  if (Array.isArray(data.components)) {
    return section(
      'Snapshot',
      keyValues([
        ['Source', `${data.source.kind} (mapping ${data.source.mapping})`],
        ['Acquired', `${data.acquiredAt} (${data.ageSeconds}s ago)`],
        ['Completeness', data.completeness.status],
        ['Environment', `claimed ${data.claimedEnvironmentClass}, effective ${data.effectiveEnvironmentClass}`],
      ]),
      table(
        ['Unique name', 'Display name', 'Managed', 'Params', 'Formula sha256'],
        data.components.map((c) => [mono(c.uniqueName), c.displayName, c.managedState, String(c.parameterCount), mono(c.formulaSha256 ? `${c.formulaSha256.slice(0, 16)}…` : 'unknown')]),
      ),
    );
  }
  if (Array.isArray(data.checks)) {
    return section(
      'Verification checks (informational)',
      el('p', { class: 'muted' }, `Observed: ${data.observedStatus}. Read-back stays unknown without live graph reads.`),
      table(['Check', 'Observation', 'Reason'], data.checks.map((c) => [c.check, c.observation, c.reasonCode ?? ''])),
    );
  }
  if (Array.isArray(data.operations) && operation === 'reconcile') {
    return section(
      'Journal operations',
      table(['Operation', 'Last state', 'Status', 'Snapshot finding'], data.operations.map((o) => [mono(o.operationId), o.lastState, o.status, o.snapshotFinding])),
    );
  }
  if (Array.isArray(data.capabilities)) {
    return section('Blocked capability', table(['Operation', 'Reason', 'Unblocked only by'], data.capabilities.map((c) => [mono(c.operation), mono(c.reasonCode), c.unblockingProof])));
  }
  if (typeof data.specSha256 === 'string') {
    return section(
      'Hashes',
      keyValues([
        ['Scope', data.scope],
        ['Profile', data.profileId],
        ['Spec sha256', mono(data.specSha256)],
        ['Source sha256', mono(data.sourceSha256)],
      ]),
    );
  }
  return null;
}

function renderResult(result, operation = result.command) {
  const nodes = [
    el(
      'div',
      { class: 'result-head' },
      el('span', { class: `badge ${result.status}` }, result.status.replace('_', ' ')),
      el('strong', {}, operation),
      el('span', { class: 'muted' }, `exit ${result.exitCode} · readiness ${result.executionReadiness} · ${new Date(result.generatedAt).toLocaleTimeString()}`),
    ),
    el('p', { class: 'explain' }, STATUS_TEXT[result.status] ?? ''),
  ];
  if (result.planId) nodes.push(section('Plan identity', keyValues([['planId', mono(result.planId)], ['planHash', mono(result.planHash)]])));
  if (result.reasonCodes.length > 0) nodes.push(section('Reason codes', el('div', { class: 'chips' }, result.reasonCodes.map((c) => el('span', { class: 'chip mono' }, c)))));
  if (result.validation.length > 0) {
    nodes.push(section('Validation phases', table(['Phase', 'Status', 'Reason'], result.validation.map((v) => [v.phase, el('span', { class: `status-${v.status}` }, v.status), v.reason ?? '']))));
  }
  if (result.operations.length > 0) {
    nodes.push(
      section(
        operation === 'reconcile' ? 'Journaled operation outcomes (read-only analysis)' : 'Operations (nothing is dispatched)',
        table(['Id', 'Kind', 'Status', 'Dispatched', 'Reasons'], result.operations.map((o) => [mono(o.operationId), o.kind, o.status, String(o.dispatched), o.reasonCodes.join(', ')])),
      ),
    );
  }
  const data = renderData(result, operation);
  if (data) nodes.push(data);
  if (result.diagnostics.length > 0) nodes.push(section(`Diagnostics (${result.diagnostics.length})`, diagnosticsList(result.diagnostics, operation)));
  nodes.push(
    el(
      'div',
      { class: 'button-row' },
      el('button', { type: 'button', onclick: () => downloadText(`${operation.replace(' ', '-')}-result.json`, `${JSON.stringify(result, null, 2)}\n`) }, 'Download result JSON'),
    ),
    el('details', { class: 'raw' }, el('summary', {}, 'Raw adapter.result/v1 JSON'), el('pre', {}, JSON.stringify(result, null, 2))),
  );
  $('pane-result').replaceChildren(el('div', { class: 'result' }, nodes));
}

function jumpTo(operation, path) {
  if (path.startsWith('/documents/')) {
    const kind = path.split('/')[2];
    if (DOCS[kind]) switchDoc(kind);
    return;
  }
  const spec = state.meta?.operations[operation];
  const candidates = spec ? [...spec.required, ...spec.optional] : Object.keys(DOCS);
  const primary = PRIMARY_DOC[operation] ?? candidates[0];
  let best = null;
  for (const kind of [primary, ...candidates.filter((k) => k !== primary)]) {
    const text = state.docs[kind];
    if (!text || text.trim() === '') continue;
    const location = locatePointer(text, path);
    if (location?.exact) {
      best = { kind, location };
      break;
    }
    if (location && !best && kind === primary) best = { kind, location };
  }
  if (!best) {
    toast(`No location found for ${path}`);
    return;
  }
  if (best.kind === 'spec') state.specView = 'json';
  switchDoc(best.kind);
  jsonEditor.select(best.location.start, best.location.end);
}

// ---------------------------------------------------------------- history + capabilities

function addHistory(operation, result) {
  state.history.unshift({ operation, result, time: new Date() });
  state.history.length = Math.min(state.history.length, 30);
  renderHistory();
}

function renderHistory() {
  const pane = $('pane-history');
  if (state.history.length === 0) {
    pane.replaceChildren(el('p', { class: 'empty' }, 'No runs yet in this session. History is kept in memory only.'));
    return;
  }
  pane.replaceChildren(
    ...state.history.map((h) =>
      el(
        'button',
        { type: 'button', class: 'history-item', onclick: () => (renderResult(h.result, h.operation), showPane('result')) },
        el('span', { class: `badge ${h.result.status}` }, h.result.status.replace('_', ' ')),
        el('strong', {}, h.operation),
        el('span', { class: 'muted' }, h.time.toLocaleTimeString()),
      ),
    ),
  );
}

function renderCapabilities() {
  $('pane-capabilities').replaceChildren(
    el('p', { class: 'muted' }, 'Every capability is blocked in Phase 1. Protocol evidence and Microsoft supportability are tracked separately.'),
    table(
      ['Operation', 'Phase', 'Reason', 'Evidence', 'Support', 'Unblocked only by'],
      state.meta.capabilities.map((c) => [mono(c.operation), String(c.phase), mono(c.reasonCode), c.protocolEvidence, c.supportability, c.unblockingProof]),
    ),
  );
}

function showPane(name) {
  for (const button of $('result-tabs').querySelectorAll('button')) {
    const active = button.dataset.pane === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  for (const pane of ['result', 'history', 'capabilities']) $(`pane-${pane}`).hidden = pane !== name;
}

// ---------------------------------------------------------------- wiring

function wireStatic() {
  jsonEditor = createCodeEditor($('json-editor'), {
    label: 'Document JSON',
    onChange: (text) => {
      state.docs[state.active] = text;
      onDocChanged(state.active);
    },
  });
  formulaEditor = createCodeEditor($('formula-editor'), { label: 'Power Fx formula' });

  const form = $('spec-form');
  form.addEventListener('input', () => applyFormToSpec());
  form.addEventListener('submit', (event) => event.preventDefault());
  $('btn-add-param').addEventListener('click', () => {
    addParamRow({ name: '', direction: 'input', type: 'Decimal' });
    applyFormToSpec();
  });

  for (const button of $('spec-view').querySelectorAll('button')) {
    button.addEventListener('click', () => {
      state.specView = button.dataset.view;
      if (state.specView === 'form') populateForm();
      else jsonEditor.value = state.docs.spec;
      refreshView();
    });
  }

  $('btn-open').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (state.meta && file.size > state.meta.limits.maxDocumentBytes) {
      toast(`${file.name} is larger than ${state.meta.limits.maxDocumentBytes} bytes`);
      return;
    }
    setDoc(state.active, await file.text());
    toast(`Opened ${file.name} into ${DOCS[state.active].label} (in the browser only)`);
  });

  $('btn-open-formula').addEventListener('click', () => $('formula-file-input').click());
  $('formula-file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    formulaEditor.value = await file.text();
    applyFormToSpec();
    toast(`Loaded formula from ${file.name}`);
  });

  $('example-select').addEventListener('change', async (event) => {
    const name = event.target.value;
    event.target.value = '';
    if (!name) return;
    const { payload } = await api(`/api/examples/${encodeURIComponent(name)}`);
    if (payload?.content !== undefined) {
      setDoc(state.active, payload.content);
      toast(`Loaded synthetic example ${name}`);
    }
  });

  $('btn-new').addEventListener('click', () => {
    state.specView = 'form';
    setDoc('spec', `${JSON.stringify(SPEC_TEMPLATE, null, 2)}\n`);
    switchDoc('spec');
  });

  $('btn-format').addEventListener('click', () => {
    const text = state.docs[state.active];
    if (text.trim() === '') return;
    const result = reindentJson(text);
    if (result.error) {
      const { line, column } = lineAndColumn(text, result.error.offset);
      toast(`Cannot format: ${result.error.message} (line ${line}, column ${column})`);
      if (state.active === 'spec') state.specView = 'json';
      refreshView();
      jsonEditor.select(result.error.offset, result.error.offset);
      return;
    }
    setDoc(state.active, result.text);
  });

  $('btn-download').addEventListener('click', () => {
    const text = state.docs[state.active];
    if (text.trim() === '') return toast('Nothing to download');
    downloadText(DOCS[state.active].file, text);
  });

  $('btn-clear').addEventListener('click', () => setDoc(state.active, ''));

  for (const button of $('result-tabs').querySelectorAll('button')) {
    button.addEventListener('click', () => showPane(button.dataset.pane));
  }

  window.addEventListener('beforeunload', (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function start() {
  wireStatic();
  initSession();
  renderTabs();
  refreshView();
  if (!state.token) {
    setSession('bad', 'No session: open the link printed by "dv-native ui"');
    return;
  }
  let meta;
  try {
    meta = await api('/api/meta');
  } catch {
    setSession('bad', 'Cannot reach the dv-native UI server');
    return;
  }
  if (meta.status !== 200 || !meta.payload) return;
  state.meta = meta.payload;
  $('tool-version').textContent = `v${state.meta.tool.version}`;
  setSession('ok', 'Connected · local session');
  renderActions();
  renderCapabilities();
  renderHistory();
  const example = await api('/api/examples/calculation.spec.json');
  if (example.payload?.content) setDoc('spec', example.payload.content, { markDirty: false });
  switchDoc('spec');
}

start();
