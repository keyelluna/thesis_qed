const connection = require("../../../../config/db");

// GET /school-years
// Get all school years (including inactive ones)
exports.getAllSchoolYears = async (req, res) => {
  try {
    const [rows] = await connection.query(
      'SELECT * FROM school_year ORDER BY school_year DESC'
    );
    return res.status(200).json({ success: true, message: 'School years fetched successfully', data: rows });
  } catch (error) {
    console.error('getAllSchoolYears error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch school years' });
  }
};

// GET /school-years/active
// Get the currently active school year
exports.getActiveSchoolYear = async (req, res) => {
  try {
    const [rows] = await connection.query(
      'SELECT * FROM school_year WHERE is_active = 1 LIMIT 1'
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No active school year found' });
    }
    return res.status(200).json({ success: true, message: 'Active school year fetched successfully', data: rows[0] });
  } catch (error) {
    console.error('getActiveSchoolYear error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch active school year' });
  }
};

// GET /school-years/:id
exports.getSchoolYearById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await connection.query(
      'SELECT * FROM school_year WHERE id = ?',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'School year not found' });
    }
    return res.status(200).json({ success: true, message: 'School year fetched successfully', data: rows[0] });
  } catch (error) {
    console.error('getSchoolYearById error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch school year' });
  }
};

// POST /school-years
// Create a new school year. If is_active is set to 1, deactivate all others first.
exports.createSchoolYear = async (req, res) => {
  const { school_year, is_active } = req.body;

  if (!school_year) {
    return res.status(400).json({ success: false, message: 'school_year is required' });
  }

  const connection = await connection.execute();
  try {
    await connection.beginTransaction();

    // check duplicate
    const [existing] = await connection.query(
      'SELECT id FROM school_year WHERE school_year = ?',
      [school_year]
    );
    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ success: false, message: 'School year already exists' });
    }

    const activeFlag = is_active ? 1 : 0;

    if (activeFlag === 1) {
      await connection.query('UPDATE school_year SET is_active = 0 WHERE is_active = 1');
    }

    const [result] = await connection.query(
      'INSERT INTO school_year (school_year, is_active) VALUES (?, ?)',
      [school_year, activeFlag]
    );

    await connection.commit();
    return res.status(201).json({
      success: true,
      message: 'School year created successfully',
      data: { id: result.insertId, school_year, is_active: activeFlag },
    });
  } catch (error) {
    await connection.rollback();
    console.error('createSchoolYear error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create school year' });
  } finally {
    connection.release();
  }
};

// PUT /school-years/:id
// Update school year label and/or active status
exports.updateSchoolYear = async (req, res) => {
  const { id } = req.params;
  const { school_year, is_active } = req.body;

  const connection = await connection.execute();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT * FROM school_year WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'School year not found' });
    }

    const updatedLabel = school_year ?? existing[0].school_year;
    const updatedActive =
      is_active !== undefined ? (is_active ? 1 : 0) : existing[0].is_active;

    if (updatedActive === 1) {
      await connection.query(
        'UPDATE school_year SET is_active = 0 WHERE is_active = 1 AND id != ?',
        [id]
      );
    }

    await connection.query(
      'UPDATE school_year SET school_year = ?, is_active = ? WHERE id = ?',
      [updatedLabel, updatedActive, id]
    );

    await connection.commit();
    return res.status(200).json({ success: true, message: 'School year updated successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('updateSchoolYear error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update school year' });
  } finally {
    connection.release();
  }
};

// PATCH /school-years/:id/activate
// Set a specific school year as the active one (deactivates all others)
exports.setActiveSchoolYear = async (req, res) => {
  const { id } = req.params;

  const connection = await connection.execute();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.execute(
      'SELECT id FROM school_year WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'School year not found' });
    }

    await connection.query('UPDATE school_year SET is_active = 0 WHERE is_active = 1');
    await connection.query('UPDATE school_year SET is_active = 1 WHERE id = ?', [id]);

    await connection.commit();
    return res.status(200).json({ success: true, message: 'School year set as active' });
  } catch (error) {
    await connection.rollback();
    console.error('setActiveSchoolYear error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set active school year' });
  } finally {
    connection.release();
  }
};

// DELETE /school-years/:id
// "Delete" only toggles is_active to 0 (no row removal, no is_deleted column on this table)
exports.deleteSchoolYear = async (req, res) => {
  const { id } = req.params;
  try {
    const [existing] = await connection.execute(
      'SELECT id, is_active FROM school_year WHERE id = ?',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'School year not found' });
    }

    await connection.query('UPDATE school_year SET is_active = 0 WHERE id = ?', [id]);

    return res.status(200).json({ success: true, message: 'School year deactivated successfully' });
  } catch (error) {
    console.error('deleteSchoolYear error:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate school year' });
  }
};