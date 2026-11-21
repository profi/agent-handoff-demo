import { mergeObservation, describeChanges, createRefreshLoop } from './refresh.js';
import { createDecisionUI } from './decision-ui.js';
import { clarificationContext } from './decision-policy.js';
import { createDispatchUI } from './dispatch-ui.js';

const app = document.querySelector('#app');
const dialog = document.querySelector('#inspector');
const inspector = document.querySelector('#inspector-content');
const params = new URLSearchParams(location.search);
const demo = document.documentElement.dataset.viewer === 'demo';
const defaultRun = demo ? 'demo' : 'due-date';
const state = { runs: [], run: params.get('run') ?? defaultRun, phase: params.has('phase') ? Number(params.get('phase')) : demo ? 0 : null, detail: ['overview', 'developer', 'evidence'].includes(params.get('detail')) ? params.get('detail') : 'overview', selected: params.get('message'), data: null, load: 0, inspection: 0 };
Object.assign(state, { view: demo ? 'handoff' : params.get('view') === 'repositories' ? 'repositories' : params.get('view') === 'live' ? params.has('task') ? 'live-handoff' : 'live' : 'handoff', settings: null, repoDraft: { backend: '', frontend: '' }, repoValidation: null, repoNotice: null, repoBusy: false, repoDirty: false, liveList: null, liveBusy: false, liveError: null, liveAttempt: 0, liveTask: params.get('task') });
Object.assign(state, { followLatest: !params.has('snapshot'), refreshBusy: false, refreshError: null, refreshSummary: null, autoRefresh: false, historyBusy: false, historyAttempt: 0, changedMessages: [] });
Object.assign(state, { taskFilter: 'all', taskScan: null, checkedTasks: new Set(), targetDispatch: null, dispatchRestoreError: null });
const refreshLoop = createRefreshLoop({ refresh: () => refreshLiveHandoff(), active: () => state.autoRefresh && state.view === 'live-handoff' && !!state.data });
const renderLiveDecision = createDecisionUI({ state, el, button, request, render, refresh: refreshLiveHandoff });
const renderDispatch = createDispatchUI({ state, el, button, request, render, inspect, refresh: refreshLiveHandoff, onQuestion: key => navigateMessage(key), onReview: (id, task, message) => {
  if (state.view !== 'live-handoff' || state.liveTask !== task || state.selected !== message) return;
  state.targetDispatch = { id, message };
  syncUrl();
} });
const keyOf = message => `${message.source_repository}/${message.message_id}`;
const short = value => value?.slice(0, 9) ?? 'Unavailable';
const label = value => value.replaceAll('_', ' ').toLowerCase();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action) {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}
function badge(text, tone = '') { return el('span', `badge ${tone}`, text); }
function heading(text, subtitle) {
  const node = el('div', 'section-heading'); node.append(el('h2', '', text));
  if (subtitle) node.append(el('p', 'muted', subtitle)); return node;
}
function syncUrl() {
  if (state.view === 'live' || state.view === 'live-handoff') {
    const query = new URLSearchParams({ view: 'live', detail: state.detail });
    if (state.view === 'live-handoff' && state.liveTask) query.set('task', state.liveTask);
    if (state.view === 'live-handoff' && state.selected) query.set('message', state.selected);
    if (state.view === 'live-handoff' && state.targetDispatch?.message === state.selected && state.followLatest) query.set('dispatch', state.targetDispatch.id);
    if (state.view === 'live-handoff' && !state.followLatest && state.data?.snapshot_id) query.set('snapshot', state.data.snapshot_id);
    history.replaceState(null, '', `/?${query}`); return;
  }
  const query = new URLSearchParams({ run: state.run, phase: String(state.phase), detail: state.detail });
  if (state.selected) query.set('message', state.selected);
  if (state.view === 'repositories') query.set('view', 'repositories');
  history.replaceState(null, '', demo ? `?${query}` : `/?${query}`);
}
function base() { return state.data?.mode === 'live' ? `/api/live/snapshots/${state.data.snapshot_id}` : `/api/runs/${state.run}/phases/${state.phase}`; }
let fetchViewer = fetch.bind(window);
async function request(url, options) {
  if (url.startsWith('/api/live/')) options = { ...options, headers: { ...options?.headers, 'X-Viewer-Token': state.settings.token } };
  const response = await fetchViewer(url, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error ?? 'Could not load this record.'); error.data = data; throw error; }
  return data;
}
function closeInspector() { state.inspection++; dialog.close(); }
document.querySelector('#close-inspector').addEventListener('click', closeInspector);
dialog.addEventListener('cancel', () => { state.inspection++; });

