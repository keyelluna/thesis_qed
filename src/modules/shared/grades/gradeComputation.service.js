function calculateOfficialGrade({ ww, pt, exam, weights, examinations, transmutationTable, transmutationMode }) {
  const required = [];
  if (Number(weights?.ww) > 0) required.push(ww);
  if (Number(weights?.pt) > 0) required.push(pt);
  if (examinations?.enabled && Number(weights?.exam) > 0) required.push(exam);

  const complete = required.length > 0 && required.every((category) =>
    category?.isComplete === true && Number.isFinite(Number(category.ws))
  );
  if (!complete) return { isComplete: false, initialGrade: null, termGrade: null };

  const initialGrade = required.reduce((sum, category) => sum + Number(category.ws), 0);
  const table = transmutationTable || [];
  const match = table.find((row) =>
    initialGrade >= Number(row.igMin) && (transmutationMode === "descendingMinimum" || initialGrade <= Number(row.igMax))
  ) ?? (transmutationMode === "descendingMinimum" ? undefined : table.find((row) =>
    // Match the workbook's lower band within two-decimal HELPER range gaps.
    // Larger gaps remain invalid rather than inventing missing grading rules.
    initialGrade > Number(row.igMax) && table.some((next) =>
      Number(next.igMin) > Number(row.igMax) &&
      Number(next.igMin) - Number(row.igMax) <= 0.010000001 &&
      initialGrade < Number(next.igMin)
    )
  ));
  const termGrade = match && Number.isFinite(Number(match.transmuted)) ? Number(match.transmuted) : null;
  return { isComplete: termGrade !== null, initialGrade, termGrade };
}

function descriptorForGrade(structure, termGrade) {
  if (termGrade === null || termGrade === undefined) return null;
  const row = structure?.descriptorTable?.find((entry) => Number(entry.numericalGrade) === Number(termGrade));
  return row?.descriptor ?? null;
}

module.exports = { calculateOfficialGrade, descriptorForGrade };
