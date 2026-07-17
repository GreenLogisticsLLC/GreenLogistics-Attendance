/**
 * Accounting module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['accounting'] = {
  children: [
      { id: 'income', title: 'Income' },
      { id: 'expenses', title: 'Expenses' },
      { id: 'customer-payments', title: 'Customer Payments' },
      { id: 'carrier-payments', title: 'Carrier Payments' },
      { id: 'payroll', title: 'Payroll' },
      { id: 'profit-loss', title: 'Profit & Loss' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Accounting';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="accounting">' +
      '  <nav class="gos-subnav" aria-label="Accounting sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Accounting — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['accounting'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};