async function inspect(title, url) {
  const attempt = ++state.inspection;
  const observation = state.data?.mode === 'live' ? { id: state.data.snapshot_id, time: state.data.observed_at } : null;
  document.querySelector('#inspector-title').textContent = title;
  inspector.replaceChildren(el('p', 'muted', 'Reading pinned evidence…'));
  if (!dialog.open) dialog.showModal();
  try {
    const resultDiff = /^\/api\/live\/dispatches\/[a-f0-9-]+\/diff\?/.test(url);
    const response = await fetchViewer(url, resultDiff ? { headers: { 'X-Viewer-Token': state.settings.token } } : undefined);
    if (response.headers.get('content-type')?.startsWith('image/')) {
      if (!response.ok) throw new Error('Image evidence unavailable.');
      if (attempt !== state.inspection) return;
      const image = el('img', 'evidence-image'); image.src = url; image.alt = title; inspector.replaceChildren(image); return;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Evidence unavailable here.');
    if (attempt !== state.inspection) return;
    inspector.replaceChildren();
    if (observation) inspector.append(el('p', 'provenance-note', `Saved observation ${short(observation.id)} · ${new Date(observation.time).toLocaleString()}`));
    if (resultDiff) {
      inspector.append(el('p', 'mono source-pin', `Reviewed base commit: ${data.base}`));
      inspector.append(el('p', 'mono source-pin', `${data.status}: ${data.path}`));
      if (data.format === 'text') {
        inspector.append(el('p', 'muted', 'Removed lines start with -. Added lines start with +.'));
        inspector.append(el('pre', 'raw-evidence', data.text));
      } else {
        const reason = data.format === 'binary' ? 'This file cannot be displayed as a UTF-8 text diff.' : 'This file exceeds the text diff display limit.';
        inspector.append(el('p', 'notice warning', reason));
        for (const [label, side] of [['Before', data.before], ['After', data.after]]) {
          if (side) inspector.append(el('p', 'mono source-pin', `${label}: ${side.size} bytes · SHA-256 ${side.sha256}`));
        }
      }
      return;
    }
    if (data.files) {
      inspector.append(el('p', 'mono source-pin', `${data.repository} @ ${data.commit}`), el('p', 'muted', 'Files in the exact retained source commit. Select a file to inspect its contents.'));
      const files = el('div', 'source-files');
      for (const file of data.files) {
        const sourceUrl = new URL(url, location.origin); sourceUrl.searchParams.set('path', file);
        files.append(button(file, 'file-link mono', () => inspect(file, sourceUrl.pathname + sourceUrl.search)));
      }
      inspector.append(files); return;
    }
    if (data.commit) inspector.append(el('p', 'mono source-pin', `${data.repository} @ ${data.commit}`));
    if (data.path) inspector.append(el('p', 'mono source-pin', data.path));
    if (data.integrity) inspector.append(badge(data.integrity, 'positive'), el('p', 'mono muted digest', data.sha256));
    inspector.append(el('pre', 'raw-evidence', data.text ?? JSON.stringify(data.message ?? data, null, 2)));
  } catch (error) {
    if (attempt === state.inspection) inspector.replaceChildren(el('div', 'notice danger', error.message));
  }
}

function sourceButton(repository, commit, text = `Source ${short(commit)}`) {
  const query = new URLSearchParams({ repository, commit });
  return button(text, 'text-button mono', () => inspect('Pinned source tree', `${base()}/source?${query}`));
}
function rawButton(message, text = 'Open original message') {
  return button(text, 'text-button', () => inspect('Original ARP message', `${base()}/messages/${message.message_id}`));
}
function evidenceLinks(content, message, ids) {
  const links = el('div', 'evidence-links');
  for (const id of ids ?? []) {
    const evidence = content.evidence.find(item => item.id === id);
    if (!evidence) { links.append(badge('Evidence reference unavailable', 'warning')); continue; }
    const text = evidence.kind === 'artifact' ? evidence.path.split('/').at(-1) : evidence.kind === 'source' ? `${evidence.path} @ ${short(evidence.commit)}` : id === 'original-message' ? 'Original message' : label(id.replaceAll('-', '_'));
    links.append(button(text, 'evidence-link', () => inspect(text, `${base()}/messages/${message.message_id}/evidence/${id}`)));
  }
  return links;
}
function navigateMessage(messageKey, detail = state.detail, itemId) {
  if (!state.data.messages.some(message => keyOf(message) === messageKey)) return;
  state.changedMessages = state.changedMessages.filter(key => key !== messageKey);
  state.selected = messageKey; state.detail = detail; render(); syncUrl();
  if (itemId) document.getElementById(`item-${itemId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function itemLink(ref) {
  const key = `${ref.message.repository_id}/${ref.message.message_id}`;
  return button(label(ref.item_id.replaceAll('-', '_')), 'evidence-link', () => navigateMessage(key, 'developer', ref.item_id));
}

function messageTitle(message, content) {
  if (content?.title) return content.title;
  const heading = message.body.match(/^#{1,6}\s+(.+)$/m)?.[1];
  if (heading && !['goal', 'acknowledgement'].includes(heading.toLowerCase())) return heading.length > 160 ? heading.slice(0, 157) + '…' : heading;
  if (message.status) { const text = label(message.status); return text[0].toUpperCase() + text.slice(1) + ' update'; }
  return message.kind === 'REQUEST' ? message.supersedes?.length ? 'Replacement implementation request' : 'Implementation request' : message.intent === 'CLARIFICATION_REQUEST' ? 'Clarification request' : 'Information';
}

function renderProtocolDetails(message, data) {
  const section = el('section', 'content-section'); section.append(heading('Protocol relationships', 'References come directly from the validated ARP envelope.'));
  const metadata = el('dl', 'metadata');
  const references = [
    ...(message.parent ? [['Parent', message.parent]] : []),
    ...(message.request ? [['Request', message.request]] : []),
    ...(message.state_basis ?? []).map(reference => ['State basis', reference]),
    ...(message.supersedes ?? []).map(item => ['Replaces', item.request])
  ];
  for (const [name, reference] of references) {
    const target = data.messages.find(item => item.message_id === reference.message_id && item.source_repository === reference.repository_id);
    const value = el('dd');
    value.append(target ? button(`${reference.repository_id} / ${short(reference.message_id)}`, 'text-button mono', () => navigateMessage(keyOf(target))) : el('span', 'muted', `${reference.repository_id} / ${reference.message_id} — context unavailable`));
    metadata.append(el('dt', '', name), value);
  }
  metadata.append(el('dt', '', 'Source commit'), el('dd', 'mono', message.source_commit));
  section.append(metadata); return section;
}

function renderSidebar() {
  const sidebar = el('aside', 'sidebar');
  const brand = el('a', 'brand'); brand.href = demo ? './' : '/'; brand.append(el('span', 'brand-mark', 'a'), el('span', '', 'agent handoff'));
  if (demo) {
    sidebar.append(brand, el('div', 'workspace-label', 'PUBLIC DEMO'));
    const nav = el('nav', 'handoff-nav'); nav.setAttribute('aria-label', 'Replay phases');
    for (const phase of state.data?.phases ?? []) {
      const active = phase.phase === state.phase;
      const control = button(phase.label, `handoff-button ${active ? 'active' : ''}`, () => load(defaultRun, phase.phase));
      control.setAttribute('aria-current', active ? 'step' : 'false'); nav.append(control);
    }
    const footer = el('div', 'sidebar-footer'); footer.append(el('strong', '', 'Read-only replay'), el('p', '', 'Synthetic messages and source for this demo.'));
    sidebar.append(nav, footer); return sidebar;
  }
  sidebar.append(brand, el('div', 'workspace-label', 'DEVELOPMENT WORKSPACE'), el('p', 'nav-heading', 'Selected repositories'));
  const live = button('', `handoff-button live-nav ${state.view.startsWith('live') ? 'active' : ''}`, () => loadLiveList());
  live.append(el('span', 'handoff-icon', 'T'), el('span', 'handoff-name', 'Tasks'));
  live.setAttribute('aria-current', state.view.startsWith('live') ? 'page' : 'false');
  sidebar.append(live, el('p', 'nav-heading recorded-heading', 'Recorded examples'));
  const nav = el('nav', 'handoff-nav'); nav.setAttribute('aria-label', 'Recorded handoffs');
  for (const run of state.runs) {
    const active = state.view === 'handoff' && run.key === state.run;
    const node = button('', `handoff-button ${active ? 'active' : ''}`, () => { refreshLoop.stop(); state.autoRefresh = false; state.liveAttempt++; state.liveBusy = false; state.view = 'handoff'; load(run.key); });
    node.setAttribute('aria-current', active ? 'page' : 'false');
    node.append(el('span', 'handoff-icon', run.key === 'priority' ? 'P' : 'D'), el('span', 'handoff-name', run.title));
    nav.append(node);
  }
  const setup = button('', `handoff-button repository-nav ${state.view === 'repositories' ? 'active' : ''}`, () => { refreshLoop.stop(); state.autoRefresh = false; closeInspector(); state.load++; state.liveAttempt++; state.liveBusy = false; state.view = 'repositories'; render(); syncUrl(); });
  setup.append(el('span', 'handoff-icon', 'R'), el('span', 'handoff-name', 'Repositories'));
  setup.setAttribute('aria-current', state.view === 'repositories' ? 'page' : 'false');
  nav.append(setup);
  const footer = el('div', 'sidebar-footer'); footer.append(el('span', 'live-dot'), el('strong', '', 'Handoff workspace'), el('p', '', 'Read publications and review human decisions.'));
  sidebar.append(nav, footer); return sidebar;
}

function renderHeader(data) {
  const header = el('header', 'page-header');
  const crumbs = el('div', 'breadcrumbs'); crumbs.append(el('span', '', 'Workspace'), el('span', '', '/'), el('strong', '', 'Handoff review'));
  const top = el('div', 'topbar'); top.append(crumbs, badge(data.mode === 'live' ? 'HUMAN DECISIONS' : 'READ ONLY', 'neutral'));
  const title = el('div', 'title-row');
  const left = el('div'); left.append(el('p', 'eyebrow', 'AGENTS + THEIR OPERATORS'), el('h1', '', data.title), el('p', 'subtitle', data.subtitle));
  const right = el('div', 'run-meta'); right.append(el('span', '', data.mode === 'live' ? 'Selected repository pair' : state.runs.find(run => run.key === state.run).date), el('span', 'mono', data.thread_id));
  title.append(left, right); header.append(top, title);
  const controls = el('div', 'controls');
  const phaseLabel = el('div', 'phase-label');
  if (data.mode === 'live') {
    phaseLabel.append(el('span', '', `Observed ${new Date(data.observed_at).toLocaleString()} · Last checked ${new Date(data.last_checked_at ?? data.observed_at).toLocaleTimeString()}`));
    const actions = el('div', 'live-actions');
    const refresh = button(state.refreshBusy ? 'Refreshing…' : 'Refresh handoff', 'secondary-button', () => refreshLiveHandoff()); refresh.disabled = state.refreshBusy || !state.settings.configured;
    actions.append(button('← Tasks', 'text-button', () => loadLiveList()), refresh); phaseLabel.append(actions);
  } else {
    phaseLabel.append(el('label', '', 'Replay phase'));
    const select = el('select'); select.setAttribute('aria-label', 'Replay phase');
    for (const phase of data.phases) { const option = el('option', '', phase.label); option.value = String(phase.phase); option.selected = phase.phase === state.phase; select.append(option); }
    select.addEventListener('change', () => load(state.run, Number(select.value))); phaseLabel.append(select);
  }
  const tabs = el('div', 'detail-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Detail level');
  for (const detail of ['overview', 'developer', 'evidence']) {
    const tab = button(detail[0].toUpperCase() + detail.slice(1), state.detail === detail ? 'selected' : '', () => { state.detail = detail; render(); syncUrl(); });
    tab.id = `tab-${detail}`; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(state.detail === detail)); tab.setAttribute('aria-controls', 'message-panel');
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const options = ['overview', 'developer', 'evidence']; const delta = event.key === 'ArrowLeft' ? -1 : 1;
      state.detail = event.key === 'Home' ? options[0] : event.key === 'End' ? options[2] : options[(options.indexOf(detail) + delta + 3) % 3];
      render(); syncUrl(); document.querySelector(`#tab-${state.detail}`).focus();
    });
    tabs.append(tab);
  }
  controls.append(phaseLabel, tabs); header.append(controls);
  if (data.mode === 'live') header.append(renderObservationControls(data));
  return header;
}

