/**
 * 选项页：未看过的 [data-option-id] 打蓝点；足够可见并停留一会后才消除。
 * 「足够」= 可见比例 ≥ 50%，或已经尽视口所能（顶/底再也滚不出更多）。
 * setPaused(true)：被遮挡（如 Prepare 窗）时不算看见——清计时、不记 seen。
 * 依赖 IL_optionsAttention、IL_OPTIONS_CATALOG。与工具栏蓝点无关。
 */
(() => {
  const attention = globalThis.IL_optionsAttention;
  const catalog = globalThis.IL_OPTIONS_CATALOG;
  if (!attention) throw new Error('IL_optionsAttention missing');
  if (!Array.isArray(catalog)) throw new Error('IL_OPTIONS_CATALOG missing');

  const CLASS = 'option-is-new';
  /** 足够可见后需再停留多久才算看过（避免一打开首屏蓝点瞬间消失） */
  const DWELL_MS = 3000;

  let paused = false;
  /** @type {null | { applyPaused: () => void }} */
  let session = null;

  function rowFor(id) {
    const el = document.querySelector(`[data-option-id="${CSS.escape(id)}"]`);
    if (!el) throw new Error(`options page missing data-option-id=${id}`);
    return el;
  }

  function paint(unseen) {
    const set = new Set(unseen);
    for (const id of catalog) {
      rowFor(id).classList.toggle(CLASS, set.has(id));
    }
  }

  /** 一半可见，或在顶/底已无法再露出更多时也算「足够可见」 */
  function enoughVisible(entry) {
    if (entry.intersectionRatio >= 0.5) return true;
    if (!entry.isIntersecting) return false;
    const root = entry.rootBounds;
    if (!root) return entry.intersectionRatio > 0;
    const maxPossible = Math.min(entry.boundingClientRect.height, root.height);
    return entry.intersectionRect.height >= maxPossible - 1;
  }

  function observe(unseen) {
    if (!unseen.length) return;
    const pending = new Set(unseen);
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    const timers = new Map();

    function clearTimer(id) {
      const t = timers.get(id);
      if (t == null) return;
      clearTimeout(t);
      timers.delete(id);
    }

    function clearAllTimers() {
      for (const id of [...timers.keys()]) clearTimer(id);
    }

    function commit(id, el) {
      if (paused || !pending.has(id)) return;
      pending.delete(id);
      clearTimer(id);
      el.classList.remove(CLASS);
      io.unobserve(el);
      void attention.markSeen([id], catalog);
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-option-id');
          if (!id || !pending.has(id)) continue;
          if (paused || !enoughVisible(entry)) {
            clearTimer(id);
            continue;
          }
          if (timers.has(id)) continue;
          timers.set(
            id,
            setTimeout(() => commit(id, entry.target), DWELL_MS),
          );
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    function reobserve() {
      for (const id of pending) {
        const el = rowFor(id);
        io.unobserve(el);
        io.observe(el);
      }
    }

    session = {
      applyPaused() {
        if (paused) clearAllTimers();
        else reobserve();
      },
    };

    for (const id of unseen) io.observe(rowFor(id));
    if (paused) clearAllTimers();
  }

  globalThis.IL_optionsNewDots = {
    setPaused(next) {
      const on = !!next;
      if (on === paused) return;
      paused = on;
      session?.applyPaused();
    },
  };

  void attention.unseen(catalog).then((unseen) => {
    paint(unseen);
    observe(unseen);
  });
})();
