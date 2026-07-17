/**
 * Employees module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['employees'] = {
  children: [
      { id: 'employees', title: 'Employees' },
      { id: 'departments', title: 'Departments' },
      { id: 'positions', title: 'Positions' },
      { id: 'schedules', title: 'Schedules' },
      { id: 'payroll', title: 'Payroll' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Employees';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="employees">' +
      '  <nav class="gos-subnav" aria-label="Employees sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Employees — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['employees'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};