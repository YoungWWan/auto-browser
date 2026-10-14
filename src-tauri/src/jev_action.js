(request, bridge) => {
  const signature = (s) => JSON.stringify([
    s.documentId, s.url, s.title, s.readyState, s.text,
    s.scroll?.x, s.scroll?.y, s.scroll?.maxY, s.freshness?.fields,
    (s.elements || []).map(e => [e.selector, e.tag, e.role, e.type,
      e.label, e.text, e.value, e.checked, e.disabled, e.href, e.guard,
      e.options?.map(o => [o.label, o.value])]),
  ]);
  const fresh = JSON.parse(bridge({kind: 'snapshot'}));
  const before = request.snapshot;
  const selector = request.action.kind === 'click' && request.action.target?.selector;
  let valid;
  if (selector && Array.isArray(before.freshness?.fields)) {
    const old = (before.elements || []).filter(e => e.selector === selector);
    const current = (fresh.elements || []).filter(e => e.selector === selector);
    valid = fresh.readyState === 'complete' && typeof before.documentId === 'string' &&
      before.documentId === fresh.documentId && before.url === fresh.url &&
      before.readyState === fresh.readyState &&
      JSON.stringify(before.freshness.fields) === JSON.stringify(fresh.freshness?.fields) &&
      old.length === 1 && current.length === 1 && !current[0].disabled &&
      Array.isArray(old[0].guard) &&
      JSON.stringify(old[0].guard) === JSON.stringify(current[0].guard);
  } else valid = signature(fresh) === signature(before);
  if (!valid)
    return JSON.stringify({ok: false, error: 'JEV_STALE_STATE'});
  window.__AUTO_BROWSER_RECORDER__?.setActor('agent');
  try { return bridge(request.action); }
  finally { window.__AUTO_BROWSER_RECORDER__?.setActor('user'); }
}