function renderContext(data) {
  const context = el('section', 'context-strip');
  const lifecycle = el('div', 'lifecycle');
  if (!data.requests.length) {
    lifecycle.append(badge(!data.complete ? 'INCOMPLETE' : data.messages.length ? 'INFORMATION EXCHANGE' : 'NO PUBLICATION', !data.complete ? 'warning' : 'neutral'), el('span', 'muted', !data.complete ? 'No complete request state is available.' : data.messages.length ? 'This thread contains no lifecycle request.' : 'No published messages were observed.'));
  }
  for (const request of data.requests) {
    const item = el('div', 'lifecycle-item');
    const message = data.messages.find(message => message.message_id === request.request.message_id);
    const name = request.replacement ? 'Original request' : data.requests.length > 1 ? 'Replacement request' : 'Request';
    item.append(el('span', 'muted', name), badge(request.status, ['BLOCKED', 'INCOMPLETE', 'CONFLICTED'].includes(request.status) ? 'warning' : request.status === 'SUPERSEDED' ? 'neutral' : 'positive'));
    if (message) item.append(button(short(message.message_id), 'text-button mono muted', () => navigateMessage(keyOf(message))));
    lifecycle.append(item);
  }
  const provenance = el('div', 'history-note'); provenance.append(badge(data.mode === 'live' ? 'PINNED REMOTE OBSERVATION' : 'HISTORICAL SNAPSHOT', 'neutral'), el('span', '', data.complete ? 'Protocol context complete' : 'Protocol context incomplete'));
  context.append(lifecycle, provenance); return context;
}

function renderAttention(data) {
  const section = el('section', 'attention'); section.setAttribute('aria-label', 'Attention and verification limits');
  const statuses = data.requests.map(request => request.status);
  const checks = [...data.messages].reverse().find(message => message.status === 'RESOLVED')?.verification ?? [];
  const line = el('div', 'attention-heading');
  line.append(el('strong', '', statuses.includes('BLOCKED') ? 'Waiting for a decision or a replacement contract' : 'Evidence & coverage notes'));
  if (checks.length) line.append(badge(`${checks.filter(check => check.outcome === 'PASS').length} reported PASS · ${checks.filter(check => check.outcome === 'NOT_RUN').length} NOT RUN`, 'neutral'));
  section.append(line);
  const allClosed = statuses.every(status => ['CLOSED', 'SUPERSEDED'].includes(status));
  const recorded = demo ? 'The answer is recorded. The request stays BLOCKED until implementation resumes.' : 'The human answer is recorded. The original request is still BLOCKED; this snapshot has no published replacement yet.';
  section.append(el('p', 'next-action', !data.complete ? 'This observation is incomplete. Do not treat the observed state as the complete handoff.' : statuses.includes('CONFLICTED') ? 'Concurrent lifecycle effects need explicit reconciliation.' : allClosed && statuses.length ? 'No workflow action pending for these closed requests. Coverage notes remain available below.' : statuses.includes('BLOCKED') && data.decisions.length ? recorded : statuses.includes('BLOCKED') ? data.mode === 'live' ? 'The published request is BLOCKED. Read its reason and linked messages.' : 'Human input is needed before the affected work can proceed.' : 'Review the published work and its evidence before taking the next action.'));
  if (data.attention.length) {
    const list = el('ul', 'attention-list');
    for (const item of data.attention) {
      const entry = el('li');
      if (['NOT_RUN', 'FAIL', 'decision_conflict', 'context'].includes(item.type)) entry.className = 'emphasis';
      entry.append(el('span', '', item.text));
      if (item.messageKey) entry.append(button('View record', 'inline-link', () => navigateMessage(item.messageKey)));
      list.append(entry);
    }
    section.append(list);
  }
  return section;
}

function renderDecisionContext(data) {
  const section = el('section', 'decision-context');
  for (const decision of data.decisions) {
    const row = el('div', 'decision-context-row');
    row.append(badge('RECORDED DECISION', 'accent'), el('span', '', decision.answer), el('small', 'muted', `${decision.actor.label} · ${label(decision.record.attribution)}`), button('View answer', 'text-button', () => navigateMessage(decision.messageKey)));
    section.append(row);
  }
  return section;
}

function renderQuestions(content, message, data) {
  const section = el('section', 'content-section'); section.append(heading('Questions & decisions'));
  for (const question of content.questions ?? []) {
    const item = el('article', 'question'); item.id = `item-${question.id}`;
    const answers = data.decisions.filter(decision => `${decision.question.message.repository_id}/${decision.question.message.message_id}` === keyOf(message) && decision.question.item_id === question.id);
    item.append(badge(answers.length ? 'ANSWER RECORDED' : question.blocking ? 'HUMAN DECISION NEEDED' : 'OPEN QUESTION', answers.length ? 'positive' : 'warning'), el('h3', '', question.prompt));
    if (state.detail !== 'overview') {
      for (const option of question.options ?? []) { const choice = el('div', 'option'); choice.append(el('strong', '', option.label), el('p', '', option.consequence)); item.append(choice); }
      item.append(el('p', 'muted', `Affects: ${question.affects.join(' · ')}`), evidenceLinks(content, message, question.evidence_ids));
    }
    for (const answer of answers) item.append(button(`Recorded answer: ${answer.answer}`, 'answer-link', () => navigateMessage(answer.messageKey)));
    section.append(item);
  }
  for (const decision of content.decisions ?? []) {
    const item = el('article', 'decision'); item.id = `item-${decision.id}`;
    item.append(badge('HUMAN PRODUCT DECISION', 'accent'), el('blockquote', '', decision.record.quote ?? decision.answer), el('p', '', decision.answer));
    item.append(el('p', 'attribution', `${decision.actor.label} · ${label(decision.record.attribution)} · ${decision.record.date ?? 'Date not recorded'}`));
    if (state.detail !== 'overview') item.append(itemLink(decision.question), evidenceLinks(content, message, decision.evidence_ids));
    section.append(item);
  }
  return section;
}

