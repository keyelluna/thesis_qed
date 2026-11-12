const { listAuditLogs, removeAuditLog } = require("../../shared/audit/auditLog.service");

exports.getAuditLogs = async (req, res) => {
  try {
    const role = String(req.query.role || "").toUpperCase();
    const action = String(req.query.action || "").toUpperCase();
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
      return res.status(400).json({ success: false, message: "Date filters must use YYYY-MM-DD." });
    }
    const data = await listAuditLogs({
      page: req.query.page,
      limit: req.query.limit,
      search: String(req.query.search || "").trim().slice(0, 150),
      role,
      action,
      from,
      to,
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Failed to load audit logs:", error);
    return res.status(500).json({ success: false, message: "Unable to load audit logs." });
  }
};

exports.deleteAuditLog = async (req, res) => {
  const { id } = req.params;
  if (!/^-?[1-9]\d{0,19}$/.test(id) || BigInt(id.replace("-", "")) > 18446744073709551615n) {
    return res.status(400).json({ success: false, message: "Invalid audit log ID." });
  }
  try {
    await removeAuditLog(id, req.user.userId);
    return res.sendStatus(204);
  } catch (error) {
    console.error("Failed to delete audit log:", error.message);
    return res.status(500).json({ success: false, message: "Unable to delete the audit entry." });
  }
};