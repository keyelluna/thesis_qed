// Notifications belong to qed_authentication.id, never a role-profile ID.
function notificationOwner(user) {
  if (!user || user.purpose !== undefined || typeof user.role !== 'string' ||
      !['admin', 'principal', 'teacher', 'parent'].includes(user.role.toLowerCase())) return null;
  const id = user.userId;
  if (!(typeof id === 'number' || typeof id === 'string') || !/^[1-9]\d*$/.test(String(id)) ||
      !Number.isSafeInteger(Number(id))) return null;
  return String(id);
}
module.exports = { notificationOwner };
