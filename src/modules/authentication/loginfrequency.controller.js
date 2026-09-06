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
  const { start, end } = getWeekRange(0);
  const { start: prevStart, end: prevEnd } = getWeekRange(1);

  const [rows] = await connection.execute(
    `SELECT DATE(login_time) AS d, COUNT(*) AS cnt
     FROM login_logs
     WHERE login_time >= ? AND login_time < ?
     GROUP BY DATE(login_time)`,
    [start, end],
  );

  const dayMap = new Map(rows.map((r) => [formatDate(r.d), r.cnt]));
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const chart = [];
  const cursor = new Date(start);
  for (let i = 0; i < 7; i++) {
    chart.push({ label: dayLabels[i], count: dayMap.get(formatDate(cursor)) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const [[{ cnt: prevTotal }]] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM login_logs WHERE login_time >= ? AND login_time < ?`,
    [prevStart, prevEnd],
  );

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const daysElapsed = Math.min(getDaysElapsedInWeek(), 7);
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
// MONTHLY — Jan-Dec ng kasalukuyang taon, ikukumpara sa nakaraang taon
// ---------------------------------------------------------------------
async function getMonthlyFrequency() {
  const now = new Date();
  const year = now.getFullYear();
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const prevStart = new Date(year - 1, 0, 1);
  const prevEnd = start;

  const [rows] = await connection.execute(
    `SELECT MONTH(login_time) AS m, COUNT(*) AS cnt
     FROM login_logs
     WHERE login_time >= ? AND login_time < ?
     GROUP BY MONTH(login_time)`,
    [start, end],
  );

  const monthMap = new Map(rows.map((r) => [r.m, r.cnt]));
  const monthLabels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const chart = monthLabels.map((label, i) => ({ label, count: monthMap.get(i + 1) || 0 }));

  const [[{ cnt: prevTotal }]] = await connection.execute(
    `SELECT COUNT(*) AS cnt FROM login_logs WHERE login_time >= ? AND login_time < ?`,
    [prevStart, prevEnd],
  );

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const monthsElapsed = now.getMonth() + 1;
  const averageDaily = round1(total / monthsElapsed);
  const growthPercent = computeGrowth(total, prevTotal);

  return {
    chart,
    summary: {
      peakLabel: peak.label,
      peakCount: peak.count,
      peakType: "Peak Month",
      averageDaily,
      averageLabel: "Avg. Monthly Logins",
      growthPercent,
      growthLabel: "Monthly Growth",
    },
  };
}

const START_YEAR = 2026; // taon kung saan nagsimula mag-log ang system

// ---------------------------------------------------------------------
// YEARLY — mula START_YEAR hanggang kasalukuyang taon, ikukumpara ang
// current year vs previous year
// ---------------------------------------------------------------------
async function getYearlyFrequency() {
  const now = new Date();
  const currentYear = now.getFullYear();
  // failsafe lang kung sakaling mauna pa ang server clock sa START_YEAR
  const endYear = Math.max(currentYear, START_YEAR);

  const start = new Date(START_YEAR, 0, 1);
  const end = new Date(endYear + 1, 0, 1);

  const [rows] = await connection.execute(
    `SELECT YEAR(login_time) AS y, COUNT(*) AS cnt
     FROM login_logs
     WHERE login_time >= ? AND login_time < ?
     GROUP BY YEAR(login_time)`,
    [start, end],
  );

  const yearMap = new Map(rows.map((r) => [r.y, r.cnt]));
  const chart = [];
  for (let y = START_YEAR; y <= endYear; y++) {
    chart.push({ label: String(y), count: yearMap.get(y) || 0 });
  }

  const total = sumCounts(chart);
  const peak = getPeak(chart);
  const averageDaily = round1(total / chart.length);

  const currentYearCount = yearMap.get(currentYear) || 0;
  const prevYearCount = yearMap.get(currentYear - 1) || 0;
  const growthPercent = computeGrowth(currentYearCount, prevYearCount);

  return {
    chart,
    summary: {
      peakLabel: peak.label,
      peakCount: peak.count,
      peakType: "Peak Year",
      averageDaily,
      averageLabel: "Avg. Yearly Logins",
      growthPercent,
      growthLabel: "Yearly Growth",
    },
  };
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function getWeekRange(weeksAgo = 0) {
  const now = new Date();
  const day = now.getDay(); // 0=Sun,1=Mon,...6=Sat
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - diffToMonday - weeksAgo * 7,
  );
  monday.setHours(0, 0, 0, 0);
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  return { start: monday, end };
}

function getDaysElapsedInWeek() {
  const day = new Date().getDay();
  return day === 0 ? 7 : day; // Mon=1 ... Sun=7
}

function formatDate(d) {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sumCounts(chart) {
  return chart.reduce((sum, c) => sum + c.count, 0);
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