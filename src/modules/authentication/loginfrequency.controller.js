const connection = require("../../../config/db"); // mysql2 pool with .promise()

exports.getLoginFrequency = async (req, res) => {
  try {
    const period = (req.query.period || "weekly").toLowerCase();
    const allowedPeriods = ["weekly", "monthly", "yearly"];

    if (!allowedPeriods.includes(period)) {
      return res.status(400).json({
        message: `Invalid period. Must be one of: ${allowedPeriods.join(", ")}`,
      });
    }

    let result;
    switch (period) {
      case "weekly":
        result = await getWeeklyFrequency();
        break;
      case "monthly":
        result = await getMonthlyFrequency();
        break;
      case "yearly":
        result = await getYearlyFrequency();
        break;
    }

    return res.status(200).json({ period, ...result });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ---------------------------------------------------------------------
// WEEKLY — Mon-Sun ng kasalukuyang linggo, ikukumpara sa nakaraang linggo
// ---------------------------------------------------------------------
async function getWeeklyFrequency() {
  const today = getManilaDateKey();
  const startKey = startOfWeek(today);
  const endKey = shiftDateKey(startKey, 7);
  const prevStartKey = shiftDateKey(startKey, -7);
  const daysElapsed = Math.min(weekDayOffset(today) + 1, 7);
  const start = `${startKey} 00:00:00`;
  const end = `${endKey} 00:00:00`;
  const prevStart = `${prevStartKey} 00:00:00`;
  const prevEnd = `${shiftDateKey(prevStartKey, daysElapsed)} 00:00:00`;

  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(login_time, '%Y-%m-%d') AS d, COUNT(*) AS cnt
     FROM login_logs
     WHERE login_time >= ? AND login_time < ?
     GROUP BY DATE_FORMAT(login_time, '%Y-%m-%d')`,
    [start, end],
  );

  const dayMap = new Map(rows.map((r) => [formatDate(r.d), Number(r.cnt)]));
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const chart = [];
  for (let i = 0; i < 7; i++) {
    const dateKey = shiftDateKey(startKey, i);
    chart.push({ label: dayLabels[i], count: dayMap.get(dateKey) || 0 });
  }

  const [prevRows] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM login_logs WHERE login_time >= ? AND login_time < ?`,
    [prevStart, prevEnd],
  );
  const prevTotal = Number(prevRows[0]?.cnt || 0);

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const averageDaily = round1(total / daysElapsed);
  const growthPercent = computeGrowth(total, prevTotal);

  return {
    chart,
    summary: {
      peakLabel: peak.label,
      peakCount: peak.count,
      peakType: "Peak Day",
      averageDaily,
      averageLabel: "Avg. Daily Logins",
      growthPercent,
      growthLabel: "Weekly Growth",
    },
  };
}

// ---------------------------------------------------------------------
// MONTHLY — each day of the current Manila calendar month, compared with
// the same elapsed days of the previous calendar month.
// ---------------------------------------------------------------------
async function getMonthlyFrequency() {
  const today = getManilaDateKey();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startKey = `${year}-${String(month).padStart(2, "0")}-01`;
  const endKey = shiftDateKey(startKey, new Date(Date.UTC(year, month, 0)).getUTCDate());
  const previousMonthDate = new Date(Date.UTC(year, month - 2, 1));
  const prevStartKey = `${previousMonthDate.getUTCFullYear()}-${String(previousMonthDate.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const daysElapsed = Number(today.slice(8, 10));
  const daysInPreviousMonth = new Date(Date.UTC(previousMonthDate.getUTCFullYear(), previousMonthDate.getUTCMonth() + 1, 0)).getUTCDate();
  const prevEndKey = shiftDateKey(prevStartKey, Math.min(daysElapsed, daysInPreviousMonth));
  const start = `${startKey} 00:00:00`;
  const end = `${endKey} 00:00:00`;
  const prevStart = `${prevStartKey} 00:00:00`;
  const prevEnd = `${prevEndKey} 00:00:00`;

  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(login_time, '%Y-%m-%d') AS d, COUNT(*) AS cnt
     FROM login_logs
     WHERE login_time >= ? AND login_time < ?
     GROUP BY DATE_FORMAT(login_time, '%Y-%m-%d')`,
    [start, end],
  );

  const dayMap = new Map(rows.map((r) => [formatDate(r.d), Number(r.cnt)]));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const chart = Array.from({ length: daysInMonth }, (_, i) => {
    const dateKey = shiftDateKey(startKey, i);
    return { label: String(i + 1), count: dayMap.get(dateKey) || 0 };
  });

  const [prevRows] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM login_logs WHERE login_time >= ? AND login_time < ?`,
    [prevStart, prevEnd],
  );
  const prevTotal = Number(prevRows[0]?.cnt || 0);

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const averageDaily = round1(total / daysElapsed);
  const growthPercent = computeGrowth(total, prevTotal);

  return {
    chart,
    summary: {
      peakLabel: peak.label,
      peakCount: peak.count,
      peakType: "Peak Day",
      averageDaily,
      averageLabel: "Avg. Daily Logins",
      growthPercent,
      growthLabel: "Monthly Growth",
    },
  };
}

// ---------------------------------------------------------------------
// YEARLY — Jan-Dec of the current Manila calendar year, compared to the
// the same elapsed period of the previous calendar year. No arbitrary start
// year: all actual historical login rows remain available for comparisons.
// ---------------------------------------------------------------------
async function getYearlyFrequency() {
  const currentYear = Number(getManilaDateKey().slice(0, 4));
  const today = getManilaDateKey();
  const start = `${currentYear - 1}-01-01 00:00:00`;
  const currentEnd = `${shiftDateKey(today, 1)} 00:00:00`;
  const previousYear = currentYear - 1;
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const previousYearMonthDays = new Date(Date.UTC(previousYear, month, 0)).getUTCDate();
  const previousYearDate = `${previousYear}-${today.slice(5, 7)}-${String(Math.min(day, previousYearMonthDays)).padStart(2, "0")}`;
  const previousEnd = `${shiftDateKey(previousYearDate, 1)} 00:00:00`;

  const [rows] = await connection.execute(
    `SELECT YEAR(login_time) AS y, MONTH(login_time) AS m, COUNT(*) AS cnt
     FROM login_logs
     WHERE (login_time >= ? AND login_time < ?)
        OR (login_time >= ? AND login_time < ?)
     GROUP BY YEAR(login_time), MONTH(login_time)`,
    [start, previousEnd, `${currentYear}-01-01 00:00:00`, currentEnd],
  );

  const monthMap = new Map(rows
    .filter((r) => Number(r.y) === currentYear)
    .map((r) => [Number(r.m), Number(r.cnt)]));
  const previousYearCount = rows
    .filter((r) => Number(r.y) === currentYear - 1)
    .reduce((sum, r) => sum + Number(r.cnt), 0);
  const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const chart = monthLabels.map((label, i) => ({ label, count: monthMap.get(i + 1) || 0 }));

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const currentMonth = Number(getManilaDateKey().slice(5, 7));
  const averageDaily = round1(total / currentMonth);

  const growthPercent = computeGrowth(total, previousYearCount);

  return {
    chart,
    summary: {
      peakLabel: peak.label,
      peakCount: peak.count,
      peakType: "Peak Month",
      averageDaily,
      averageLabel: "Avg. Monthly Logins",
      growthPercent,
      growthLabel: "Yearly Growth",
    },
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatDate(d) {
  return String(d).slice(0, 10);
}

function getManilaDateKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekDayOffset(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
}

function startOfWeek(dateKey) {
  return shiftDateKey(dateKey, -weekDayOffset(dateKey));
}

function sumCounts(chart) {
  return chart.reduce((sum, c) => sum + Number(c.count || 0), 0);
}

function getPeak(chart) {
  let best = { label: null, count: 0 };
  for (const c of chart) {
    if (c.count > best.count) best = { label: c.label, count: c.count };
  }
  if (best.label === null && chart.length > 0) {
    best.label = chart[0].label; // walang data pa, default sa unang label
  }
  return best;
}

function computeGrowth(current, previous) {
  if (!previous || previous === 0) {
    return current > 0 ? 100 : 0;
  }
  return round1(((current - previous) / previous) * 100);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
