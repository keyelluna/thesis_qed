const { createHash } = require("node:crypto");

// Local backstop; multiple instances still require a shared gateway rate limit.
const buckets = new Map();
const windowMs = 10 * 60 * 1000;
const capacity = 10000;
exports.recoveryLimits = {
  clear() { buckets.clear(); },
  allow(stage, req, userName) {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.until <= now) buckets.delete(key);
    const identity = createHash("sha256").update(userName.toLowerCase()).digest("hex");
    const limits = [
      [`${stage}:ip:${req.ip}`, stage === "otp" ? 50 : 20],
      [`${stage}:account:${identity}`, stage === "otp" ? 10 : 5],
    ];
    if (buckets.size + limits.filter(([key]) => !buckets.has(key)).length > capacity) return false;
    for (const [key, limit] of limits) {
      if ((buckets.get(key)?.count || 0) >= limit || (!buckets.has(key) && buckets.size >= capacity)) return false;
    }
    for (const [key] of limits) {
      const value = buckets.get(key) || { count: 0, until: now + windowMs };
      value.count++; buckets.set(key, value);
    }
    return true;
  },
};