function renderVerification(message, content) {
  const section = el('section', 'content-section'); section.append(heading('Reported verification', 'Outcomes come from the original protocol message.'));
  for (const [index, check] of message.verification.entries()) {
    const item = el('article', 'check-row');
    const top = el('div', 'check-title'); top.append(badge(check.outcome, check.outcome === 'PASS' ? 'positive' : 'warning'), el('strong', '', check.check)); item.append(top, el('p', '', check.evidence));
    if (state.detail !== 'overview' && content) {
      const detail = content.verification_details?.find(detail => detail.verification_index === index);
      if (detail) {
        const refs = el('div', 'evidence-links'); for (const ref of detail.requirement_refs) refs.append(itemLink(ref)); item.append(refs);
        for (const subject of detail.subjects) item.append(sourceButton(subject.repository_id, subject.commit, `${subject.repository_id} @ ${short(subject.commit)}`));
        item.append(evidenceLinks(content, message, detail.evidence_ids));
      }
    }
    section.append(item);
  }
  return section;
}

function renderDeveloper(content, message) {
  const fragment = document.createDocumentFragment();
  for (const [name, title] of [['requirements', 'Acceptance criteria'], ['contracts', 'Pinned contract']]) {
    if (!content[name]?.length) continue;
    const section = el('section', 'content-section'); section.append(heading(title));
    for (const item of content[name]) {
      const row = el('article', 'spec-item'); row.id = `item-${item.id}`;
      const line = el('div', 'spec-label'); line.append(el('span', 'mono muted', item.id));
      if (item.basis) line.append(badge(item.basis.toUpperCase(), item.basis === 'observed' ? 'neutral' : 'warning'));
      row.append(line, el('p', '', item.text), evidenceLinks(content, message, item.evidence_ids)); section.append(row);
    }
    fragment.append(section);
  }
  if (content.non_goals?.length) { const section = el('section', 'content-section'); section.append(heading('Outside this handoff')); const list = el('ul', 'plain-list'); for (const text of content.non_goals) list.append(el('li', '', text)); section.append(list); fragment.append(section); }
  return fragment;
}

function renderEvidence(content, message, data) {
  const section = el('section', 'content-section'); section.append(heading('Evidence & provenance', demo ? 'Open the synthetic ARP messages and bundled source.' : data.mode === 'live' ? 'Exact ARP messages and immutable source pins.' : 'Exact records and immutable source pins, with local artifacts verified on read.'));
  const metadata = el('dl', 'metadata');
  for (const [term, value] of [['Message', message.message_id], ['From', message.source_repository], ['To', message.target_repository], ['Created', message.created_at], ['Source commit', message.source_commit]]) metadata.append(el('dt', '', term), el('dd', 'mono', value));
  section.append(metadata, rawButton(message), sourceButton(message.source_repository, message.source_commit, 'Browse pinned source'));
  if (content) {
    section.append(el('p', 'provenance-note', `${demo ? 'Demo projection' : 'Retrospective projection'} · ${content.provenance.method}`));
    for (const evidence of content.evidence) {
      const row = el('div', 'evidence-row'); row.append(badge(evidence.kind.toUpperCase(), 'neutral'), evidenceLinks(content, message, [evidence.id]));
      if (evidence.kind === 'artifact') row.append(el('small', 'muted', 'Local workspace artifact · digest checked before display'));
      if (evidence.kind === 'message') row.append(el('small', 'muted', 'Message opened within this phase; fixture container pins refer to a later retrospective archive.'));
      section.append(row);
    }
  }
  section.append(heading('Observed publication heads', data.mode === 'live' ? 'These heads were pinned during the remote read. Re-reading creates a new observation.' : 'These heads belong to the selected historical snapshot.'));
  for (const publication of data.publications) { const row = el('div', 'publication'); row.append(el('strong', '', publication.repository_id), el('code', '', publication.publication ?? 'No published pointer observed in this stream')); section.append(row); }
  section.append(button('Open exact snapshot JSON', 'text-button', () => inspect('Selected historical snapshot', `${base()}/snapshot`)));
  return section;
}

