// Formal grades reach parents only after all three release conditions are met.
function isParentReportReleased({ isVisible, termEnded, approved }) {
  return Number(isVisible) === 1 && Number(termEnded) === 1 && approved === true;
}
module.exports = { isParentReportReleased };
