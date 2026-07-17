/**
 * Loads module — coming soon placeholder.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['loads'] = {
  render(root, subPageId) {
    if (!root) return;
    root.innerHTML = [
      '<div class="gos-module-placeholder">',
      '  <h2>Loads</h2>',
      '  <p>Coming soon</p>',
      '</div>',
    ].join('\n');
  },
};
