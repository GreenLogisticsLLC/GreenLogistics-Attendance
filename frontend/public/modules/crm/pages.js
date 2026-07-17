/**
 * CRM module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['crm'] = {
  children: [
      { id: 'leads', title: 'Leads' },
      { id: 'customers', title: 'Customers' },
      { id: 'quotes', title: 'Quotes' },
      { id: 'opportunities', title: 'Opportunities' },
      { id: 'tasks', title: 'Tasks' },
      { id: 'notes', title: 'Notes' },
      { id: 'activity', title: 'Activity' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'CRM';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="crm">' +
      '  <nav class="gos-subnav" aria-label="CRM sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>CRM — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['crm'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};