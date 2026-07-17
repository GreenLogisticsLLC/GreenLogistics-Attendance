/**
 * Reports module — architecture cards (demo only).
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['reports'] = {
  children: [
    { id: 'revenue', title: 'Revenue' },
    { id: 'attendance', title: 'Attendance' },
    { id: 'employee-performance', title: 'Employee Performance' },
    { id: 'broker-performance', title: 'Broker Performance' },
    { id: 'carrier-performance', title: 'Carrier Performance' },
    { id: 'customer-statistics', title: 'Customer Statistics' },
  ],

  render(root, subPageId) {
    if (!root) return;
    var children = this.children || [];
    var active = children.find(function (c) { return c.id === subPageId; }) || null;

    if (active) {
      root.innerHTML =
        '<div class="gos-module-placeholder" data-module="reports">' +
        '  <nav class="gos-subnav" aria-label="Reports sections">' +
        children.map(function (c) {
          var isActive = c.id === active.id;
          return (
            '<button type="button" class="gos-subnav-item' + (isActive ? ' is-active' : '') + '" data-subpage="' + c.id + '">' +
            c.title +
            '</button>'
          );
        }).join('') +
        '  </nav>' +
        '  <div class="gos-module-body">' +
        '    <h2>Reports — ' + active.title + '</h2>' +
        '    <p class="gos-muted">Coming Soon</p>' +
        '  </div>' +
        '</div>';
    } else {
      root.innerHTML =
        '<section class="gos-dash-hero">' +
        '<h1>Reports Module</h1>' +
        '<p>Coming Soon — analytics cards prepared for future data sources.</p>' +
        '</section>' +
        '<section class="gos-card-grid">' +
        children.map(function (c) {
          return (
            '<button type="button" class="gos-card" data-subpage="' + c.id + '" style="cursor:pointer;text-align:left">' +
            '<div class="label">Report</div>' +
            '<div class="value" style="font-size:1.15rem">' + c.title + '</div>' +
            '<div class="hint">Coming Soon</div>' +
            '</button>'
          );
        }).join('') +
        '</section>';
    }

    root.querySelectorAll('[data-subpage]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (window.GreenOS && typeof window.GreenOS.navigate === 'function') {
          window.GreenOS.navigate('reports', btn.getAttribute('data-subpage'));
        } else {
          window.GreenOSModules['reports'].render(root, btn.getAttribute('data-subpage'));
        }
      });
    });
  },
};
