/**
 * Pure helpers mirroring dispatch extra-stop Window restore logic.
 * Keep in sync with extraStopApptIso / hhmmFromTimeLabel in pages.js.
 */
import assert from "node:assert/strict";
import test from "node:test";

function ampmPartsFromRaw(raw) {
  var s = String(raw || "").trim();
  var ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  if (!ampm) return { h: "", m: "", p: "" };
  return { h: String(parseInt(ampm[1], 10)), m: ampm[2], p: ampm[3].toUpperCase() };
}

function hhmmFromTimeLabel(raw) {
  var parts = ampmPartsFromRaw(raw);
  if (!parts.h || !parts.m || !parts.p) return "";
  var h12 = parseInt(parts.h, 10);
  var h24 = h12 % 12;
  if (parts.p === "PM") h24 += 12;
  return String(h24).padStart(2, "0") + ":" + String(parts.m).padStart(2, "0");
}

function combineDateTime(dateStr, timeStr) {
  if (!dateStr) return null;
  var t = timeStr && String(timeStr).trim() ? String(timeStr).trim() : "00:00";
  if (t.length === 5) t += ":00";
  var d = new Date(String(dateStr) + "T" + t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function extraStopApptIso(stop) {
  var dateVal = String((stop && stop.date) || "").trim();
  var fromSaved = stop && stop.from ? String(stop.from) : "";
  var toSaved = stop && stop.to ? String(stop.to) : "";
  if (fromSaved || toSaved) {
    return { from: fromSaved || null, to: toSaved || null };
  }
  var timeLabel = String((stop && stop.time) || "").trim();
  if (!dateVal || !timeLabel) return { from: null, to: null };
  var before = timeLabel.match(/^before\s+(.+)$/i);
  if (before) {
    return { from: null, to: combineDateTime(dateVal, hhmmFromTimeLabel(before[1].trim()) || "00:00") };
  }
  var till = timeLabel.match(/^till\s+(.+)$/i);
  if (till) {
    return {
      from: combineDateTime(dateVal, "00:00"),
      to: combineDateTime(dateVal, hhmmFromTimeLabel(till[1].trim()) || "00:00"),
    };
  }
  var windowBits = timeLabel.split(/\s*[–—-]\s*/);
  if (windowBits.length === 2) {
    var fromHh = hhmmFromTimeLabel(windowBits[0].trim());
    var toHh = hhmmFromTimeLabel(windowBits[1].trim());
    return {
      from: combineDateTime(dateVal, fromHh || "00:00"),
      to: combineDateTime(dateVal, toHh || fromHh || "00:00"),
    };
  }
  return { from: combineDateTime(dateVal, hhmmFromTimeLabel(timeLabel) || "00:00"), to: null };
}

test("hhmmFromTimeLabel parses AM/PM", () => {
  assert.equal(hhmmFromTimeLabel("8:00 AM"), "08:00");
  assert.equal(hhmmFromTimeLabel("4:00 PM"), "16:00");
});

test("extraStopApptIso restores Window from label", () => {
  var appt = extraStopApptIso({
    date: "2026-11-09",
    time: "8:00 AM – 4:00 PM",
  });
  assert.ok(appt.from);
  assert.ok(appt.to);
  assert.notEqual(appt.from, appt.to);
});

test("extraStopApptIso prefers saved from/to", () => {
  var appt = extraStopApptIso({
    date: "2026-11-09",
    time: "ignored",
    from: "2026-11-09T08:00:00.000Z",
    to: "2026-11-09T16:00:00.000Z",
  });
  assert.equal(appt.from, "2026-11-09T08:00:00.000Z");
  assert.equal(appt.to, "2026-11-09T16:00:00.000Z");
});
