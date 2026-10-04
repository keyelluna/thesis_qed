const connection = require('../../../../config/db');

exports.getLowGradeTopicsForStudent = async (studentId) => {
  const [rows] = await connection.query(
    `SELECT
       t.topic_id,
       t.topic_name,
       t.mastery_threshold,
       t.developing_threshold,
       t.subject_name,
       t.average_percent,
       t.items_scored,
       t.latest_percent
     FROM (
       SELECT
         lt.id AS topic_id,
         lt.topic_name,
         lt.mastery_threshold_percent AS mastery_threshold,
         lt.developing_threshold_percent AS developing_threshold,
         es.subject_name,
         AVG(gs.score / gi.max_items * 100) AS average_percent,
         COUNT(gs.id) AS items_scored,
         (
           SELECT gs2.score / gi2.max_items * 100
           FROM grade_items gi2
           INNER JOIN grade_scores gs2 ON gs2.item_id = gi2.id AND gs2.student_id = ?
           WHERE gi2.topic_id = lt.id AND gs2.score IS NOT NULL
           ORDER BY gi2.item_date DESC, gi2.id DESC
           LIMIT 1
         ) AS latest_percent
       FROM grade_items gi
       INNER JOIN learning_topics lt ON gi.topic_id = lt.id
       INNER JOIN \`subject-section\` ss ON gi.subject_section_id = ss.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       INNER JOIN grade_scores gs ON gs.item_id = gi.id AND gs.student_id = ?
       WHERE ss.status = 'Active'
         AND gs.score IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
           FROM pet_topic_mastery ptm
           WHERE ptm.student_id = ?
             AND ptm.topic_id = lt.id
             AND NOT EXISTS (
               SELECT 1
               FROM grade_items reflag_gi
               INNER JOIN grade_scores reflag_gs
                 ON reflag_gs.item_id = reflag_gi.id
                AND reflag_gs.student_id = ?
               WHERE reflag_gi.topic_id = lt.id
                 AND reflag_gs.score IS NOT NULL
                 AND reflag_gs.updated_at > ptm.mastered_at
                 AND (reflag_gs.score / NULLIF(reflag_gi.max_items, 0) * 100)
                   <= lt.developing_threshold_percent
                 AND NOT EXISTS (
                   SELECT 1
                   FROM grade_items newer_gi
                   INNER JOIN grade_scores newer_gs
                     ON newer_gs.item_id = newer_gi.id
                    AND newer_gs.student_id = ?
                   WHERE newer_gi.topic_id = lt.id
                     AND newer_gs.score IS NOT NULL
                     AND (
                       newer_gs.updated_at > reflag_gs.updated_at
                       OR (newer_gs.updated_at = reflag_gs.updated_at AND newer_gs.id > reflag_gs.id)
                     )
                 )
             )
         )
       GROUP BY lt.id, lt.topic_name, lt.mastery_threshold_percent,
                lt.developing_threshold_percent, es.subject_name
     ) t
     WHERE t.average_percent <= t.developing_threshold
        OR t.latest_percent <= t.developing_threshold
     ORDER BY LEAST(t.average_percent, COALESCE(t.latest_percent, t.average_percent)) ASC`,
    [studentId, studentId, studentId, studentId, studentId]
  );
  return rows;
};
