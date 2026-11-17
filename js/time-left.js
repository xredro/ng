/* Time left on a subscription: whole days while there is at least a day, then hours, then "less than an hour".
   Shared by the dashboard and Settings so both always say the same thing. */
function xrTimeLeft(ms) {
  const DAY = 86400000, HOUR = 3600000;
  if (!(ms > 0)) return { text: "Expired", hours: 0, days: 0, underDay: false, expired: true };
  if (ms >= DAY) { const d = Math.ceil(ms / DAY); return { text: `${d} ${d === 1 ? "day" : "days"}`, hours: Math.ceil(ms / HOUR), days: d, underDay: false, expired: false }; }
  const h = Math.ceil(ms / HOUR);
  return { text: ms < HOUR ? "less than an hour" : `${h} ${h === 1 ? "hour" : "hours"}`, hours: h, days: 1, underDay: true, expired: false };
}
