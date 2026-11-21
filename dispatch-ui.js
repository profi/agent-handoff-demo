import { dispatchEligible } from './dispatch-policy.js';
import { createQuestionUI } from './question-ui.js';
import { createCompletionUI } from './completion-ui.js';
export function createDispatchUI({ state, el, button, request, render, inspect, refresh, onQuestion, onReview }) {
  const operations = new Map();
  const questionUI = createQuestionUI({ state, el, button, request, render, refresh, onQuestion });
  const completionUI = createCompletionUI({ state, el, button, request, render, refresh, inspect });
  const operationKey = (data, message) => `${data.selection_revision}/${message.source_repository}/${message.message_id}`;
  function panel(data, message) {
    const section = el('section', 'content-section dispatch-panel');
    section.append(el('h3', '', 'Agent dispatch'), el('p', 'notice warning', 'Local Codex CLI · Reviewed planning and isolated implementation on staged source copies. Review before launching; your existing Codex account is used.'));
    const eligible = dispatchEligible(data, message);
    if (!state.followLatest || !data.complete || data.historical || data.latest_read_error || state.refreshError || data.requests.some(item => ['CONFLICTED','INCOMPLETE'].includes(item.status)) || data.requests.some(item => ['CLOSED','SUPERSEDED'].includes(item.status) && item.request.repository_id === message.source_repository && item.request.message_id === message.message_id)) {
      section.append(el('p', 'muted', 'Dispatch preparation requires following the latest complete READY work request.')); return section;
    }
    const key = operationKey(data, message);
    if (!operations.has(key)) {
      let savedId = null; try { savedId = sessionStorage.getItem(`arp-dispatch/${key}`); } catch { /* Optional browser storage. */ }
      operations.set(key, { id: savedId, record: null, busy: false, error: null, execution: null, confirm: false });
    }
    const operation = operations.get(key);
    if (!eligible && !operation.id) { section.append(el('p', 'muted', 'Prepare a new dispatch only for a READY request.')); return section; }
    const run = async action => { if (operation.busy) return; operation.busy = true; operation.error = null; render(); try { operation.record = await action(); } catch (error) { operation.error = error.message; } finally { operation.busy = false; render(); } };
    const prepare = button(operation.record ? 'Prepare fresh dispatch review' : 'Prepare agent dispatch', 'primary-button', () => run(() => {
      operation.id = operation.record ? crypto.randomUUID() : operation.id ?? crypto.randomUUID();
      operation.execution = null; operation.confirm = false;
      operation.implementation = null; operation.implementationId = null;
      operation.questionId = null; operation.question = null; operation.answers = null; operation.selectedDecision = null;
      try { sessionStorage.setItem(`arp-dispatch/${key}`, operation.id); } catch { /* Packet remains durable on the server. */ }
      return request('/api/live/dispatches/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: operation.id, observation_id: data.snapshot_id, request: { repository_id: message.source_repository, message_id: message.message_id } }) });
    }));
    prepare.disabled = operation.busy || state.refreshBusy || state.historyBusy || !eligible; section.append(prepare);
    if (operation.id && !operation.record) {
      const restore = button('Restore saved dispatch review', 'text-button', () => run(() => request(`/api/live/dispatches/${operation.id}`))); restore.disabled = operation.busy; section.append(restore);
    }
    if (operation.record) {
      const record = operation.record;
      section.append(el('p', '', record.packet.mode === 'implement' ? 'Reviewed scope: apply the saved plan in an isolated staging copy and report evidence. Publication, merge and deployment are not authorized by this packet.' : 'Reviewed scope: inspect and propose a plan only. Implementation and publication are not authorized by this packet.'), el('p', 'mono source-pin', `Recipient: ${record.recipient}\nCheckout: ${record.packet.checkout}\nRecipient HEAD: ${record.packet.recipient_head}\nSender source: ${record.packet.source_commit}\nSaved dispatch: ${record.id}`));
      for (const publication of record.packet.publications) section.append(el('p', 'mono source-pin', `${publication.repository_id}: ${publication.publication ?? 'No publication'}`));
      section.append(el('pre', 'original-body', record.packet.instructions));
      if (record.packet.resume) section.append(el('p', 'notice', `Resumed plan from run ${record.packet.resume.parent_run}; selected published decision ${record.packet.resume.decision.repository_id}/${record.packet.resume.decision.message_id}.`), el('pre', 'original-body', record.packet.resume.exact_answer));
      const validate = button('Revalidate dispatch review', 'text-button', () => run(() => request(`/api/live/dispatches/${record.id}/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })));
      validate.disabled = operation.busy; section.append(validate);
      if (record.validation) section.append(el('p', `notice ${record.validation.valid ? 'positive' : 'danger'}`, record.validation.message));
      const postRun = (suffix = '') => request(`/api/live/dispatches/${record.id}/run${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const updateRun = action => run(async () => { operation.execution = await action(); return operation.record; });
      if (!operation.execution || operation.execution.phase === 'NOT_STARTED') {
        const review = button('Review local agent launch', 'primary-button', () => { operation.confirm = true; render(); }); review.disabled = operation.busy; section.append(review);
        if (operation.confirm) {
          section.append(el('p', 'notice warning', 'Launch the local Codex CLI using your signed-in account? It is instructed to inspect exported source copies with read-only permissions, no inherited user configuration, no automatic approvals, and a five-minute limit. The sandbox permits reading other files accessible to your user. Context read by the agent may be processed by your existing Codex service. Implementation and publication are not authorized; it will not continue automatically.'));
          const launch = button('Confirm launch: inspect and plan', 'primary-button', () => updateRun(() => postRun())); launch.disabled = operation.busy || state.refreshBusy || state.historyBusy; section.append(launch);
        }
      }
      const status = button('Refresh agent run status', 'text-button', () => updateRun(() => request(`/api/live/dispatches/${record.id}/run`))); status.disabled = operation.busy; section.append(status);
      if (operation.execution) {
        const execution = operation.execution;
        section.append(el('p', 'notice', `Run: ${execution.phase} · ${execution.message ?? ''}`));
        if (['STARTING','RUNNING'].includes(execution.phase)) { const cancel = button('Cancel agent run', 'text-button', () => updateRun(() => postRun('/cancel'))); cancel.disabled = operation.busy; section.append(cancel); }
        if (execution.result) { section.append(el('p', '', execution.result.summary)); for (const question of execution.result.questions) section.append(el('p', 'notice warning', question)); for (const step of execution.result.plan) section.append(el('p', '', step)); for (const limit of execution.result.limitations) section.append(el('p', 'muted', limit)); }
        const answeredBlocked = record.packet.resume && data.requests.some(item => item.status === 'BLOCKED' && item.request.repository_id === message.source_repository && item.request.message_id === message.message_id);
        if (execution.phase === 'COMPLETED' && execution.result?.outcome === 'PLAN_READY' && !execution.result.questions.length && (eligible || answeredBlocked)) {
          const label = el('label', '', 'Reviewed JavaScript test files (one committed path per line)');
          const files = el('textarea'); files.value = operation.testFiles ?? ''; files.rows = 3; files.addEventListener('input', event => { operation.testFiles = event.target.value; operation.implementationId = null; }); label.append(files); section.append(label);
          const prepareImplementation = button('Prepare implementation review', 'primary-button', () => run(async () => {
            operation.implementationId ??= crypto.randomUUID();
            operation.implementation = await request('/api/live/dispatches/implement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation_id: operation.implementationId, observation_id: data.snapshot_id, plan_run: record.id, test_files: (operation.testFiles ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean) }) });
            operation.implementationExecution = null;
            operation.implementationConfirm = false;
            operation.implementationQuestion = null;
            try { sessionStorage.setItem(`arp-implementation/${record.id}`, operation.implementation.id); } catch { /* The review remains durable on the server. */ }
            return operation.record;
          })); prepareImplementation.disabled = operation.busy || state.refreshBusy || state.historyBusy; section.append(prepareImplementation);
          let savedImplementation; try { savedImplementation = sessionStorage.getItem(`arp-implementation/${record.id}`); } catch { /* Optional browser storage. */ }
          if (savedImplementation && !operation.implementation) {
            const restore = button('Restore implementation review', 'text-button', () => run(async () => { operation.implementation = await request(`/api/live/dispatches/${savedImplementation}`); operation.implementationId = savedImplementation; return operation.record; })); restore.disabled = operation.busy; section.append(restore);
          }
        }
        if (operation.implementation) {
          const impl = operation.implementation;
          const reviewedHeads = new Map((impl.packet.publications ?? []).map(item => [item.repository_id, item.publication]));
          const contextChanged = Array.isArray(data.publications) && (data.publications.length !== reviewedHeads.size ||
            data.publications.some(item => !reviewedHeads.has(item.repository_id) || reviewedHeads.get(item.repository_id) !== item.publication));
          if (!impl.execution_available) { section.append(el('h4', '', 'Prepared implementation scope'), el('p', 'notice warning', 'Implementation requires Windows MXC and a new review with explicitly selected tests.'), el('pre', 'original-body', impl.packet.instructions), el('p', 'mono', `Reviewed tests: ${impl.packet.execution_policy?.tests?.files?.join(' ') ?? 'No test files recorded'}`)); return section; }
          section.append(el('h4', '', 'Prepared implementation scope'), el('p', 'notice warning', 'The agent runs with an isolated staged checkout. The sandbox permits reads of files accessible to your user outside that checkout. The agent is instructed not to install dependencies or run scripts; commands are not individually restricted by the viewer. The host independently executes the selected test files. Review the selected tests and permissions before launch.'), el('p', 'mono', `Saved review: ${impl.id}\nPlan run: ${impl.packet.approved_plan.run_id}\nRecipient: ${impl.packet.recipient}\nRecipient HEAD: ${impl.packet.recipient_head}\nSender source: ${impl.packet.source_commit}\nAgent timeout: at most ${(impl.packet.execution_policy.agent_timeout_ms ?? 300000) / 1000} seconds\nTests: node --test ${impl.packet.execution_policy.tests.files.join(' ')}\nTest timeout: ${impl.packet.execution_policy.tests.timeout_ms / 1000} seconds`), el('pre', 'original-body', impl.packet.instructions));
          if (impl.packet.approved_plan.selected_decision) section.append(el('p', 'notice', `Selected decision: ${impl.packet.approved_plan.selected_decision.decision.repository_id}/${impl.packet.approved_plan.selected_decision.decision.message_id}`), el('pre', 'original-body', impl.packet.approved_plan.selected_decision.exact_answer));
          if (impl.packet.revision) {
            const previous = el('a', 'secondary-button task-link', 'Open previous attempt');
            const query = new URLSearchParams({ view: 'live', task: data.thread_id, message: `${message.source_repository}/${message.message_id}`, dispatch: impl.packet.revision.source_run });
            previous.href = `/?${query}`;
            section.append(previous);
          }
          const launchImpl = button('Review implementation launch', 'primary-button', () => { operation.implementationConfirm = true; render(); }); launchImpl.disabled = contextChanged || operation.busy || Boolean(operation.implementationExecution); section.append(launchImpl);
          if (contextChanged) section.append(el('p', 'notice warning', 'Publication context changed since this review. You can inspect saved evidence. A fresh plan is required for another run or a new completion review.'));
          if (operation.implementationConfirm && !operation.implementationExecution) {
            section.append(el('p', 'notice warning', 'Launch the approved plan in the staged copy? The agent can run commands within the sandbox. The host will independently run the reviewed tests after implementation. Publication, merge and deployment are not authorized. Repository context is processed by your signed-in Codex service.'));
            const confirmImpl = button('Confirm implementation launch', 'primary-button', () => run(async () => { operation.implementationExecution = await request(`/api/live/dispatches/${impl.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return operation.record; })); confirmImpl.disabled = contextChanged || operation.busy; section.append(confirmImpl);
          }
          const refreshImpl = button('Refresh implementation status', 'text-button', () => run(async () => { operation.implementationExecution = await request(`/api/live/dispatches/${impl.id}/run`); return operation.record; })); refreshImpl.disabled = operation.busy; section.append(refreshImpl);
          if (operation.implementationExecution) {
            const execution = operation.implementationExecution; section.append(el('p', 'notice', `Implementation run: ${execution.phase} · ${execution.message ?? ''}`));
            if (['STARTING','RUNNING','TESTING'].includes(execution.phase)) { const cancel = button('Cancel implementation run', 'text-button', () => run(async () => { operation.implementationExecution = await request(`/api/live/dispatches/${impl.id}/run/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return operation.record; })); cancel.disabled = operation.busy; section.append(cancel); }
            if (execution.result) {
              section.append(el('p', '', execution.result.summary));
              for (const question of execution.result.questions ?? []) section.append(el('p', 'notice warning', question));
              for (const limit of execution.result.limitations ?? []) section.append(el('p', 'muted', limit));
            }
            for (const change of execution.evidence?.changes ?? []) {
              const row = el('div', 'message-actions');
              row.append(el('span', 'mono source-pin', `${change.status}: ${change.path}`));
              if (inspect && ['COMPLETED', 'AWAITING_HUMAN', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(execution.phase)) {
                const url = `/api/live/dispatches/${impl.id}/diff?${new URLSearchParams({ file: change.path })}`;
                const open = button('View diff', 'text-button', () => inspect(`Diff for ${change.path}`, url));
                open.setAttribute('aria-label', `View diff for ${change.path}`);
                row.append(open);
              }
              section.append(row);
            }
            const observed = execution.evidence?.reviewed_tests;
            if (observed) {
              section.append(el('p', 'notice', `Independently observed tests: ${observed.status} · exit ${observed.exit_code ?? 'unavailable'}`), el('pre', 'original-body', observed.stdout), el('pre', 'original-body', observed.stderr));
              for (const change of observed.file_changes ?? []) section.append(el('p', 'notice warning', `Test changed staged file: ${change.status}: ${change.path}`));
            }
            else if (['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN'].includes(execution.phase)) {
              section.append(el('p', 'notice warning', 'No independently observed test result is available for this run.'));
            }
            if (!contextChanged && ['COMPLETED', 'FAILED'].includes(execution.phase) && execution.evidence?.before_files && execution.evidence?.after_files && !execution.result?.questions?.length) {
              const label = el('label', 'repository-field', 'Revision instructions');
              const instructions = el('textarea', 'decision-answer');
              instructions.rows = 3;
              instructions.maxLength = 4000;
              instructions.value = operation.revisionDraft ?? '';
              instructions.disabled = operation.busy;
              label.append(instructions);
              const prepareRevision = button('Prepare revision review', 'secondary-button', () => run(async () => {
                operation.revisionId ??= crypto.randomUUID();
                const revision = await request('/api/live/dispatches/revise', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ operation_id: operation.revisionId, observation_id: data.snapshot_id, source_run: impl.id, instructions: operation.revisionDraft ?? '' })
                });
                operation.implementation = revision;
                operation.implementationId = revision.id;
                operation.implementationExecution = null;
                operation.implementationConfirm = false;
                operation.implementationQuestion = null;
                operation.revisionDraft = '';
                operation.revisionId = null;
                try { sessionStorage.setItem(`arp-implementation/${record.id}`, revision.id); } catch { /* Server record remains durable. */ }
                onReview?.(revision.id, data.thread_id, `${message.source_repository}/${message.message_id}`);
                return operation.record;
              }));
              const toggleRevision = () => { prepareRevision.disabled = operation.busy || state.refreshBusy || state.historyBusy || !instructions.value.trim(); };
              instructions.addEventListener('input', event => {
                operation.revisionDraft = event.target.value;
                operation.revisionId = null;
                toggleRevision();
              });
              toggleRevision();
              section.append(label, prepareRevision);
            }
            if (['COMPLETED', 'FAILED'].includes(execution.phase)) section.append(completionUI(data, impl, execution, contextChanged));
            if (execution.phase === 'AWAITING_HUMAN') {
              operation.implementationQuestion ??= { record: impl, execution };
              operation.implementationQuestion.execution = execution;
              section.append(questionUI(data, operation.implementationQuestion, action => run(async () => {
                await action();
                if (operation.implementationQuestion.record?.id !== impl.id) {
                  operation.id = operation.implementationQuestion.id; operation.record = operation.implementationQuestion.record;
                  operation.execution = null; operation.implementation = null; operation.implementationExecution = null; operation.implementationQuestion = null;
                }
                return operation.record;
              })));
            }
          }
        }
        if (execution.phase === 'AWAITING_HUMAN') section.append(questionUI(data, operation, action => run(async () => { await action(); return operation.record; })));
      }
    }
    if (operation.busy) section.append(el('p', 'muted', 'Validating the published context and receiving checkout…'));
    if (operation.error) section.append(el('p', 'notice danger', operation.error));
    return section;
  }
  panel.restore = async (data, message, id, isCurrent) => {
    const rootKey = `${message.source_repository}/${message.message_id}`;
    const inScope = record => record.thread_id === data.thread_id &&
      `${record.packet.request.repository_id}/${record.packet.request.message_id}` === rootKey;
    const saved = await request(`/api/live/dispatches/${id}`);
    if (!inScope(saved)) throw new Error('The saved run does not belong to this request.');
    const impl = saved.packet.mode === 'implement' ? saved : null;
    const plan = impl ? await request(`/api/live/dispatches/${impl.packet.approved_plan.run_id}`) : saved;
    if (!inScope(plan)) throw new Error('The saved plan does not belong to this request.');
    const [execution, implementationExecution] = await Promise.all([
      request(`/api/live/dispatches/${plan.id}/run`),
      impl ? request(`/api/live/dispatches/${impl.id}/run`) : Promise.resolve(null)
    ]);
    if (!isCurrent()) return;
    operations.set(operationKey(data, message), {
      id: plan.id, record: plan, execution, busy: false, error: null, confirm: false,
      implementation: impl, implementationId: impl?.id,
      implementationExecution: implementationExecution?.phase === 'NOT_STARTED' ? null : implementationExecution
    });
  };
  return panel;
}
