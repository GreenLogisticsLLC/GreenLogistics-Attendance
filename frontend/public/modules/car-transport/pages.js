/**
 * Car Transport module — coming soon placeholder.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['car-transport'] = {
  render(root, subPageId) {
    if (!root) return;
    root.innerHTML = [
      '<div class="gos-module-placeholder">',
      '  <h2>Car Transport</h2>',
      '  <p>Coming soon</p>',
      '</div>',
    ].join('\n');
  },
};
