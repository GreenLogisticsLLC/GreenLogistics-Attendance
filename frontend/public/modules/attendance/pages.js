/**
 * Attendance module pages stub.
 *
 * Live attendance UI stays in index.html (and existing app wiring).
 * Do not re-implement the live board, punch flows, or setup here.
 *
 * Future helpers (optional):
 * - navigateToAttendanceSubPage(subPageId) — live | reports | setup
 * - syncAttendanceShellState() — keep shell nav in sync with index.html panels
 */
window.GreenOSModules = window.GreenOSModules || {};
window.GreenOSModules['attendance'] = {
  render(root, subPageId) {
    // Attendance UI remains in index.html — this module only reserves the slot.
    if (root) {
      root.innerHTML = '<!-- Attendance UI lives in index.html -->';
    }
  },
};
