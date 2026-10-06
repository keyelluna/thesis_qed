function calculateOfficialGrade({ ww, pt, exam, weights, examinations, transmutationTable }) {
  const required = [];
  if (Number(weights?.ww) > 0) required.push(ww);
  if (Number(weights?.pt) > 0) required.push(pt);
  if (examinations?.enabled && Number(weights?.exam) > 0) required.push(exam);

  const complete = required.length > 0 && required.every((category) =>
    category?.isComplete === true && Number.isFinite(Number(category.ws))
  );
  if (!complete) return { isComplete: false, initialGrade: null, termGrade: null };

  const initialGrade = required.reduce((sum, category) => sum + Number(category.ws), 0);
  const match = (transmutationTable || []).find((row) =>
    initialGrade >= Number(row.igMin) && initialGrade <= Number(row.igMax)
  );
  const termGrade = match && Number.isFinite(Number(match.transmuted)) ? Number(match.transmuted) : null;
  return { isComplete: termGrade !== null, initialGrade, termGrade };
}

function descriptorForGrade(structure, termGrade) {
  if (termGrade === null || termGrade === undefined) return null;
  const row = structure?.descriptorTable?.find((entry) => Number(entry.numericalGrade) === Number(termGrade));
  return row?.descriptor ?? null;
}

module.exports = { calculateOfficialGrade, descriptorForGrade };
