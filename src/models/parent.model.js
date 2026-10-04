const connection = require("../../config/db");
let genderColumnReady;

async function ensureGenderColumn() {
  if (!genderColumnReady) {
    genderColumnReady = (async () => {
      const [columns] = await connection.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'parent_table'
           AND COLUMN_NAME = 'gender' LIMIT 1`,
      );
      if (columns.length === 0) {
        try {
          await connection.query(
            "ALTER TABLE parent_table ADD COLUMN gender ENUM('Male', 'Female') NULL DEFAULT NULL AFTER status",
          );
        } catch (error) {
          if (error.code !== "ER_DUP_FIELDNAME") throw error;
        }
      }
      return true;
    })().catch((error) => {
      genderColumnReady = undefined;
      throw error;
    });
  }
  return genderColumnReady;
}

const Parent = {
  ensureGenderColumn,
  //add user
  create: async ({
    userId,
    lastName,
    firstName,
    middleName,
    email,
    contactNumber,
    status,
    gender,
  }) => {
    await ensureGenderColumn();
    const [result] = await connection.execute(
      `INSERT INTO parent_table (user_id, last_name, first_name, middle_name, email_address, contact_number, status, gender) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, lastName, firstName, middleName, email, contactNumber, status, gender || null],
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
      gender: gender || null,
    };
  },

  //update user
  update: async ({
    id,
    lastName,
    firstName,
    middleName,
    email,
    contactNumber,
    status,
    gender,
  }) => {
    await ensureGenderColumn();
    const [result] = await connection.execute(
      `UPDATE parent_table
       SET last_name = ?, first_name = ?, middle_name = ?, email_address = ?, contact_number = ?, status = ?, gender = ?
       WHERE id = ?`,
      [lastName, firstName, middleName, email, contactNumber, status, gender || null, id],
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
      gender: gender || null,
    };
  },

  //delete user
softDelete: async (id) => {
    const conn = await connection.getConnection(); // assuming connection is a pool
    try {
      await conn.beginTransaction();

      // 1. Soft delete the parent
      const [parentResult] = await conn.execute(
        `UPDATE parent_table
         SET is_deleted = 1, deleted_at = NOW(), status = 'Inactive'
         WHERE id = ? AND is_deleted = 0`,
        [id]
      );

      if (parentResult.affectedRows === 0) {
        await conn.rollback();
        return null; // parent not found or already deleted
      }

      // 2. Get the associated user_id from the parent record
      const [parentRows] = await conn.execute(
        `SELECT user_id FROM parent_table WHERE id = ?`,
        [id]
      );
      const userId = parentRows[0]?.user_id;

      if (userId) {
        // 3. Soft delete the authentication record
        await conn.execute(
          `UPDATE qed_authentication
           SET is_deleted = 1, deleted_at = NOW()
           WHERE id = ? AND is_deleted = 0`,
          [userId]
        );
      }

      await conn.commit();
    return { id, is_deleted: 1, status: 'Inactive' };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    }
  },



//find user by id
findById: async (id) => {
  await ensureGenderColumn();
  const [rows] = await connection.execute(
    `SELECT * FROM parent_table WHERE id = ?`,
    [id]
  );
  return rows.length > 0 ? rows[0] : null;
},

//get all users (exclude soft-deleted)
findAll: async () => {
  await ensureGenderColumn();
  const [rows] = await connection.execute(
    `SELECT * FROM parent_table WHERE is_deleted = 0`
  );
  return rows;
},
};


module.exports = Parent;
