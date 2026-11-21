export function createQuestionUI({ state, el, button, request, render, refresh, onQuestion }) {
  const post = (url, body = {}) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return function questionUI(data, operation, perform) {
    const section = el('section', 'content-section agent-question-loop');
    const run = operation.execution;
    if (!run) return section;
    section.append(el('h3', '', 'Continue through a human decision'), el('p', 'muted', 'Review the exact agent questions before publishing. Publishing a clarification leaves the request lifecycle unchanged.'));
    const storageKey = `arp-question/${run.id}`;
    if (!operation.questionId) { try { operation.questionId = sessionStorage.getItem(storageKey); } catch { /* Optional browser storage. */ } }
    const q = operation.question;
    if (!q || ['PREPARED','PREPARING','UNPUBLISHED'].includes(q.phase)) {
      const prepare = button(q ? 'Prepare fresh clarification review' : 'Review ARP clarification', 'primary-button', () => perform(async () => {
        operation.questionId = q ? crypto.randomUUID() : operation.questionId ?? crypto.randomUUID();
        try { sessionStorage.setItem(storageKey, operation.questionId); } catch { /* Server record remains durable. */ }
        operation.question = await post('/api/live/clarifications/prepare', { operation_id: operation.questionId, source_run: run.id, observation_id: data.snapshot_id });
      })); prepare.disabled = operation.busy || state.refreshBusy || state.historyBusy; section.append(prepare);
    }
    if (operation.questionId && !q) {
      const restore = button('Restore clarification review', 'text-button', () => perform(async () => {
        const value = await request(`/api/live/clarifications/${operation.questionId}`);
        if (value.source_run !== run.id) throw new Error('Saved clarification belongs to another agent run.');
        operation.question = value;
      })); restore.disabled = operation.busy; section.append(restore);
    }
    if (!q) return section;
    section.append(el('p', '', `Clarification: ${q.phase}`));
    if (q.message) section.append(el('p', 'mono source-pin', `${q.message.source_repository} → ${q.message.target_repository}\nRemote: ${q.remote ?? 'Configured publication remote'}\nSource: ${q.message.source_commit}`), el('pre', 'original-body', q.message.body));
    if (q.phase === 'PREPARED') {
      const publish = button('Publish reviewed clarification', 'primary-button', () => perform(async () => {
        operation.question = await post(`/api/live/clarifications/${q.id}/publish`);
        if (operation.question.phase === 'PUBLISHED' && state.view === 'live-handoff' && state.data?.thread_id === data.thread_id) await refresh();
      })); publish.disabled = operation.busy || state.refreshBusy || state.historyBusy; section.append(publish);
    }
    const check = button('Check clarification publication', 'text-button', () => perform(async () => { operation.question = await post(`/api/live/clarifications/${q.id}/check`); })); check.disabled = operation.busy; section.append(check);
    if (['PUBLISHING','UNKNOWN'].includes(q.phase)) section.append(el('p', 'notice warning', 'Publication outcome is unconfirmed. Check status before preparing another clarification.'));
    if (q.phase === 'PUBLISHED') {
      section.append(el('p', 'notice positive', `Published ${q.message.source_repository}/${q.message.message_id}. The dispatched run still awaits a human answer.`));
      const open = button('Open clarification and record answer', 'text-button', () => onQuestion(`${q.message.source_repository}/${q.message.message_id}`)); open.disabled = operation.busy; section.append(open);
      const answers = button('Read published human answers', 'text-button', () => perform(async () => {
        operation.answers = (await request(`/api/live/clarifications/${q.id}/answers`)).answers;
        operation.selectedDecision = null;
      })); answers.disabled = operation.busy; section.append(answers);
      if (operation.answers?.length === 0) section.append(el('p', 'notice warning', 'No published reply answers this clarification yet. Record and publish an answer, then read replies again.'));
      if (operation.answers?.length) {
        section.append(el('p', 'notice warning', 'Select the exact published answer to use. Multiple answers are not reconciled automatically.'));
        const label = el('label', '', 'Published human decision'), select = el('select'); select.setAttribute('aria-label', 'Published human decision');
        const empty = el('option', '', 'Choose a published answer'); empty.value = ''; select.append(empty);
        const answerKey = answer => `${answer.message.repository_id}/${answer.message.message_id}`;
        for (const answer of operation.answers) { const option = el('option', '', `${answer.identity?.name ?? answer.message.repository_id}: ${answer.answer.slice(0, 100)}`); option.value = answerKey(answer); select.append(option); }
        select.value = operation.selectedDecision ?? ''; select.disabled = operation.busy;
        select.addEventListener('change', () => { operation.selectedDecision = select.value || null; render(); }); label.append(select); section.append(label);
        const selected = operation.answers.find(answer => answerKey(answer) === operation.selectedDecision);
        if (selected) {
          section.append(el('p', 'provenance-note', `Git-configured identity; not authenticated human identity: ${selected.identity.name} <${selected.identity.email}>`), el('pre', 'original-body', selected.answer));
          const resume = button('Prepare resumed planning review', 'primary-button', () => perform(async () => {
            const id = crypto.randomUUID();
            const record = await post('/api/live/dispatches/resume', { operation_id: id, observation_id: data.snapshot_id, clarification_id: q.id, decision: selected.message });
            operation.id = id; operation.record = record; operation.execution = null; operation.confirm = false; operation.questionId = null; operation.question = null; operation.answers = null;
            try { sessionStorage.setItem(`arp-dispatch/${data.selection_revision}/${record.packet.request.repository_id}/${record.packet.request.message_id}`, id); } catch { /* Server review remains durable. */ }
          })); resume.disabled = operation.busy || state.refreshBusy || state.historyBusy; section.append(resume);
        }
      }
    }
    return section;
  };
}
