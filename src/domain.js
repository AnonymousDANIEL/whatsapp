'use strict';
const { DateTime } = require('luxon');
const { parsePhoneNumberFromString } = require('libphonenumber-js/max');
const crypto = require('node:crypto');

const PERMISSIONS = ['tasks.create', 'reports.export'];
function assert(ok, message, code = 400) {
  if (!ok) throw Object.assign(new Error(message), { status: code });
}
function normalizePhone(raw, country = 'MY') {
  const value = String(raw).trim();
  if (!/^[+\d\s()\-]+$/.test(value)) return null;
  const phone = parsePhoneNumberFromString(value, country);
  return phone?.isValid() ? phone.number : null;
}
function parseRecipients(text, country = 'MY') {
  assert(typeof text === 'string' && text.length <= 500000, '号码列表过长');
  const rows = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  assert(rows.length > 0 && rows.length <= 10000, '每个任务需要 1–10000 个号码');
  const seen = new Set();
  let duplicates = 0;
  const recipients = [];
  for (const raw of rows) {
    const phone = normalizePhone(raw, country);
    const key = phone || raw;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key);
    recipients.push({ raw: raw.slice(0, 100), phone, status: phone ? 'pending' : 'invalid', error: phone ? null : 'INVALID_FORMAT' });
  }
  return { recipients, duplicates };
}
function validateSchedule(body) {
  const timezone = body.timezone || 'Asia/Kuala_Lumpur';
  assert(DateTime.now().setZone(timezone).isValid, '时区无效');
  for (const field of ['window_start', 'window_end']) assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(body[field]), '时间格式必须为 HH:mm');
  const weekdays = body.weekdays || [1, 2, 3, 4, 5, 6, 7];
  assert(Array.isArray(weekdays) && weekdays.length && weekdays.every(d => Number.isInteger(d) && d >= 1 && d <= 7), '星期无效');
  const scheduled_at = body.scheduled_at ? DateTime.fromISO(body.scheduled_at, { zone: timezone }).toUTC() : DateTime.utc();
  const expires_at = body.expires_at ? DateTime.fromISO(body.expires_at, { zone: timezone }).toUTC() : null;
  assert(scheduled_at.isValid && (!expires_at || (expires_at.isValid && expires_at > scheduled_at)), '开始/截止日期无效');
  const interval_ms = Number(body.interval_ms || 10000);
  assert(Number.isInteger(interval_ms) && interval_ms >= 5000 && interval_ms <= 3600000, '发送间隔需要在 5 秒–1 小时之间');
  return { timezone, window_start: body.window_start, window_end: body.window_end, weekdays: [...new Set(weekdays)], scheduled_at: scheduled_at.toISO(), expires_at: expires_at?.toISO() || null, interval_ms };
}
function inWindow(job, instant = new Date()) {
  if (!job.enabled || +instant < +new Date(job.scheduled_at) || (job.expires_at && +instant >= +new Date(job.expires_at))) return false;
  const dt = DateTime.fromJSDate(instant).setZone(job.timezone);
  if (!dt.isValid) return false;
  const time = dt.toFormat('HH:mm');
  const start = job.window_start.slice(0, 5), end = job.window_end.slice(0, 5);
  if (start === end) return job.weekdays.includes(dt.weekday); // 24 hours on selected days
  if (start < end) return job.weekdays.includes(dt.weekday) && time >= start && time < end;
  // A Monday 22:00–02:00 window includes Tuesday 01:00.
  const day = time < end ? dt.minus({ days: 1 }).weekday : dt.weekday;
  return job.weekdays.includes(day) && (time >= start || time < end);
}
function canDispatch(job, instant = new Date()) {
  if (!job.enabled || job.cancelled) return false;
  // Manual immediate runs keep the saved schedule and only bypass its time gates.
  return job.send_now === true || inWindow(job, instant);
}
function ackStatus(ack) {
  if (ack === -1) return 'failed';
  if (ack >= 3) return 'read';
  if (ack >= 2) return 'delivered';
  if (ack >= 1) return 'submitted';
  return 'awaiting_ack';
}
function permission(user, name) { return ['owner','user'].includes(user.role) && PERMISSIONS.includes(name); }
function manageUser(actor, target) {
  return actor.role === 'owner' && target.role !== 'owner';
}
function csvCell(value) { return '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'; }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
module.exports = { PERMISSIONS, assert, parseRecipients, validateSchedule, inWindow, canDispatch, ackStatus, permission, manageUser, csvCell, hash };
