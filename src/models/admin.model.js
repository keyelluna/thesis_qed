const connection = require("../../config/db");

const Admin = {
  //add user
  create: async ({
    userId,
    lastName,
    firstName,
    middleName,
    email,
    contactNumber,
    status,
  }) => {
    const [result] = await connection.execute(
      `INSERT INTO admin_table (user_id, last_name, first_name, middle_name, email_address, contact_number, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, lastName, firstName, middleName, email, contactNumber, status],
    );

    return {
      id: result.insertId,
      userId,
      lastName,
      firstName,
      middleName,
      email,
      contactNumber,
      status,
    };
  },

  //update
  update: async ({
    id,
    lastName,
    firstName,
    middleName,
    email,
    contactNumber,
    status,
  }) => {
    const [result] = await connection.execute(
      `UPDATE admin_table
       SET last_name = ?, first_name = ?, middle_name = ?, email_address = ?, contact_number = ?, status = ?
       WHERE id = ?`,
      [lastName, firstName, middleName, email, contactNumber, status, id],
    );

    if (result.affectedRows === 0) {
      return null;
    }

    return {
      id,
      lastName,
      firstName,
      middleName,
      email,
      contactNumber,
      status,
    };
  },

  //delete user
  softDelete: async (id) => {
    const conn = await connection.getConnection(); // assuming connection is a pool
    try {
      await conn.beginTransaction();

      // 1. Soft delete the admin
      const [adminResult] = await conn.execute(
        `UPDATE admin_table
         SET is_deleted = 1, deleted_at = NOW(), status = 'Inactive'
         WHERE id = ? AND is_deleted = 0`,
        [id],
      );

      if (adminResult.affectedRows === 0) {
        await conn.rollback();
        return null; // admin not found or already deleted
      }

      // 2. Get the associated user_id from the admin record
      const [adminRows] = await conn.execute(
        `SELECT user_id FROM admin_table WHERE id = ?`,
        [id],
      );
      const userId = adminRows[0]?.user_id;

      if (userId) {
        // 3. Soft delete the authentication record
        await conn.execute(
          `UPDATE qed_authentication
           SET is_deleted = 1, deleted_at = NOW()
           WHERE id = ? AND is_deleted = 0`,
          [userId],
        );
      }

      await conn.commit();
      return { id, is_deleted: 1, status: "Inactive" };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  },

  //find user
  findById: async (id) => {
    const [rows] = await connection.execute(
      `SELECT * FROM admin_table WHERE id = ?`,
      [id],
    );

    return rows.length > 0 ? rows[0] : null;
  },

  //get all users (exclude soft-deleted)
  findAll: async () => {
    const [rows] = await connection.execute(
      `SELECT * FROM admin_table WHERE is_deleted = 0`,
    );

    return rows;
  },
};

module.exports = Admin;
