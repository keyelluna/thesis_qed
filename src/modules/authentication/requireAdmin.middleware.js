// Authorization always uses the verified caller, never the target role in a body.
module.exports = function requireAdmin(req, res, next) {
  const role = typeof req.user?.role === "string" ? req.user.role.toUpperCase() : "";
  if (role !== "ADMIN") {
    return res.status(403).json({ success: false, message: "Administrator access is required." });
  }
  return next();
};
