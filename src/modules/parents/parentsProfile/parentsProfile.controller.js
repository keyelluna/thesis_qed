const connection = require("../../../../config/db");

exports.getUser = async (req, res) => {
  try {
    const parentUserId = req.user?.userId;

    if (!parentUserId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: Walang user ID na nahanap.",
      });
    }

    const query = `
      SELECT id, CONCAT(first_name, ' ', last_name) AS full_name, contact_number, email_address, address
      FROM parent_table
      WHERE user_id = ?
    `;

    const [rows] = await connection.execute(
      query,
      [parentUserId]
    );

    if (rows.length === 0) {
        return res.status(404).json({
            success : false,
            message: "Can't find user"
        });
    }

    return res.status(200).json({
        success: true,
        data: rows[0]
    });
  } catch (error) {
        console.error('Error fetching user profile:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error'
        });
  }
};