function renderMessage(data) {
  if (!data.messages.length) { const empty = el('article', 'message-panel'); empty.append(heading('No validated messages in this observation'), el('p', 'muted', data.complete ? 'No publication was found for this handoff ID in the selected streams.' : 'The remote read did not provide enough valid data. Review the read errors above.')); return empty; }
  const message = data.messages.find(message => keyOf(message) === state.selected) ?? data.messages.at(-1);
  const projection = data.projections[keyOf(message)], content = projection?.valid ? projection.content : null;
  const article = el('article', 'message-panel'); article.id = 'message-panel'; article.setAttribute('role', 'tabpanel'); article.setAttribute('aria-labelledby', `tab-${state.detail}`);
  const meta = el('div', 'message-meta'); meta.append(badge(message.kind === 'STATUS_EVENT' ? message.status : message.intent === 'CLARIFICATION_REQUEST' ? 'CLARIFICATION' : message.kind, 'neutral'), el('span', '', `${message.source_repository} → ${message.target_repository}`));
  const title = messageTitle(message, content);
  article.append(meta, el('h2', 'message-title', title));
  if (content) article.append(el('p', 'message-summary', content.summary));
  else article.append(el('p', 'muted', projection ? 'Structured content unavailable. The original message remains readable below.' : 'Original protocol record · no retrospective content projection for this message.'), el('pre', 'original-body', message.body));
  if (message.reason) article.append(el('p', 'reason', message.reason));
  const actions = el('div', 'message-actions'); actions.append(rawButton(message), sourceButton(message.source_repository, message.source_commit)); article.append(actions);
  if (data.mode === 'live' && message.kind === 'REQUEST' && message.intent !== 'CLARIFICATION_REQUEST') article.append(renderDispatch(data, message));
  if (data.mode === 'live' && message.kind === 'INFORMATION' && message.intent === 'CLARIFICATION_REQUEST') {
    const decision = renderLiveDecision(data, message);
    const recordAction = button('Record human decision', 'text-button', () => decision.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    recordAction.disabled = !state.followLatest || Boolean(state.refreshError) || !clarificationContext(data, message).eligible;
    actions.append(recordAction);
    article.append(decision);
  }
  for (const limitation of content?.limitations ?? []) {
    if (data.attention.some(item => item.text === limitation.text)) continue;
    article.append(el('div', 'notice warning', limitation.text));
  }
  if (content?.outcome) { const outcome = el('div', 'outcome'); outcome.append(el('p', 'eyebrow', 'INTENDED OUTCOME'), el('p', '', content.outcome)); article.append(outcome); }
  if (content?.questions?.length || content?.decisions?.length) article.append(renderQuestions(content, message, data));
  if (message.verification?.length) article.append(renderVerification(message, content));
  if (content && state.detail !== 'overview') article.append(renderDeveloper(content, message));
  if (!content && state.detail !== 'overview') article.append(renderProtocolDetails(message, data));
  if (state.detail === 'evidence') article.append(renderEvidence(content, message, data));
  if (state.detail === 'overview' && content?.requirements?.length) {
    const requirements = el('section', 'content-section'); requirements.append(heading('Scope at a glance'));
    const list = el('ul', 'plain-list'); for (const item of content.requirements) list.append(el('li', '', item.text));
    requirements.append(list, button('Inspect requirements & contract →', 'text-button', () => { state.detail = 'developer'; render(); syncUrl(); })); article.append(requirements);
  }
  return article;
}

function renderTimeline(data) {
  const section = el('aside', 'timeline'); section.setAttribute('aria-label', 'Handoff timeline');
  section.append(heading(data.mode === 'live' ? 'Published messages' : 'The conversation', `${data.messages.length} messages in this snapshot`));
  for (const [index, message] of data.messages.entries()) {
    const selected = keyOf(message) === state.selected;
    const node = button('', `timeline-message ${selected ? 'selected' : ''}`, () => navigateMessage(keyOf(message)));
    node.setAttribute('aria-pressed', String(selected));
    const content = data.projections[keyOf(message)]?.content;
    const title = messageTitle(message, content);
    node.append(el('span', 'timeline-index', String(index + 1)), el('strong', '', title), el('span', 'timeline-role', message.source_repository.replace('taskboard-', '')), el('span', 'timeline-type', message.status ?? (message.intent === 'CLARIFICATION_REQUEST' ? 'QUESTION' : message.kind)));
    if (data.mode === 'live' && state.followLatest && state.changedMessages.includes(keyOf(message))) node.append(badge('NEW', 'accent timeline-new'));
    section.append(node);
  }
  section.append(el('p', 'timeline-caption', data.mode === 'live' ? 'Ordered by message dependencies. Incomparable events have no claimed chronological order.' : 'Ordered by dependencies and recorded snapshot visibility. Timestamps do not determine lifecycle state.'));
  return section;
}

function renderRepositoryResult(validation) {
  const section = el('section', 'repository-results'); section.setAttribute('aria-live', 'polite');
  section.append(heading(validation.valid ? 'Local checks passed' : 'Review repository selection', 'Validation reads Git and existing ARP configuration. Remote connectivity is not checked.'));
  for (const message of validation.errors) section.append(el('p', 'notice danger', message));
  for (const slot of ['backend', 'frontend']) {
    const repository = validation.repositories[slot], card = el('article', 'repository-result');
    const top = el('div', 'repository-result-heading'); top.append(el('h3', '', `${slot[0].toUpperCase() + slot.slice(1)} repository`), badge(repository.valid ? 'VALID CHECKOUT' : 'NEEDS ATTENTION', repository.valid ? 'positive' : 'warning')); card.append(top);
    card.append(el('p', 'mono repository-path', repository.path));
    if (!repository.valid) for (const error of repository.errors) card.append(el('p', 'notice danger', error));
    else {
      const metadata = el('dl', 'metadata');
      for (const [name, value] of [['ARP identity', repository.repository_id], ['ARP role', repository.role], ['Branch', repository.branch ?? 'Detached HEAD'], ['Source HEAD', short(repository.head)], ['Publication remote', repository.publication_remote], ['Peer read route', repository.read_route?.remote ? `${repository.read_route.alias} → ${repository.read_route.remote}` : 'Not configured']]) metadata.append(el('dt', '', name), el('dd', 'mono', value));
      card.append(metadata);
      for (const warning of repository.warnings) card.append(el('p', 'notice warning', warning));
    }
    section.append(card);
  }
  return section;
}

async function checkRepositories(save) {
  if (state.repoBusy) return;
  state.repoBusy = true; state.repoNotice = null; render();
  try {
    const result = await request(save ? '/api/repositories' : '/api/repositories/validate', {
      method: save ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Viewer-Token': state.settings.token },
      body: JSON.stringify(save ? { repositories: state.repoDraft, expected_revision: state.settings.revision } : state.repoDraft)
    });
    state.repoValidation = result.validation ?? result;
    if (save) {
      state.settings = { ...state.settings, ...result };
      refreshLoop.stop(); state.autoRefresh = false;
      state.liveList = null;
      state.repoDirty = false;
      state.repoDraft = Object.fromEntries(['backend', 'frontend'].map(slot => [slot, result.selection[slot].path]));
      state.repoNotice = { text: 'Repository pair saved. The selected folders will be remembered after restarting the viewer.', tone: 'positive' };
    }
  } catch (error) {
    if (error.data?.validation) state.repoValidation = error.data.validation;
    state.repoNotice = { text: error.message, tone: 'danger' };
  } finally { state.repoBusy = false; render(); }
}

function renderRepositorySetup() {
  const main = el('main', 'main repository-page');
  const top = el('div', 'topbar'); top.append(el('div', 'breadcrumbs', 'Workspace / Repository configuration'), badge('LOCAL SETTINGS', 'neutral'));
  const title = el('div', 'title-row'); const intro = el('div'); intro.append(el('p', 'eyebrow', 'WORKSPACE SETUP'), el('h1', '', 'Repositories'), el('p', 'subtitle', 'Select the backend and frontend checkouts for this workspace.')); title.append(intro);
  main.append(top, title);
  const status = el('div', 'repository-status');
  status.append(badge(state.repoDirty ? 'UNSAVED CHANGES' : state.settings?.configured ? 'PAIR SAVED' : 'SETUP NEEDED', state.settings?.configured && !state.repoDirty ? 'positive' : 'warning'), el('span', '', state.repoDirty ? 'Check and save the new folders to update the workspace selection.' : state.settings?.configured ? 'Two local repositories selected. Source browsing uses their ARP identities.' : 'Choose two local folders that already have ARP configuration.'));
  main.append(status);
  if (state.settings?.error) main.append(el('p', 'notice danger', state.settings.error));
  if (state.repoNotice) { const notice = el('p', `notice ${state.repoNotice.tone}`, state.repoNotice.text); notice.id = 'repository-notice'; main.append(notice); }
  const form = el('form', 'repository-form'); form.addEventListener('submit', event => { event.preventDefault(); checkRepositories(false); });
  const results = el('div', 'repository-validation');
  const actions = el('div', 'repository-actions');
  const check = button(state.repoBusy ? 'Checking repositories…' : 'Check repositories', 'primary-button', () => checkRepositories(false));
  const save = button('Save repository pair', 'secondary-button', () => checkRepositories(true));
  check.disabled = state.repoBusy || !!state.settings?.error; save.disabled = state.repoBusy || !state.repoValidation?.valid || !!state.settings?.error;
  for (const slot of ['backend', 'frontend']) {
    const field = el('label', 'repository-field'); field.append(el('span', 'repository-field-name', `${slot[0].toUpperCase() + slot.slice(1)} repository folder`));
    const input = el('input', 'repository-input mono'); input.type = 'text'; input.name = slot; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'Paste the absolute path to the local checkout'; input.value = state.repoDraft[slot]; input.disabled = state.repoBusy;
    input.addEventListener('input', () => {
      state.repoDraft[slot] = input.value; state.repoValidation = null; state.repoNotice = null; state.repoDirty = true; save.disabled = true; results.replaceChildren();
      document.querySelector('#repository-notice')?.remove();
      status.replaceChildren(badge('UNSAVED CHANGES', 'warning'), el('span', '', 'Check and save the new folders to update the workspace selection.'));
    });
    field.append(input); form.append(field);
  }
  if (state.settings?.suggestions.length) {
    const shortcuts = el('div', 'repository-shortcuts'); shortcuts.append(el('span', 'muted', 'Existing test checkouts'));
    for (const suggestion of state.settings.suggestions) {
      const shortcut = button(suggestion.label, 'evidence-link', () => { state.repoDraft = { backend: suggestion.backend, frontend: suggestion.frontend }; state.repoValidation = null; state.repoNotice = null; state.repoDirty = true; render(); });
      shortcut.disabled = state.repoBusy; shortcuts.append(shortcut);
    }
    form.append(shortcuts);
  }
  actions.append(check, save); form.append(actions, el('p', 'repository-help', 'Only the viewer’s folder selection is saved. Repository files and Git remotes stay under ARP’s existing setup workflow.'));
  if (state.repoValidation) results.append(renderRepositoryResult(state.repoValidation));
  main.append(form, results, el('p', 'repository-help', 'Open Live handoffs to discover published threads from this selected pair.'));
  return main;
}

function render() {
  app.removeAttribute('aria-busy');
  if (state.view === 'repositories') {
    const shell = el('div', 'shell'); shell.append(renderSidebar(), renderRepositorySetup()); app.replaceChildren(shell); return;
  }
  if (state.view === 'live' || state.view === 'live-handoff' && (state.liveBusy || state.liveError || !state.data)) {
    const shell = el('div', 'shell'); shell.append(renderSidebar(), renderLiveList()); app.replaceChildren(shell); return;
  }
  const data = state.data; if (!data) return;
  const shell = el('div', 'shell'), main = el('main', 'main');
  main.append(renderHeader(data));
  if (data.mode === 'live') main.append(renderRefreshStatus(data));
  if (state.dispatchRestoreError && data.mode === 'live') main.append(el('p', 'notice warning', state.dispatchRestoreError));
  main.append(renderContext(data), renderAttention(data));
  if (data.decisions.length) main.append(renderDecisionContext(data));
  const body = el('div', 'review-layout'); body.append(renderMessage(data), renderTimeline(data));
  main.append(body, el('footer', 'page-footer', demo ? 'Agent Relay Protocol · Synthetic handoff replay' : data.mode === 'live' ? 'Agent Relay Protocol · Remote messages validated by ARP · Original v2 prose · Pinned observation; re-read to update' : 'Agent Relay Protocol · Real recorded handoffs · Structured wording added retrospectively · Local read-only viewer'));
  shell.append(renderSidebar(), main); app.replaceChildren(shell);
}

function renderObservationControls(data) {
  const controls = el('div', 'observation-controls');
  const field = el('label', 'observation-select'); field.append(el('span', '', 'Observation history'));
  const select = el('select'); select.setAttribute('aria-label', 'Observation history'); select.disabled = state.historyBusy;
  const latest = el('option', '', 'Follow latest read'); latest.value = 'latest'; latest.selected = state.followLatest; select.append(latest);
  for (const entry of [...data.history.entries].reverse()) {
    const states = !entry.complete ? 'INCOMPLETE' : entry.requests.map(request => request.status).join(' / ') || 'Information';
    const option = el('option', '', `${new Date(entry.observed_at).toLocaleString()} · ${states} · ${entry.message_count} message${entry.message_count === 1 ? '' : 's'}`);
    option.value = entry.snapshot_id; option.selected = !state.followLatest && entry.snapshot_id === data.snapshot_id; select.append(option);
  }
  select.addEventListener('change', () => selectObservation(select.value)); field.append(select);
  const auto = el('label', 'auto-refresh'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.autoRefresh; checkbox.disabled = !state.settings.configured;
  checkbox.addEventListener('change', () => { state.autoRefresh = checkbox.checked; refreshLoop.start(); render(); });
  auto.append(checkbox, el('span', '', 'Auto-refresh every 30 s'));
  controls.append(field, auto, el('span', 'observation-count', `${data.history.entries.length} saved observation${data.history.entries.length === 1 ? '' : 's'}`));
  return controls;
}

function renderRefreshStatus(data) {
  const fragment = document.createDocumentFragment();
  if (state.historyBusy) fragment.append(el('p', 'notice neutral', 'Opening saved observation…'));
  if (state.refreshBusy) { const notice = el('p', 'notice neutral', 'Checking for new messages and state changes…'); notice.setAttribute('role', 'status'); fragment.append(notice); }
  const error = state.refreshError ?? data.latest_read_error?.message;
  if (error) { const notice = el('p', 'notice danger', `Refresh failed: ${error} Showing the saved observation from ${new Date(data.observed_at).toLocaleString()}.`); notice.setAttribute('role', 'alert'); fragment.append(notice); }
  if (!state.followLatest) {
    const notice = el('div', 'notice historical-notice');
    notice.append(el('strong', '', data.historical ? 'Historical view · preserved' : 'Pinned view · preserved'), el('p', '', 'Refresh can find newer observations without changing the messages and state shown here.'));
    if (data.history.latest_snapshot_id !== data.snapshot_id) {
      notice.append(el('p', 'new-observation', data.history.entries.at(-1).complete ? 'A newer observation is available.' : 'A newer observation is incomplete. Your saved view remains unchanged.'), button('View latest observation', 'secondary-button', () => selectObservation('latest')));
    } else notice.append(button('Follow latest read', 'text-button', () => selectObservation('latest')));
    fragment.append(notice);
  }
  if (state.refreshSummary?.length) {
    const summary = el('p', 'notice refresh-summary', `Latest check: ${state.refreshSummary.join(' · ')}`); summary.setAttribute('role', 'status'); fragment.append(summary);
  }
  return fragment;
}

async function refreshLiveHandoff() {
  if (state.refreshBusy || state.view !== 'live-handoff' || !state.data || !state.settings.configured) return;
  const attempt = state.liveAttempt, task = state.liveTask;
  state.refreshBusy = true; state.refreshError = null; state.refreshSummary = null; render();
  try {
    const incoming = await request(`/api/live/tasks/${encodeURIComponent(task)}`);
    if (attempt !== state.liveAttempt) return;
    state.data = mergeObservation(state.data, incoming, state.followLatest);
    state.refreshSummary = incoming.refresh.changed ? describeChanges(incoming.refresh) : ['No new messages or state changes.'];
    state.changedMessages = [...new Set([...state.changedMessages, ...incoming.refresh.added_messages])];
    if (!state.data.messages.some(message => keyOf(message) === state.selected)) state.selected = state.data.defaultMessage;
  } catch (error) {
    if (attempt !== state.liveAttempt) return;
    state.refreshError = error.message;
    try {
      const preserved = await request(`/api/live/snapshots/${state.data.snapshot_id}`);
      if (attempt === state.liveAttempt) state.data = mergeObservation(state.data, preserved, false);
    } catch { /* The current in-browser observation remains visible with the error. */ }
  } finally {
    if (attempt === state.liveAttempt) { state.refreshBusy = false; render(); syncUrl(); }
  }
}

async function selectObservation(id) {
  const attempt = ++state.historyAttempt, navigation = state.liveAttempt, task = state.liveTask;
  state.followLatest = id === 'latest'; state.historyBusy = true; state.refreshSummary = null; closeInspector(); render();
  try {
    const selected = await request(id === 'latest' ? `/api/live/history/${encodeURIComponent(task)}/latest` : `/api/live/snapshots/${encodeURIComponent(id)}`);
    if (attempt !== state.historyAttempt || navigation !== state.liveAttempt || state.view !== 'live-handoff') return;
    if (selected.thread_id !== task) throw new Error('The saved observation belongs to a different handoff.');
    if (!(state.followLatest && (state.data.history.sequence > selected.history.sequence))) state.data = mergeObservation(selected, state.data, false);
    state.refreshError = null;
    if (!state.data.messages.some(message => keyOf(message) === state.selected)) state.selected = state.data.defaultMessage;
  } catch (error) { if (attempt === state.historyAttempt && navigation === state.liveAttempt) state.refreshError = error.message; }
  finally { if (attempt === state.historyAttempt && navigation === state.liveAttempt) { state.historyBusy = false; render(); syncUrl(); } }
}

const taskGroups = {
  all: 'All tasks', attention: 'Needs attention', review: 'Ready for review',
  active: 'Agent active', blocked: 'Blocked or unavailable', ready: 'Open tasks', finished: 'Published outcomes'
};
const groupPriority = Object.keys(taskGroups).slice(1);

function focusHeading() {
  const heading = app.querySelector('main h1');
  if (heading) { heading.tabIndex = -1; heading.focus(); }
}

function taskLink(task, caption, { message, dispatch, snapshot } = {}) {
  const link = el('a', 'secondary-button task-link', caption);
  const query = new URLSearchParams({ view: 'live', task: task.thread_id, detail: 'overview' });
  if (message) query.set('message', message);
  if (dispatch) query.set('dispatch', dispatch);
  if (snapshot) query.set('snapshot', snapshot);
  link.href = `/?${query}`;
  link.setAttribute('aria-label', `${caption} for ${task.thread_id}`);
  link.addEventListener('click', event => {
    if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    state.detail = 'overview';
    openLiveTask(task.thread_id, snapshot, { message, dispatch, focus: true });
  });
  return link;
}

function renderLiveList() {
  const main = el('main', 'main live-page');
  const top = el('div', 'topbar'); top.append(el('div', 'breadcrumbs', 'Workspace / Tasks'));
  const title = el('div', 'title-row'); const intro = el('div'); intro.append(el('h1', '', state.view === 'live-handoff' ? state.liveTask : 'Tasks'), el('p', 'subtitle', state.view === 'live-handoff' ? 'Reading the published conversation.' : 'See what needs attention across the selected repositories.')); title.append(intro);
  main.append(top, title);
  if (!state.settings?.configured) {
    main.append(el('p', 'notice warning', 'Select and validate the backend and frontend folders before reading live handoffs.'), button('Configure repositories', 'primary-button', () => { state.view = 'repositories'; render(); syncUrl(); })); return main;
  }
  const pair = el('div', 'live-pair');
  for (const [slot, repository] of Object.entries(state.settings.selection)) pair.append(badge(slot.toUpperCase(), 'neutral'), el('span', 'mono', repository.repository_id));
  main.append(pair);
  if (state.liveBusy) {
    const loading = el('div', 'live-loading'); loading.setAttribute('role', 'status');
    const loadingText = state.view === 'live-handoff' ? 'Reading published history…' : state.taskScan === 'checking' ? 'Checking unread and changed tasks…' : 'Discovering publication refs…';
    loading.append(el('strong', '', loadingText), el('p', 'muted', 'Git is contacting the configured remotes.'));
    main.append(loading);
    if (state.view !== 'live' || !state.liveList) return main;
  }
  if (state.liveError) {
    const error = el('div', 'notice danger', state.liveError);
    error.setAttribute('role', 'alert');
    main.append(error);
  }
  const actions = el('div', 'live-actions');
  const reload = button(state.view === 'live-handoff' ? 'Retry handoff read' : 'Refresh tasks', 'primary-button', () => state.view === 'live-handoff' ? openLiveTask(state.liveTask, null, { message: state.selected, focus: true }) : loadLiveList());
  reload.disabled = state.liveBusy;
  actions.append(reload);
  if (state.view === 'live-handoff') actions.append(button('Back to tasks', 'text-button', () => loadLiveList()));
  if (state.view === 'live' && state.liveList?.complete && state.liveList.tasks.some(task => ['unread', 'stale'].includes(task.context))) {
    const scan = button('Check unread and changed tasks', 'secondary-button', () => loadLiveList({ scan: true }));
    scan.disabled = state.liveBusy || Boolean(state.liveError);
    actions.append(scan);
  }
  main.append(actions);
  if (state.view === 'live' && state.taskScan && state.taskScan !== 'checking') {
    const status = el('p', 'notice neutral', state.taskScan);
    status.setAttribute('role', 'status');
    main.append(status);
  }
  const list = state.view === 'live' ? state.liveList : null;
  if (list) {
    const meta = el('div', 'live-observation'); meta.append(badge(list.complete ? 'DISCOVERY COMPLETE' : 'DISCOVERY INCOMPLETE', list.complete ? 'positive' : 'warning'), el('span', '', `Read at ${new Date(list.observed_at).toLocaleString()}`)); main.append(meta);
    for (const error of list.errors) main.append(el('p', 'notice warning', `${error.repository_id}: ${error.code} — ${error.message}`));
    if (list.local_activity_incomplete) main.append(el('p', 'notice warning', 'Some local dispatch records could not be listed. Open the conversation or restore a known run directly.'));
    if (state.liveError) main.append(el('p', 'notice warning', 'Showing the previous task list. Open a conversation to retry its read or inspect its saved observation.'));
    else if (!list.complete) main.append(el('p', 'notice warning', 'Some repositories could not be read. Check remote access, then refresh.'));
    if (list.tasks.length) {
      const filter = el('label', 'task-filter', 'Show tasks');
      const select = el('select', 'repository-input'); select.id = 'task-filter';
      for (const [value, caption] of Object.entries(taskGroups)) {
        const option = el('option', '', caption); option.value = value; option.selected = state.taskFilter === value; select.append(option);
      }
      select.addEventListener('change', () => { state.taskFilter = select.value; render(); document.querySelector('#task-filter')?.focus(); });
      filter.append(select); main.append(filter);
      const tasks = el('section', 'live-tasks'); tasks.setAttribute('aria-label', 'Published tasks');
      const candidates = list.tasks.map(task => ({
        ...task,
        actions: state.liveError ? [{ group: 'attention', label: 'Refresh conversation', description: 'The last discovery attempt failed.' }] : task.actions
      }));
      const visible = candidates.filter(task => state.taskFilter === 'all' || task.actions.some(action => action.group === state.taskFilter));
      visible.sort((a, b) => groupPriority.indexOf(a.actions[0].group) - groupPriority.indexOf(b.actions[0].group));
      if (!visible.length) tasks.append(el('p', 'notice neutral', 'No tasks match this filter. Choose All tasks to see the complete list.'));
      for (const task of visible) {
        const row = el('article', 'live-task');
        const summary = el('header', 'task-card-header');
        summary.append(el('h2', 'mono', task.thread_id), taskLink(task, 'Open conversation'));
        const meta = el('p', 'task-card-meta', task.saved_only ? 'Available from saved observations' : task.streams.map(stream => stream.repository_id).join(' · '));
        const statuses = el('div', 'task-statuses');
        statuses.append(el('span', 'muted', task.context === 'current' && !state.liveError ? 'Published ARP state' : task.statuses.length ? 'Last observed ARP state' : 'ARP state unavailable'));
        for (const status of task.statuses) statuses.append(badge(status, 'neutral'));
        const next = el('ul', 'task-actions');
        for (const action of task.actions) {
          const entry = el('li', 'task-action');
          const words = el('div');
          words.append(el('strong', '', taskGroups[action.group]), el('p', '', action.description));
          entry.append(words, taskLink(task, action.label, { message: action.message, dispatch: action.run }));
          next.append(entry);
        }
        row.append(summary, meta, statuses, next);
        if (task.saved_snapshot && (state.liveError || ['stale', 'incomplete'].includes(task.context))) {
          row.append(taskLink(task, 'Open saved observation', { snapshot: task.saved_snapshot }));
        }
        tasks.append(row);
      }
      main.append(tasks);
    } else main.append(el('p', 'notice neutral', list.complete ? 'No published task refs were found in the selected namespaces.' : 'No handoffs could be discovered from the accessible streams. Review the read errors above.'));
    main.append(el('p', 'repository-help', 'Task actions use validated observations when their publication refs still match. Agent activity is local to this viewer. Opening a task checks its published context again.'));
  }
  const lookup = el('form', 'live-lookup');
  const field = el('label', 'repository-field'); field.append(el('span', 'repository-field-name', 'Open a handoff by ID'));
  const input = el('input', 'repository-input mono'); input.name = 'task'; input.required = true; input.pattern = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}'; input.placeholder = 'TASK-123'; field.append(input);
  const submit = el('button', 'secondary-button', 'Read handoff ID'); submit.type = 'submit';
  lookup.addEventListener('submit', event => { event.preventDefault(); if (input.reportValidity()) openLiveTask(input.value); }); lookup.append(field, submit); main.append(lookup);
  return main;
}

async function loadLiveList({ scan = false } = {}) {
  refreshLoop.stop(); state.autoRefresh = false; state.refreshBusy = false; state.historyAttempt++;
  const attempt = ++state.liveAttempt; state.load++; closeInspector();
  const alreadyHere = state.view === 'live';
  state.view = 'live'; state.liveBusy = !!state.settings?.configured; state.liveError = null;
  if (state.liveList?.selection_revision !== state.settings?.revision) state.liveList = null;
  if (!scan || !state.liveList) state.checkedTasks.clear();
  state.taskScan = scan ? 'checking' : null;
  render(); syncUrl(); if (!alreadyHere) focusHeading();
  if (!state.settings?.configured) return;
  try {
    if (scan && state.liveList?.complete) {
      const pending = state.liveList.tasks.filter(task => ['unread', 'stale'].includes(task.context));
      let unchecked = pending.filter(task => !state.checkedTasks.has(task.thread_id));
      if (!unchecked.length) { state.checkedTasks.clear(); unchecked = pending; }
      const batch = unchecked.slice(0, 4);
      for (const task of batch) state.checkedTasks.add(task.thread_id);
      const checked = await Promise.allSettled(batch.map(task => request(`/api/live/tasks/${encodeURIComponent(task.thread_id)}`)));
      if (attempt !== state.liveAttempt) return;
      const failures = checked.filter(result => result.status === 'rejected' || !result.value.complete).length;
      state.taskScan = `Checked ${batch.length} conversation${batch.length === 1 ? '' : 's'}.${failures ? ` ${failures} could not be read completely. Open those conversations for recovery guidance.` : ''}`;
    }
    const result = await request('/api/live/discover');
    if (attempt === state.liveAttempt) {
      const retained = result.complete ? [] : (state.liveList?.tasks ?? []).filter(task => !result.tasks.some(entry => entry.thread_id === task.thread_id));
      state.liveList = { ...result, tasks: [...result.tasks, ...retained.map(task => ({
        ...task, context: 'stale', actions: [{ group: 'attention', label: 'Refresh conversation', description: 'This task was present before a repository became unavailable.' }]
      }))] };
    }
  }
  catch (error) { if (attempt === state.liveAttempt) state.liveError = error.message; }
  finally { if (attempt === state.liveAttempt) { state.liveBusy = false; render(); focusHeading(); } }
}

async function openLiveTask(task, snapshotID = null, { message, dispatch, focus = false } = {}) {
  refreshLoop.stop(); state.autoRefresh = false; state.refreshBusy = false; state.refreshError = null; state.refreshSummary = null; state.changedMessages = []; state.historyBusy = false; state.historyAttempt++;
  state.followLatest = !snapshotID;
  const attempt = ++state.liveAttempt; state.load++; closeInspector();
  const previousTask = state.liveTask;
  state.view = 'live-handoff'; state.liveTask = task; state.liveBusy = true; state.liveError = null; state.data = null;
  state.selected = message ?? (previousTask === task ? state.selected : null);
  const dispatchID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(dispatch ?? '') ? dispatch : null;
  state.targetDispatch = dispatchID && state.selected ? { id: dispatchID, message: state.selected } : null;
  state.dispatchRestoreError = null;
  render(); syncUrl();
  if (!state.settings?.configured && !snapshotID) { state.liveBusy = false; render(); return; }
  try {
    const data = await request(snapshotID ? `/api/live/snapshots/${encodeURIComponent(snapshotID)}` : `/api/live/tasks/${encodeURIComponent(task)}`);
    if (data.thread_id !== task) throw new Error('The saved observation belongs to a different handoff.');
    if (attempt !== state.liveAttempt) return;
    state.data = data;
    if (!data.messages.some(message => keyOf(message) === state.selected)) state.selected = data.defaultMessage;
    if (dispatchID && !snapshotID) {
      const selected = data.messages.find(item => keyOf(item) === message);
      try {
        if (!selected || selected.kind !== 'REQUEST') throw new Error('The request for this saved run is unavailable.');
        await renderDispatch.restore(data, selected, dispatchID, () => attempt === state.liveAttempt);
      } catch (error) {
        if (attempt === state.liveAttempt) state.dispatchRestoreError = error.message;
      }
    }
  } catch (error) { if (attempt === state.liveAttempt) state.liveError = error.message; }
  finally { if (attempt === state.liveAttempt) { state.liveBusy = false; render(); syncUrl(); if (focus) focusHeading(); } }
}

async function load(run, phase = null) {
  const attempt = ++state.load; closeInspector();
  app.setAttribute('aria-busy', 'true');
  for (const control of app.querySelectorAll('button, select')) control.disabled = true;
  try {
    const entry = state.runs.find(item => item.key === run); if (!entry) throw new Error('Unknown handoff in the URL.');
    const selectedPhase = phase ?? entry.phases - 1;
    const data = await request(`/api/runs/${run}/phases/${selectedPhase}`);
    if (attempt !== state.load) return;
    const keep = state.run === run && state.phase === selectedPhase && data.messages.some(message => keyOf(message) === state.selected);
    state.run = run; state.phase = selectedPhase; state.data = data;
    if (!keep) state.selected = data.defaultMessage;
    render(); syncUrl();
  } catch (error) {
    if (attempt !== state.load) return;
    const box = el('main', 'load-error'); box.append(el('h1', '', 'Could not open this handoff'), el('p', '', error.message), button(demo ? 'Open demo' : 'Open recorded handoffs', 'primary-button', () => load(defaultRun, demo ? 0 : null))); app.replaceChildren(box);
  } finally { if (attempt === state.load) app.removeAttribute('aria-busy'); }
}

try {
  if (demo) {
    const { createDemoTransport } = await import('./demo-transport.js');
    fetchViewer = await createDemoTransport();
    state.runs = await request('/api/runs');
  } else {
    [state.runs, state.settings] = await Promise.all([request('/api/runs'), request('/api/repositories')]);
    if (state.settings.selection) state.repoDraft = Object.fromEntries(['backend', 'frontend'].map(slot => [slot, state.settings.selection[slot].path]));
    state.repoValidation = state.settings.validation;
  }
  if (state.view === 'live-handoff') await openLiveTask(state.liveTask, params.get('snapshot'), { message: params.get('message'), dispatch: params.get('dispatch') });
  else if (state.view === 'live') await loadLiveList();
  else await load(state.run, state.phase);
}
catch (error) { app.replaceChildren(el('main', 'load-error', error.message)); }
