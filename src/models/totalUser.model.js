const connection = require('../../config/db');

const totalUser = {
  async getCountsByRole() {
    const [[counts]] = await connection.query(
      `SELECT
        (SELECT COUNT(*) FROM admin_table WHERE is_deleted = 0) AS admin,
        (SELECT COUNT(*) FROM teacher_table WHERE is_deleted = 0) AS teacher,
        (SELECT COUNT(*) FROM principal_table WHERE is_deleted = 0) AS principal,
        (SELECT COUNT(*) FROM parent_table WHERE is_deleted = 0) AS parent`
    );
    const { admin, teacher, principal, parent } = counts;
    return { teacher, principal, parent, allUser: Number(admin) + Number(teacher) + Number(principal) + Number(parent) };
  },
};

module.exports = totalUser;
