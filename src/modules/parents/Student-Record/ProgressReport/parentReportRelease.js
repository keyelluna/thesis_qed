// Parent release is separate from submission to the principal.
function isParentReportReleased({ isVisible, termEnded }) {
  return Number(isVisible) === 1 && Number(termEnded) === 1;
}
module.exports = { isParentReportReleased };
