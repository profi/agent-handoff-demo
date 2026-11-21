export function createCompletionUI({ state, el, button, request, render, refresh, inspect }) {
  const drafts = new Map();
  const post = (url, body = {}) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return function completionPanel(data, dispatch, run, contextChanged = false) {
    const panel = el('section', 'content-section completion-panel');
    panel.append(el('h4', '', 'Completion handoff'));
    const tests = run.evidence?.reviewed_tests;
    if (run.phase !== 'COMPLETED' || !run.evidence?.changes?.length || tests?.status !== 'PASSED' || tests.exit_code !== 0 ||
        !Array.isArray(tests.file_changes) || tests.file_changes.length || run.result?.questions?.length) {
      panel.append(el('p', 'muted', 'Completion requires changed files and passing independent tests that leave the staged result unchanged.'));
      return panel;
    }
    const key = `${data.selection_revision}/${dispatch.id}`;
    if (!drafts.has(key)) drafts.set(key, { summary: '', record: null, busy: false, error: null });
    const draft = drafts.get(key), available = !contextChanged && !state.refreshBusy && !state.historyBusy && !draft.busy;
    const endpoint = `/api/live/completions/${dispatch.id}`;
    const perform = async action => {
      if (draft.busy) return;
      draft.busy = true;
      draft.error = null;
      render();
      try { await action(); } catch (error) { draft.error = error.message; }
      finally { draft.busy = false; render(); }
    };
    const record = draft.record;
    if (!record) {
      const field = el('label', 'repository-field', 'Completion summary');
      const summary = el('textarea', 'decision-answer');
      summary.rows = 4;
      summary.maxLength = 4000;
      summary.value = draft.summary;
      summary.disabled = !available;
      field.append(summary);
      const prepare = button('Prepare Git result review', 'secondary-button', () => perform(async () => {
        draft.record = await post('/api/live/completions/prepare', { operation_id: dispatch.id, observation_id: data.snapshot_id, source_run: dispatch.id, summary: draft.summary });
      }));
      const update = () => { draft.summary = summary.value; prepare.disabled = !available || !draft.summary.trim(); };
      summary.addEventListener('input', update);
      update();
      const restore = button('Restore saved completion review', 'text-button', () => perform(async () => { draft.record = await request(endpoint); }));
      restore.disabled = draft.busy;
      panel.append(field, prepare, restore);
    } else {
      panel.append(el('p', 'notice', `Completion review: ${record.phase}`));
      if (record.phase === 'REVIEW_RESULT') {
        panel.append(el('p', '', 'Retain the reviewed files in a local Git commit. The application branch, index, and checkout stay in place.'));
        panel.append(el('p', 'mono source-pin', `Reviewed base: ${record.base}\nPublishing identity: ${record.identity.name} <${record.identity.email}>\nTest: ${record.test.runner} ${record.test.files.join(' ')} · exit 0`));
        for (const file of record.changed_files) {
          const path = el('p', 'mono source-pin', `${file.status}: ${file.path}`);
          if (inspect) path.append(button('View diff', 'text-button', () => inspect(`Diff for ${file.path}`, `/api/live/dispatches/${dispatch.id}/diff?${new URLSearchParams({ file:file.path })}`)));
          panel.append(path);
        }
        const retain = button('Create reviewed Git result', 'primary-button', () => perform(async () => { draft.record = await post(`${endpoint}/retain`); }));
        retain.disabled = !available;
        panel.append(retain);
      }
      if (record.message) {
        panel.append(el('h5', '', 'Reviewed ARP publication'));
        panel.append(el('p', '', `${record.pair.join(' ↔ ')} · Publisher: ${record.publisher} · Remote: ${record.remote}`));
        panel.append(el('p', 'mono source-pin', `Result commit: ${record.message.source_commit}\nLocal result ref: ${record.git_result.ref}`));
        panel.append(el('p', 'muted', `Published ARP state remains ${record.request_status}.`), el('pre', 'original-body', record.message.body));
        const envelope = el('details');
        envelope.append(el('summary', '', 'Exact protocol envelope'), el('pre', 'raw-evidence', JSON.stringify(record.message, null, 2)));
        panel.append(envelope);
      }
      if (record.phase === 'PREPARED') {
        const publish = button('Publish completion handoff', 'primary-button', () => perform(async () => {
          draft.record = { ...record, phase: 'PUBLISHING' };
          try { draft.record = await post(`${endpoint}/publish`); }
          catch (error) { draft.record = { ...record, phase: 'UNKNOWN' }; throw error; }
          if (draft.record.phase === 'PUBLISHED' && state.view === 'live-handoff' && state.data?.thread_id === data.thread_id) await refresh();
        }));
        publish.disabled = !available;
        panel.append(publish);
      }
      if (['PUBLISHING', 'UNKNOWN', 'UNPUBLISHED'].includes(record.phase)) {
        const check = button('Check completion publication', 'secondary-button', () => perform(async () => {
          draft.record = await request(endpoint);
          if (['PUBLISHING', 'UNKNOWN', 'UNPUBLISHED'].includes(draft.record.phase)) draft.record = await post(`${endpoint}/check`);
          if (draft.record.phase === 'PUBLISHED' && state.view === 'live-handoff' && state.data?.thread_id === data.thread_id) await refresh();
        }));
        check.disabled = draft.busy;
        panel.append(check);
        if (record.phase === 'UNPUBLISHED') panel.append(el('p', 'notice warning', 'No publication was found. Prepare a new reviewed implementation before publishing a replacement result.'));
      }
      if (record.phase === 'PUBLISHED') panel.append(el('p', 'notice positive', `Published ${record.result.message.repository_id}/${record.result.message.message_id}.`));
      if (record.error) panel.append(el('p', 'notice warning', record.error));
    }
    if (draft.busy) panel.append(el('p', 'muted', 'Checking the saved completion review…'));
    if (draft.error) panel.append(el('p', 'notice danger', draft.error));
    return panel;
  };
}
