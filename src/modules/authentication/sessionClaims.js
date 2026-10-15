const SESSION_ROLES = new Set(['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT']);

function validSessionClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
      claims.purpose !== undefined || typeof claims.role !== 'string' ||
      !SESSION_ROLES.has(claims.role.toUpperCase())) return false;
  const id = claims.userId;
  return (typeof id === 'string' || typeof id === 'number') &&
    /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id)) &&
    Number.isSafeInteger(claims.iat) && claims.iat > 0 &&
    Number.isSafeInteger(claims.exp) && claims.exp > claims.iat;
}

module.exports = { validSessionClaims };
