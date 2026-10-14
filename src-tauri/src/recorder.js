(() => {
  if (window !== window.top || window.__AUTO_BROWSER_RECORDER__) return;
  let recordingId = null,
    actor = "user",
    stopping = false;
  const pending = new Set(),
    edits = new Map();
  const cut = (v, n = 2000) => String(v ?? "").slice(0, n);
  const invoke = (message) =>
    window.__TAURI_INTERNALS__.invoke("page_message", { message });
  function rendered() {
    if (!window.__TAURI_INTERNALS__) return;
    const url = location.href;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      clearTimeout(fallback);
      invoke({ kind: "page_rendered", url }).catch((e) =>
        console.error("Auto Browser page readiness unavailable", e),
      );
    };
    // Hidden WebViews may suspend animation frames even after DOM initialization.
    const fallback = setTimeout(report, 150);
    requestAnimationFrame(() => requestAnimationFrame(report));
  }
  const visible = (el) =>
    !!(
      el.getClientRects().length && getComputedStyle(el).visibility !== "hidden"
    );
  const label = (el) =>
    cut(
      el.getAttribute("aria-label") ||
        el.labels?.[0]?.innerText ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        el.name ||
        "",
      160,
    );
  function target(el) {
    return {
      tag: el.tagName.toLowerCase(),
      type:
        typeof el.type === "string" ? el.type : el.getAttribute("type") || "",
      label: label(el),
      name: cut(el.getAttribute("name"), 80),
      selector: el.id
        ? "#" + CSS.escape(el.id)
        : el.name
          ? `${el.tagName.toLowerCase()}[name=${JSON.stringify(el.name)}]`
          : el.tagName.toLowerCase(),
    };
  }
  function value(el) {
    if (el.type === "password") return "[redacted]";
    if (el.type === "file") return [...(el.files || [])].map((f) => f.name);
    if (["checkbox", "radio"].includes(el.type)) return el.checked;
    return cut(el.value ?? el.innerText);
  }
  function context() {
    // Keep a bounded DOM context; password input values are redacted separately.
    return {
      pageUrl: location.href,
      title: cut(document.title, 200),
      text: cut(document.body?.innerText),
      fields: [
        ...document.querySelectorAll(
          "input,select,textarea,[contenteditable=true]",
        ),
      ]
        .filter(visible)
        .slice(0, 30)
        .map((el) => ({
          ...target(el),
          value:
            typeof value(el) === "string" ? cut(value(el), 500) : value(el),
        })),
    };
  }
  let lastError = null;
  let previous;
  function send(event) {
    if (!recordingId) return;
    const task = invoke({
      kind: "record",
      recordingId,
      event: {
        at: new Date().toISOString(),
        actor,
        pageUrl: location.href,
        ...event,
      },
    });
    pending.add(task);
    task
      .catch((e) => {
        lastError = String(e);
        console.error("Auto Browser recording delivery failed", e);
      })
      .finally(() => pending.delete(task));
  }
  function emit(kind, extra = {}, before = previous) {
    const after = context();
    send({
      kind,
      beforeContext: before || after,
      afterContext: after,
      ...extra,
    });
    previous = after;
  }
  function flushEdits() {
    for (const [el, edit] of edits) {
      clearTimeout(edit.timer);
      emit("input", { target: target(el), value: value(el) }, edit.before);
    }
    edits.clear();
  }
  function accepted(event) {
    return recordingId && !stopping && (event.isTrusted || actor === "agent");
  }
  const api = {
    status() {
      return { recordingId, lastError, pending: pending.size };
    },
    configure(id) {
      recordingId = id;
      stopping = false;
      previous = context();
      if (id) emit("page_context");
    },
    setActor(value) {
      actor = value;
    },
    async stop() {
      if (!recordingId || stopping) return;
      stopping = true;
      flushEdits();
      emit("recording_end");
      const id = recordingId;
      await Promise.allSettled([...pending]);
      await invoke({ kind: "recording_stopped", recordingId: id });
      recordingId = null;
      stopping = false;
    },
  };
  Object.defineProperty(window, "__AUTO_BROWSER_RECORDER__", { value: api });
  document.addEventListener(
    "input",
    (event) => {
      if (!accepted(event)) return;
      const el = event.target;
      if (!(el instanceof Element)) return;
      const old = edits.get(el);
      if (old) clearTimeout(old.timer);
      const edit = {
        before: old?.before || previous,
        timer: setTimeout(() => {
          edits.delete(el);
          emit("input", { target: target(el), value: value(el) }, edit.before);
        }, 350),
      };
      edits.set(el, edit);
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (!accepted(event)) return;
      const el = event.target;
      if (!(el instanceof Element)) return;
      const edit = edits.get(el);
      if (edit) {
        clearTimeout(edit.timer);
        edits.delete(el);
      }
      emit("change", { target: target(el), value: value(el) }, edit?.before);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!accepted(event)) return;
      flushEdits();
      const el =
        event.target instanceof Element
          ? event.target.closest("a,button,input,label,[role=button]") ||
            event.target
          : null;
      if (!el) return;
      emit("click", { target: target(el), button: event.button });
      setTimeout(() => {
        if (recordingId && !stopping) emit("page_change");
      }, 120);
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      if (accepted(event)) {
        flushEdits();
        emit("submit", { target: target(event.target) });
      }
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (!accepted(event) || !["Enter", "Tab", "Escape"].includes(event.key))
        return;
      flushEdits();
      emit("key", { key: event.key, target: target(event.target) });
    },
    true,
  );
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      rendered();
      if (recordingId) {
        flushEdits();
        emit("navigation", { navigationKind: method });
      }
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    rendered();
    if (recordingId) emit("navigation", { navigationKind: "popstate" });
  });
  window.addEventListener("hashchange", rendered);
  window.addEventListener("pagehide", () => {
    if (recordingId) {
      flushEdits();
      emit("page_leave");
    }
  });
  let changeTimer;
  new MutationObserver(() => {
    if (!recordingId || stopping) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (recordingId && !stopping) {
        const after = context();
        if (JSON.stringify(after) !== JSON.stringify(previous))
          emit("page_change");
      }
    }, 350);
  }).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "value",
      "class",
      "aria-invalid",
      "aria-expanded",
      "hidden",
    ],
  });
  function ready(attempt = 0) {
    if (!window.__TAURI_INTERNALS__) {
      if (attempt < 30) setTimeout(() => ready(attempt + 1), 100);
      return;
    }
    invoke({ kind: "recorder_ready" })
      .then((result) => {
        if (recordingId === null && result.recordingId)
          api.configure(result.recordingId);
        // Prefer rendered frames, with a timer fallback for hidden pages.
        rendered();
      })
      .catch((e) => console.error("Auto Browser recorder unavailable", e));
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => ready(), {
      once: true,
    });
  else ready();
})();
