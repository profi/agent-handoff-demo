import { clarificationContext, decisionNotice } from './decision-policy.js';

export function createDecisionUI({ state, el, button, request, render, refresh }) {
  const drafts = new Map();
  function post(url, body = {}) { return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  return function decisionPanel(data, question) {
    const panel = el('section', 'content-section decision-panel');
    const context = clarificationContext(data, question);
    panel.append(el('h3', '', 'Human decision'), el('p', 'muted', `Related request: ${context.request?.status ?? 'Unavailable'}. An answer does not change this state.`));
    for (const reply of context.replies) panel.append(el('p', 'provenance-note', `Direct reply from ${reply.source_repository} · ${reply.message_id}`), el('pre', 'original-body', reply.body));
    if (context.replies.length) panel.append(el('p', 'notice warning', 'These are direct replies. No authoritative answer or conflict resolution is inferred.'));
    if (!state.followLatest || data.historical) {
      panel.append(el('p', 'notice warning', 'Historical observation: decision recording is read-only. Follow the latest read to review an answer.'));
      return panel;
    }
    const storageKey = `arp-decision/${data.selection_revision}/${data.thread_id}/${question.source_repository}/${question.message_id}`;
    if (!drafts.has(storageKey)) {
      let saved = {}; try { saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); } catch { /* Optional draft storage. */ }
      drafts.set(storageKey, { answer: '', ...saved, busy: false, error: null, record: null, restored: false });
    }
    const draft = drafts.get(storageKey);
    const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify({ answer: draft.answer, id: draft.id })); } catch { /* Review remains available in memory. */ } };
    const run = async action => {
      if (draft.busy) return;
      draft.busy = true; draft.error = null; render();
      try { await action(); } catch (error) { draft.error = error.message; }
      finally { draft.busy = false; persist(); render(); }
    };
    if (draft.id && !draft.restored) {
      draft.restored = true;
      void run(async () => { draft.record = await request(`/api/live/decisions/${draft.id}`); });
    }
    const eligible = context.eligible && state.followLatest && !state.refreshBusy && !state.historyBusy && !state.refreshError;
    if (!eligible) panel.append(el('p', 'notice warning', 'Decision recording is available only on the latest complete, nonconflicted view of an active request.'));
    const committed = draft.record && ['PUBLISHING', 'UNKNOWN', 'PUBLISHED'].includes(draft.record.phase);
    if (eligible || draft.id) {
      const field = el('label', 'decision-field', 'Exact answer');
      const statusArea = el('div', 'decision-status');
      const answer = el('textarea', 'decision-answer'); answer.setAttribute('aria-label', 'Exact answer'); answer.maxLength = 16000; answer.rows = 6; answer.value = draft.answer; answer.disabled = draft.busy || committed || !eligible;
      answer.addEventListener('input', () => { draft.answer = answer.value; draft.record = null; draft.id = null; draft.restored = true; persist(); review.disabled = !draft.answer.trim(); preview.replaceChildren(); statusArea.replaceChildren(); });
      field.append(answer); panel.append(field, el('p', 'muted', decisionNotice));
      const preview = el('div', 'decision-review');
      const review = button('Review decision', 'primary-button', () => run(async () => {
        draft.id ??= crypto.randomUUID(); draft.restored = true; persist();
        draft.record = await post('/api/live/decisions/prepare', { operation_id: draft.id, observation_id: data.snapshot_id, question: { repository_id: question.source_repository, message_id: question.message_id }, answer: draft.answer });
      }));
      review.disabled = draft.busy || committed || !eligible || !draft.answer.trim(); panel.append(review, preview);
      if (draft.record?.message && draft.record.phase !== 'PUBLISHED') {
        const record = draft.record;
        preview.append(el('h3', '', 'Review exact publication'), el('p', 'provenance-note', 'Git-configured identity; not authenticated human identity'), el('p', '', `${record.identity.name} <${record.identity.email}>`), el('p', '', `${record.pair.join(' ↔ ')} · Publisher: ${record.publisher} · Remote: ${record.remote}`), el('p', 'mono source-pin', `Source commit: ${record.message.source_commit}`), el('pre', 'original-body', record.message.body));
        const envelope = el('details'); envelope.append(el('summary', '', 'Exact protocol envelope'), el('pre', 'raw-evidence', JSON.stringify(record.message, null, 2))); preview.append(envelope);
        if (record.phase === 'PREPARED') {
          const publish = button('Publish decision', 'primary-button', () => run(async () => {
            draft.record = { ...record, phase: 'PUBLISHING' }; render();
            try { draft.record = await post(`/api/live/decisions/${draft.id}/publish`); }
            catch (error) { draft.record = { ...record, phase: 'UNKNOWN' }; throw error; }
            if (draft.record.phase === 'PUBLISHED' && state.data?.thread_id === data.thread_id && state.view === 'live-handoff') await refresh();
          }));
          publish.disabled = draft.busy || !eligible; preview.append(publish);
        }
      }
      if (draft.id) {
        const restore = button('Check publication status', 'text-button', () => run(async () => {
          draft.record = await request(`/api/live/decisions/${draft.id}`);
          if (draft.record.candidate_id) draft.record = await post(`/api/live/decisions/${draft.id}/check`);
        }));
        restore.disabled = draft.busy; statusArea.append(restore);
      }
      if (draft.record) {
        statusArea.append(el('p', 'notice', `Decision status: ${draft.record.phase}`));
        if (draft.record.phase === 'PUBLISHED') statusArea.append(el('p', 'notice positive', `Published ${draft.record.result.message.repository_id}/${draft.record.result.message.message_id}. ${decisionNotice}`));
        if (draft.record.error) statusArea.append(el('p', 'notice warning', draft.record.error));
        if (['UNPUBLISHED', 'PREPARING', 'PREPARED'].includes(draft.record.phase)) {
          const reset = button('Prepare a new review', 'text-button', () => { draft.id = null; draft.record = null; persist(); render(); }); reset.disabled = draft.busy; statusArea.append(reset);
        }
      }
      panel.append(statusArea);
    }
    if (draft.busy) panel.append(el('p', 'muted', 'Checking the reviewed decision…'));
    if (draft.error) panel.append(el('p', 'notice danger', draft.error));
    return panel;
  };
}
