/**
 * Dispatch module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['dispatch'] = {
  children: [
      { id: 'active-loads', title: 'Active Loads' },
      { id: 'completed-loads', title: 'Completed Loads' },
      { id: 'carriers', title: 'Carriers' },
      { id: 'available-trucks', title: 'Available Trucks' },
      { id: 'tracking', title: 'Tracking' },
      { id: 'documents', title: 'Documents' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Dispatch';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="dispatch">' +
      '  <nav class="gos-subnav" aria-label="Dispatch sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Dispatch — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['dispatch'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};