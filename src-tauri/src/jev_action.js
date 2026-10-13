(request, bridge) => {
  const signature = (s) => JSON.stringify([
    s.documentId, s.url, s.title, s.readyState, s.text,
    s.scroll?.x, s.scroll?.y, s.scroll?.maxY,
    (s.elements || []).map(e => [e.selector, e.tag, e.role, e.type,
      e.label, e.text, e.value, e.checked, e.disabled, e.href]),
  ]);
  const fresh = JSON.parse(bridge({kind: 'snapshot'}));
  if (signature(fresh) !== signature(request.snapshot))
    return JSON.stringify({ok: false, error: 'JEV_STALE_STATE'});
  window.__AUTO_BROWSER_RECORDER__?.setActor('agent');
  try { return bridge(request.action); }
  finally { window.__AUTO_BROWSER_RECORDER__?.setActor('user'); }
}
