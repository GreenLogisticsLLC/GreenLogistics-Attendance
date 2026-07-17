/**
 * Invoices module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['invoices'] = {
  children: [
      { id: 'customer-invoices', title: 'Customer Invoices' },
      { id: 'carrier-bills', title: 'Carrier Bills' },
      { id: 'payments', title: 'Payments' },
      { id: 'outstanding-balances', title: 'Outstanding Balances' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Invoices';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="invoices">' +
      '  <nav class="gos-subnav" aria-label="Invoices sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Invoices — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['invoices'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};