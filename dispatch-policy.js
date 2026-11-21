export function dispatchEligible(view, message) {
  const state = view.requests.find(item => item.request.repository_id === message.source_repository && item.request.message_id === message.message_id);
  return view.complete && !view.historical && !view.latest_read_error && message.kind === 'REQUEST' && message.intent !== 'CLARIFICATION_REQUEST' && state?.status === 'READY' && !view.requests.some(item => ['CONFLICTED', 'INCOMPLETE'].includes(item.status));
}
