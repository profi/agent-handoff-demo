// Browser-independent refresh state: an explicitly pinned view never advances.
export function mergeObservation(current, incoming, followLatest) {
  if (!current) return incoming;
  const metadata = (current.history?.sequence ?? -1) > (incoming.history?.sequence ?? -1) ? current : incoming;
  const view = followLatest ? metadata : current;
  return {
    ...view,
    history: metadata.history,
    historical: view.snapshot_id !== metadata.history.latest_snapshot_id,
    last_checked_at: metadata.last_checked_at,
    latest_read_error: metadata.latest_read_error
  };
}

export function describeChanges(changes) {
  if (!changes) return [];
  const result = [];
  if (changes.added_messages.length) result.push(`${changes.added_messages.length} new message${changes.added_messages.length === 1 ? '' : 's'}`);
  for (const item of changes.state_changes) result.push(`${item.from ?? 'New request'} → ${item.to}`);
  if (changes.unobserved_messages.length) result.push(`${changes.unobserved_messages.length} previously seen message${changes.unobserved_messages.length === 1 ? '' : 's'} absent from this read`);
  if (changes.changed_messages.length) result.push('Previously seen message content changed');
  if (changes.completeness_changed) result.push('Protocol completeness changed');
  if (!result.length && changes.publication_changes.length) result.push('Publication heads changed');
  return result;
}

export function createRefreshLoop({ refresh, active, delay = 30000, schedule = setTimeout, cancel = clearTimeout }) {
  let timer = null, generation = 0;
  function stop() { generation++; if (timer !== null) cancel(timer); timer = null; }
  function start() {
    stop(); const run = generation;
    const tick = async () => {
      timer = null;
      if (run !== generation || !active()) return;
      try { await refresh(); } catch { /* The refresh owner presents failures; keep the loop bounded. */ }
      finally { if (run === generation && active()) timer = schedule(tick, delay); }
    };
    if (active()) timer = schedule(tick, delay);
  }
  return { start, stop };
}
