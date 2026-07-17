/**
 * Documents module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['documents'] = {
  children: [
      { id: 'bol', title: 'BOL' },
      { id: 'rate-confirmations', title: 'Rate Confirmations' },
      { id: 'pod', title: 'POD' },
      { id: 'insurance', title: 'Insurance' },
      { id: 'permits', title: 'Permits' },
      { id: 'files', title: 'Files' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Documents';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="documents">' +
      '  <nav class="gos-subnav" aria-label="Documents sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Documents — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['documents'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};