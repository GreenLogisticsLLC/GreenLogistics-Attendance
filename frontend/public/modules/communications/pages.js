/**
 * Communications module pages — placeholder UI with sub-nav.
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['communications'] = {
  children: [
      { id: 'emails', title: 'Emails' },
      { id: 'sms', title: 'SMS' },
      { id: 'internal-messages', title: 'Internal Messages' },
      { id: 'call-logs', title: 'Call Logs' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || children[0];
    var label = active ? active.title : 'Communications';

    var navHtml = children.map(function (c) {
      var isActive = active && c.id === active.id;
      return (
        '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
        c.title +
        '</button>'
      );
    }).join('');

    root.innerHTML =
      '<div class="gos-module-placeholder" data-module="communications">' +
      '  <nav class="gos-subnav" aria-label="Communications sections">' + navHtml + '</nav>' +
      '  <div class="gos-module-body">' +
      '    <h2>Communications — ' + label + '</h2>' +
      '    <p>Coming soon</p>' +
      '  </div>' +
      '</div>';

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.GreenOSModules['communications'].render(root, btn.getAttribute('data-subpage'));
      });
    });
  },
};