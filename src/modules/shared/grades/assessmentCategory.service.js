function assessmentCategoryForName(name) {
  const key = String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["writtenoralworkswws", "writtenoralworksww", "writtenworks", "writtenoralworks"].includes(key)) return "ww";
  if (["productperformancetaskspts", "productperformancetaskspt", "performancetasks", "performancetask"].includes(key)) return "pt";
  if (["examinationsexs", "examinationsex", "examinations", "exams", "quarterlyexam"].includes(key)) return "exam";
  return null;
}

module.exports = { assessmentCategoryForName };
