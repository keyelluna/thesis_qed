function normalizeExaminations(structure, categoryWeightPercent) {
  if (structure?.examinations && typeof structure.examinations.enabled === "boolean") {
    return structure.examinations;
  }
  if (structure?.examSubWeights && typeof structure.examSubWeights === "object") {
    const weights = structure.examSubWeights;
    const components = ["st1", "st2", "te"]
      .filter((key) => Number.isFinite(Number(weights[key])))
      .map((key) => ({ key: key.toUpperCase(), label: key.toUpperCase(), weightPercent: Number(weights[key]) }));
    return { enabled: components.length > 0, categoryWeightPercent: Number(structure.examWeightPercent ?? categoryWeightPercent ?? 0), components };
  }
  if (Number(categoryWeightPercent) > 0) {
    return { enabled: true, categoryWeightPercent: Number(categoryWeightPercent), components: [{ key: "ALL", label: "Examinations", weightPercent: 100 }] };
  }
  return { enabled: false, categoryWeightPercent: 0, components: [] };
}

module.exports = { normalizeExaminations };
