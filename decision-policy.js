export const decisionNotice = 'Records an answer; does not authorize or start implementation.';
const key = ref => ref && `${ref.repository_id}/${ref.message_id}`;
export function publishedAnswers(snapshot, question) {
  const questionKey = `${question.source_repository}/${question.message_id}`;
  const header = '# Human decision recorded\n\nGit-configured identity; not authenticated human identity: ';
  const footer = `\n\n${decisionNotice}`;
  return snapshot.messages.flatMap(reply => {
    if (reply.kind !== 'INFORMATION' || reply.intent !== 'INFORMATION' || key(reply.parent) !== questionKey ||
        reply.source_repository !== question.target_repository || reply.target_repository !== question.source_repository) return [];
    const message = { repository_id: reply.source_repository, message_id: reply.message_id };
    const separator = `\nQuestion: ${questionKey}\n\nExact operator answer:\n`;
    const at = reply.body.indexOf(separator);
    const identity = reply.body.startsWith(header) && at > header.length && reply.body.endsWith(footer)
      ? /^([^\r\n]+) <([^\r\n<>]+)>$/.exec(reply.body.slice(header.length, at)) : null;
    const answer = identity ? reply.body.slice(at + separator.length, -footer.length) : reply.body;
    return [{ message, answer, identity: identity ? { name: identity[1], email: identity[2] } : null, published_message: reply }];
  });
}
export function clarificationContext(view, question) {
  const messages = new Map(view.messages.map(message => [`${message.source_repository}/${message.message_id}`, message]));
  let current = question; const seen = new Set();
  while (current && current.kind !== 'REQUEST') {
    const parent = key(current.parent);
    if (!parent || seen.has(parent)) { current = null; break; }
    seen.add(parent); current = messages.get(parent);
  }
  const request = current && view.requests.find(item => key(item.request) === `${current.source_repository}/${current.message_id}`);
  const replies = view.messages.filter(message => key(message.parent) === `${question.source_repository}/${question.message_id}`);
  const eligible = question.kind === 'INFORMATION' && question.intent === 'CLARIFICATION_REQUEST' && view.complete && !view.historical && !view.latest_read_error && !view.requests.some(item => ['CONFLICTED', 'INCOMPLETE'].includes(item.status)) && request && !['CLOSED', 'SUPERSEDED'].includes(request.status);
  return { request, replies, eligible: !!eligible };
}
