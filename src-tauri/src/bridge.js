(() => {
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const text = el => (el?.innerText || el?.textContent || '').trim().replace(/\s+/g, ' ');
  // Only IDs/revisions leave this cache. Raw field values, including passwords,
  // remain in the page and are never included in a snapshot or model request.
  const cache = window.__AUTO_BROWSER_FRESHNESS__ ||= {nodes:new WeakMap(), fields:new WeakMap(), next:1};
  cache.scopes ||= new WeakMap();
  const observedScopes = new WeakMap();
  const identity = el => {
    if (!cache.nodes.has(el)) cache.nodes.set(el, cache.next++);
    return cache.nodes.get(el);
  };
  const fieldState = el => {
    const state = JSON.stringify([el.value ?? el.textContent, el.checked, el.selectedIndex,
      el.disabled, el.readOnly, el.getAttribute('aria-disabled'), el.getAttribute('aria-readonly'),
      el.options ? [...el.options].map(o => [o.value,o.text,o.disabled]) : null]);
    const previous = cache.fields.get(el);
    const revision = previous ? previous.revision + Number(previous.state !== state) : 0;
    cache.fields.set(el, {state, revision});
    return [identity(el), revision];
  };
  const guard = el => {
    const scope = el.closest('form,dialog,[role="dialog"],tr,[role="row"],li,article,section') || el.parentElement;
    let scopeRevision = null;
    if (scope) {
      if (!observedScopes.has(scope)) {
        const state = text(scope);
        const previous = cache.scopes.get(scope);
        const revision = previous ? previous.revision + Number(previous.state !== state) : 0;
        cache.scopes.set(scope, {state, revision});
        observedScopes.set(scope, revision);
      }
      scopeRevision = observedScopes.get(scope);
    }
    return [identity(el), scope ? identity(scope) : null, scopeRevision, el.tagName, el.getAttribute('role'), el.type ?? null,
      label(el), text(el), el.value ?? null, el.checked ?? null, el.disabled ?? null,
      el.readOnly ?? null, el.getAttribute('href'),
      ...['aria-disabled','aria-readonly','aria-expanded','aria-checked','aria-selected','aria-controls','inert'].map(a => el.getAttribute(a))];
  };
  const label = el => [el.getAttribute('aria-label'), ...(el.labels ? [...el.labels].map(text) : []), el.getAttribute('placeholder')].filter(Boolean).join(' ').trim();
  const selector = el => {
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'name']) {
      const v = el.getAttribute(attr);
      if (v) { const s = `${el.tagName.toLowerCase()}[${attr}=${JSON.stringify(v)}]`; if (document.querySelectorAll(s).length === 1) return s; }
    }
    const parts = [];
    while (el && el !== document.body) {
      const tag = el.tagName.toLowerCase();
      const peers = el.parentElement ? [...el.parentElement.children].filter(x => x.tagName === el.tagName) : [];
      parts.unshift(tag + (peers.length > 1 ? `:nth-of-type(${peers.indexOf(el) + 1})` : ''));
      el = el.parentElement;
    }
    return 'body > ' + parts.join(' > ');
  };
  const find = target => {
    let all;
    if (target?.selector) all = [...document.querySelectorAll(target.selector)].filter(visible);
    else if (target?.label) all = [...document.querySelectorAll('input,textarea,select,button,[role="textbox"],[role="combobox"],[contenteditable="true"]')].filter(el => visible(el) && (label(el) === target.label || [...(el.labels || [])].some(x => text(x) === target.label)));
    else if (target?.text) all = [...document.querySelectorAll('button,a,[role="button"],input[type="submit"]')].filter(el => visible(el) && (text(el) || el.value) === target.text);
    else throw new Error('缺少定位信息');
    if (all.length !== 1) throw new Error(all.length ? `匹配到 ${all.length} 个元素，请使用唯一定位` : '没有找到可见的目标元素');
    return all[0];
  };
  return request => {
    try {
      if (request.kind === 'snapshot') {
        const fields = [...document.querySelectorAll('input,textarea,select,[contenteditable="true"]')].map(fieldState);
        const elements = [...document.querySelectorAll('input,textarea,select,button,a,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="textbox"],[role="combobox"],[contenteditable="true"]')].filter(visible).slice(0,250).map(el => ({tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),type:el.type,label:label(el),text:text(el).slice(0,180),selector:selector(el),href:el instanceof HTMLAnchorElement ? el.href : undefined,value:el.type === 'password' ? '[redacted]' : el.value,checked:el.checked ?? (el.getAttribute('aria-checked') === 'true'),disabled:el.disabled || el.getAttribute('aria-disabled') === 'true',options:el.options ? [...el.options].map(o=>({label:o.text,value:o.value})) : undefined,guard:el.type === 'password' ? [identity(el), '[redacted]'] : guard(el)}));
        window.__AUTO_BROWSER_DOCUMENT_ID__ ||= crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        return JSON.stringify({ok:true,documentId:window.__AUTO_BROWSER_DOCUMENT_ID__,url:location.href,title:document.title,readyState:document.readyState,scroll:{x:scrollX,y:scrollY,maxY:Math.max(0,document.documentElement.scrollHeight-innerHeight)},freshness:{fields},recording:window.__AUTO_BROWSER_RECORDER__?.status(),text:text(document.body).slice(0,10000),elements,limitations:{crossOriginFrames:document.querySelectorAll('iframe').length,shadowRootsNotTraversed:true,inputMode:'dom'}});
      }
      let el = request.target ? find(request.target) : null;
      const val = request.value;
      if (el?.disabled) throw new Error('目标控件不可用');
      if (el) el.scrollIntoView({block:'center',inline:'nearest'});
      switch (request.kind) {
        case 'fill': {
          el.focus();
          if (el.isContentEditable) el.textContent = String(val);
          else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto,'value')?.set;
            if (!setter) throw new Error('该元素不支持文本填写');
            setter.call(el,String(val));
          }
          el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(val)}));
          el.dispatchEvent(new Event('change',{bubbles:true})); break;
        }
        case 'click': el.click(); break;
        case 'select':
          if (!(el instanceof HTMLSelectElement)) throw new Error('当前版本仅支持原生 select，自定义下拉请使用 click');
          if (![...el.options].some(o=>o.value === String(val))) throw new Error('没有匹配的选项');
          el.value=String(val); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); break;
        case 'check':
          if (!['checkbox','radio'].includes(el.type) || typeof val !== 'boolean') throw new Error('check 需要复选框/单选框与布尔值');
          if (el.checked !== val) el.click(); break;
        case 'press': {
          const allowed=['Enter','Tab','Escape','ArrowDown','ArrowUp','Backspace'];
          if (!allowed.includes(val)) throw new Error('不支持的按键');
          const active=el || document.activeElement;
          active.dispatchEvent(new KeyboardEvent('keydown',{key:val,bubbles:true})); active.dispatchEvent(new KeyboardEvent('keyup',{key:val,bubbles:true}));
          break;
        }
        case 'scroll': if (!Number.isFinite(Number(val))) throw new Error('滚动值必须是数字'); window.scrollBy(0,Number(val)); break;
        case 'assert_text': if (!(el ? text(el) : text(document.body)).includes(String(val))) throw new Error('页面文本未满足完成条件'); break;
        case 'assert_url': if (!location.href.includes(String(val))) throw new Error('页面网址未满足完成条件'); break;
        case 'assert_value': if (String(el.value) !== String(val)) throw new Error('字段值未满足完成条件'); break;
        case 'assert_visible': break;
        default: throw new Error('不支持的操作');
      }
      return JSON.stringify({ok:true,kind:request.kind,inputMode:'dom',verified:request.kind.startsWith('assert_'),sensitive:el?.type === 'password',url:location.href});
    } catch (e) { return JSON.stringify({ok:false,error:String(e.message || e),url:location.href}); }
  };
})()
