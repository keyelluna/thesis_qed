const connection = require('../../config/db');

const totalUser = {
    getCountsByRole: async () => {
        const [teacherCount] = await connection.query(
            `SELECT COUNT(*) AS total FROM teacher_table`
        );
        const [principalCount] = await connection.query(
            `SELECT COUNT(*) AS total FROM principal_table`
        );
        const [parentCount] = await connection.query(
            `SELECT COUNT(*) AS total FROM parent_table`
        );

        return {
            teacher: teacherCount[0].total,
            principal: principalCount[0].total,
            parent: parentCount[0].total,
            allUser: teacherCount[0].total + principalCount[0].total + parentCount[0].total
        };
    },
};

module.exports = totalUser;