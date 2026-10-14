// School-wide Principal readers follow the existing grade-sheet Admin/Principal
// policy. Shared class/staff metadata routes retain their separate contracts.
module.exports = function requireSchoolRead(req, res, next) {
  const { role, userId } = req.user ?? {};
  const allowed = typeof role === 'string' && ['ADMIN', 'PRINCIPAL'].includes(role.toUpperCase());
  const identity = ['string', 'number'].includes(typeof userId) && /^[1-9]\d*$/.test(String(userId)) && Number.isSafeInteger(Number(userId));
  if (!allowed || !identity) {
    return res.status(403).json({ success: false, message: 'Role not permitted.' });
  }
  return next();
};
