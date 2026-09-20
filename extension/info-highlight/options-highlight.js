(() => {
  const KEY = 'ih_highlight_options_page';
  const box = document.getElementById(KEY);
  if (!box) throw new Error('options page missing ih_highlight_options_page');
  const api = window.__IH_DEMO__;
  if (typeof api?.setEnabled !== 'function') {
    throw new Error('__IH_DEMO__.setEnabled missing — inject content.js first');
  }
  if (!globalThis.IH_optionsPageReady) {
    throw new Error('IH_optionsPageReady missing — inject options.js first');
  }

  function sync() {
    api.setEnabled(box.checked);
  }

  box.addEventListener('change', sync);
  void globalThis.IH_optionsPageReady.then(sync);
})();
