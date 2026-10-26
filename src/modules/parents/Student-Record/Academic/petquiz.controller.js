const quizContent = require('./interventionQuizContent.service');
const connection = require("../../../../../config/db");
const groqService = require("../../../shared/ai/groq.service");
const { verifyParentAccess } = require("./petstate.controller");

const VALID_DIFFICULTIES = ["Easy", "Medium", "Hard"];
const QUESTIONS_PER_LEVEL = quizContent.QUESTION_COUNT;


const HUNGER_SEGMENTS = 5;

function nextDifficulty(current) {
  const idx = VALID_DIFFICULTIES.indexOf(current);
  return idx >= 0 && idx + 1 < VALID_DIFFICULTIES.length ? VALID_DIFFICULTIES[idx + 1] : null;
}


async function resolveArchiveStatus(studentId, topicId, db = connection) {
  const [masteryRows] = await db.query(
    `SELECT mastered_at FROM pet_topic_mastery WHERE student_id = ? AND topic_id = ?`,
    [studentId, topicId]
  );
  if (masteryRows.length === 0) return false; // never archived

  const masteredAt = masteryRows[0].mastered_at;

  const [[latest]] = await db.query(
    `SELECT (gs.score / gi.max_items * 100) AS pct, lt.developing_threshold_percent AS threshold
     FROM grade_items gi
     INNER JOIN grade_scores gs ON gs.item_id = gi.id AND gs.student_id = ?
     INNER JOIN learning_topics lt ON lt.id = gi.topic_id
     WHERE gi.topic_id = ? AND gs.score IS NOT NULL AND gs.updated_at > ?
     ORDER BY gs.updated_at DESC, gs.id DESC
     LIMIT 1`,
    [studentId, topicId, masteredAt]
  );

  const needsReflag = latest && Number(latest.pct) <= Number(latest.threshold);
  if (!needsReflag) return true; 

  // Re-flag: wipe this topic's progress so the student redoes it from scratch.
  await db.query(
    `DELETE FROM pet_level_progress WHERE student_id = ? AND topic_id = ?`,
    [studentId, topicId]
  );
  await db.query(
    `DELETE FROM pet_bonus_progress WHERE student_id = ? AND topic_id = ?`,
    [studentId, topicId]
  );
  await db.query(
    `DELETE FROM pet_topic_mastery WHERE student_id = ? AND topic_id = ?`,
    [studentId, topicId]
  );

  return false; 
}

const ARCHIVED_RESPONSE = {
  message: "This intervention has been completed and archived.",
  archived: true,
};


function formatGradeLevel(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (/kinder/i.test(str)) return "Kindergarten";
  const digits = str.match(/\d+/);
  return digits ? `Grade ${parseInt(digits[0], 10)}` : str;
}

// Reads the student's grade from elem_students.grade_level_id -> grade_level.
// If the lookup fails, quizzes still work (they just aren't grade-specific)
// and a warning is logged. Check the `gradeLevel` field in the GET /quiz
// response: if it is null, this query needs fixing.
async function getStudentGradeLevel(studentId) {
  try {
    const [rows] = await connection.query(
      `SELECT gl.grade_level
       FROM elem_students es
       INNER JOIN grade_level gl ON gl.id = es.grade_level_id
       WHERE es.id = ?`,
      [studentId]
    );
    return formatGradeLevel(rows[0]?.grade_level);
  } catch (error) {
    console.warn(
      `Could not read grade level for student ${studentId}; generating a non-grade-specific quiz.`,
      error.message
    );
    return null;
  }
}

// -----------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------

// The intervention has 5 steps, each worth exactly 1 segment of the meter:
//   Easy, Medium, Hard, Matching game, Memory game.
// The meter is simply how many of them are finished. It is full (5) only when
// all five are done, and that is also the only time the intervention can end.
// (HUNGER_SEGMENTS must equal 3 levels + 2 bonus games.)
const BONUS_GAMES = ["match", "memory"];

async function getBonusProgress(studentId, topicId, db = connection) {
  const [rows] = await db.query(
    `SELECT game FROM pet_bonus_progress WHERE student_id = ? AND topic_id = ?`,
    [studentId, topicId]
  );
  const done = new Set(rows.map((r) => r.game));
  return { match: done.has("match"), memory: done.has("memory") };
}

async function getHungerFilled(studentId, topicId, db = connection) {
  const [[{ completedCount }]] = await db.query(
    `SELECT COUNT(*) AS completedCount
     FROM pet_level_progress
     WHERE student_id = ? AND topic_id = ? AND status = 'completed'`,
    [studentId, topicId]
  );
  const bonus = await getBonusProgress(studentId, topicId, db);
  const bonusCount = Number(bonus.match) + Number(bonus.memory);

  return Math.min(HUNGER_SEGMENTS, Number(completedCount) + bonusCount);
}

// Unlocks the level after `difficulty` (if there is one and it is still locked).
async function unlockNextLevel(studentId, topicId, difficulty) {
  const next = nextDifficulty(difficulty);
  if (!next) return null;
  await connection.query(
    `UPDATE pet_level_progress SET status = 'available'
     WHERE student_id = ? AND topic_id = ? AND difficulty = ? AND status = 'locked'`,
    [studentId, topicId, next]
  );
  return next;
}

async function ensureLevelRowsExist(studentId, topicId) {
  // Idempotent: creates Easy=available, Medium=locked, Hard=locked the
  // first time this student touches this topic's quiz. Safe to call
  // every request.
  for (const [i, d] of VALID_DIFFICULTIES.entries()) {
    await connection.query(
      `INSERT INTO pet_level_progress (student_id, topic_id, difficulty, status)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = status`, // no-op if it already exists
      [studentId, topicId, d, i === 0 ? "available" : "locked"]
    );
  }
}

// -----------------------------------------------------------------------
// GET /intervention/:studentId/:topicId
// Returns level lock/unlock/completed status + the hunger meter.
// For an archived intervention it returns interventionCompleted: true,
// which the frontend uses to show the "archived" screen.
// -----------------------------------------------------------------------
exports.getInterventionState = async (req, res) => {
  const { studentId, topicId } = req.params;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    // A new low score after mastery reopens the intervention. Resolve this
    // before creating/reading progress rows so the restarted quiz begins clean.
    const archived = await resolveArchiveStatus(studentId, topicId);
    await ensureLevelRowsExist(studentId, topicId);

    const [levelRows] = await connection.query(
      `SELECT difficulty, status FROM pet_level_progress WHERE student_id = ? AND topic_id = ?`,
      [studentId, topicId]
    );
    const levels = {};
    for (const row of levelRows) levels[row.difficulty.toLowerCase()] = row.status;

    const hungerFilled = await getHungerFilled(studentId, topicId);

    const bonus = await getBonusProgress(studentId, topicId);

    return res.status(200).json({
      levels, // { easy: 'available', medium: 'locked', hard: 'locked' }
      bonus, // { match: true|false, memory: true|false }
      hungerFilled,
      hungerTotal: HUNGER_SEGMENTS,
      interventionCompleted: archived,
    });
  } catch (error) {
    console.error("Error fetching intervention state:", error);
    return res.status(500).json({ message: "Failed to fetch intervention state." });
  }
};

// -----------------------------------------------------------------------
// GET /quiz/:studentId/:topicId?difficulty=Easy|Medium|Hard
// Backend-enforced: refuses to serve a locked level's quiz, and refuses
// to serve anything once the intervention is archived (410).
// Questions are written for, and cached per, the student's grade level.
// -----------------------------------------------------------------------
exports.getQuiz = async (req, res) => {
  const { studentId, topicId } = req.params;
  const difficulty = VALID_DIFFICULTIES.includes(req.query.difficulty) ? req.query.difficulty : "Easy";
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    if (await resolveArchiveStatus(studentId, topicId)) {
      return res.status(410).json(ARCHIVED_RESPONSE);
    }

    await ensureLevelRowsExist(studentId, topicId);

    const [[levelRow]] = await connection.query(
      `SELECT status FROM pet_level_progress WHERE student_id = ? AND topic_id = ? AND difficulty = ?`,
      [studentId, topicId, difficulty]
    );
    if (!levelRow || levelRow.status === "locked") {
      return res.status(403).json({ message: `${difficulty} is locked. Complete the previous level first.` });
    }

    const gradeLevel = await getStudentGradeLevel(studentId);

    const quiz = await quizContent.loadQuiz(topicId, gradeLevel, difficulty);
    // Answers/explanations are server-only until each question is graded.
    const questions = quiz.questions.map(({id,question_text,choice_a,choice_b,choice_c,choice_d,order_index}) => ({id,question_text,choice_a,choice_b,choice_c,choice_d,order_index}));
    return res.status(200).json({ practiceSetId:quiz.practiceSetId, title:quiz.title, difficulty, gradeLevel, questions });
  } catch (error) {
    console.error("Error fetching quiz:", error);
    return res.status(error.httpStatus || 500).json({ message: error.httpStatus ? error.message : 'Failed to fetch quiz.', ...(error.code ? {code:error.code} : {}), ...(error.code === 'QUIZ_OUTCOME_UNCERTAIN' ? {outcome:'uncertain'} : {}) });
  }
};

// -----------------------------------------------------------------------
// POST /quiz/:studentId/:topicId/grade-single
// Grades one question, persists it to pet_answers (used for review/history),
// and returns correctness for immediate UI feedback. Hunger no longer moves
// per-question — see getHungerFilled(), which is level-completion based.
// Refuses (410) once the intervention is archived.
// -----------------------------------------------------------------------
exports.gradeSingleAnswer = async (req, res) => {
  const { studentId, topicId } = req.params;
  const { practiceSetId, questionId, selected } = req.body;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });
  if (!practiceSetId || !questionId || !selected) {
    return res.status(400).json({ message: "practiceSetId, questionId, and selected are required." });
  }

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    if (await resolveArchiveStatus(studentId, topicId)) {
      return res.status(410).json(ARCHIVED_RESPONSE);
    }

    await quizContent.requireQuiz(practiceSetId, topicId, await getStudentGradeLevel(studentId));
    if (!['A','B','C','D'].includes(selected)) return res.status(400).json({message:'Invalid answer selection.'});

    const [rows] = await connection.query(
      `SELECT correct_answer, explanation FROM ai_practice_questions WHERE id = ? AND practice_set_id = ?`,
      [questionId, practiceSetId]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Question not found." });

    const { correct_answer: correctAnswer, explanation } = rows[0];
    const isCorrect = correctAnswer === selected;

    // Still recorded per-question (used to verify remedial rounds are fully
    // cleared, and for any answer-history views), just no longer the thing
    // that drives the hunger meter directly.
    await connection.query(
      `INSERT INTO pet_answers (student_id, topic_id, question_id, is_correct)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         is_correct = GREATEST(is_correct, VALUES(is_correct)),
         answered_at = CURRENT_TIMESTAMP`,
      [studentId, topicId, questionId, isCorrect ? 1 : 0]
    );

    return res.status(200).json({ isCorrect, correctAnswer, explanation });
  } catch (error) {
    console.error("Error grading single answer:", error);
    return res.status(error.httpStatus || 500).json({ message: error.httpStatus ? error.message : 'Failed to grade answer.' });
  }
};

// -----------------------------------------------------------------------
// POST /quiz/:studentId/:topicId/submit
//
// mode "full" (default): finalizes a FULL round's score for record-keeping
//   (academic score, separate from hunger). Only marks the level completed
//   if the round was fully correct. Hunger meter increments here because
//   pet_level_progress.status flips to 'completed'.
//
// mode "remedial": called by the frontend once the practice round over the
//   missed questions is cleared. The client's answers are NOT trusted here:
//   the level is only completed if pet_answers shows every question in this
//   practice set has been answered correctly. The score from the full round
//   is left untouched. Hunger meter increments here too, for the same reason.
//
// Refuses (410) once the intervention is archived.
// -----------------------------------------------------------------------
exports.submitQuiz = async (req, res) => {
  const { studentId, topicId } = req.params;
  const { practiceSetId, difficulty, answers, mode } = req.body;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });
  if (!practiceSetId || !difficulty || !Array.isArray(answers)) {
    return res.status(400).json({ message: "practiceSetId, difficulty, and answers are required." });
  }
  if (!VALID_DIFFICULTIES.includes(difficulty)) {
    return res.status(400).json({ message: "Invalid difficulty." });
  }

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    if (await resolveArchiveStatus(studentId, topicId)) {
      return res.status(410).json(ARCHIVED_RESPONSE);
    }

    const questionRows = await quizContent.requireQuiz(practiceSetId, topicId, await getStudentGradeLevel(studentId), difficulty);
    if (mode !== 'remedial') {
      const ids = new Set(questionRows.map(q => String(q.id))), seen = new Set();
      for (const answer of answers) {
        const id = String(answer?.questionId);
        if (!answer || !ids.has(id) || seen.has(id) || !['A','B','C','D'].includes(answer.selected)) return res.status(400).json({message:'Answers must reference distinct questions in this quiz with valid choices.'});
        seen.add(id);
      }
    }
    const totalQuestions = questionRows.length;

    // ---------------- Practice (remedial) round ----------------
    if (mode === "remedial") {
      const [[{ clearedCount }]] = await connection.query(
        `SELECT COUNT(DISTINCT pa.question_id) AS clearedCount
         FROM pet_answers pa
         INNER JOIN ai_practice_questions q ON q.id = pa.question_id
         WHERE pa.student_id = ? AND pa.topic_id = ? AND q.practice_set_id = ? AND pa.is_correct = 1`,
        [studentId, topicId, practiceSetId]
      );

      const fullyCleared = totalQuestions > 0 && clearedCount >= totalQuestions;

      let unlockedNext = null;
      if (fullyCleared) {
        await connection.query(
          `UPDATE pet_level_progress
           SET status = 'completed', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)
           WHERE student_id = ? AND topic_id = ? AND difficulty = ?`,
          [studentId, topicId, difficulty]
        );
        unlockedNext = await unlockNextLevel(studentId, topicId, difficulty);
      }

      const hungerFilled = await getHungerFilled(studentId, topicId);

      return res.status(200).json({
        results: [],
        score: clearedCount,
        totalQuestions,
        fullyCleared,
        unlockedNext,
        hungerFilled,
        hungerTotal: HUNGER_SEGMENTS,
      });
    }

    // ---------------- Full round ----------------
    const correctMap = new Map(questionRows.map((q) => [q.id, q]));

    let score = 0;
    const results = answers.map((a) => {
      const q = correctMap.get(a.questionId);
      const isCorrect = q && q.correct_answer === a.selected;
      if (isCorrect) score++;
      return {
        questionId: a.questionId,
        selected: a.selected,
        correctAnswer: q?.correct_answer,
        isCorrect,
        explanation: q?.explanation,
      };
    });

    const fullyCleared = score === totalQuestions;

    await connection.query(
      `UPDATE pet_level_progress
       SET status = ?, score = ?, total_questions = ?, completed_at = IF(? = 'completed', CURRENT_TIMESTAMP, completed_at)
       WHERE student_id = ? AND topic_id = ? AND difficulty = ?`,
      [
        fullyCleared ? "completed" : "available",
        score,
        totalQuestions,
        fullyCleared ? "completed" : "available",
        studentId,
        topicId,
        difficulty,
      ]
    );

    let unlockedNext = null;
    if (fullyCleared) {
      unlockedNext = await unlockNextLevel(studentId, topicId, difficulty);
    }

    const hungerFilled = await getHungerFilled(studentId, topicId);

    return res.status(200).json({
      results,
      score,
      totalQuestions,
      fullyCleared,
      unlockedNext,
      hungerFilled,
      hungerTotal: HUNGER_SEGMENTS,
    });
  } catch (error) {
    console.error("Error submitting quiz:", error);
    return res.status(error.httpStatus || 500).json({ message: error.httpStatus ? error.message : 'Failed to submit quiz.' });
  }
};

// -----------------------------------------------------------------------
// POST /mastery/:studentId/:topicId
// Called when the parent clicks "End Intervention". ARCHIVES the
// intervention for this topic (nothing is deleted):
//   1. Records mastery (pet_topic_mastery). This is the ONLY thing that
//      actually clears the intervention on the parent's side: the parent
//      app's "hungry topics" list comes from
//      shared/grades/lowGradeTopics.service.js#getLowGradeTopicsForStudent,
//      which excludes any topic with a pet_topic_mastery row via a
//      NOT EXISTS clause. The same row is what the quiz endpoints above
//      check to refuse access (410) once the intervention is archived.
//   2. Notifies every linked parent via the `notifications` table so it
//      shows up as a modal/toast on their side.
//
// Idempotent: if the topic is already archived, this returns success
// without sending duplicate notifications (double-click, retry, etc.).
//
// Mastery is the existing per-student/topic record. The existing low-grade
// reflag policy is retained by resolveArchiveStatus; no new period/history
// model is introduced here. Mastery and in-app notifications commit together.
// -----------------------------------------------------------------------
exports.markTopicMastered = async (req, res) => {
  const { studentId, topicId } = req.params;
  const parentUserId = req.user?.userId;
  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });
  let db, active = false, commitAttempted = false, discard = false;
  let status = 200, body;
  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });
    db = await connection.getConnection();
    try { await db.beginTransaction(); active = true; } catch (error) { discard = true; throw error; }
    // Serialize completions, including initially absent mastery rows. Use the
    // same topic lock order as F13; AI generation never holds this lock.
    const [topics] = await db.query('SELECT id FROM learning_topics WHERE id = ? FOR UPDATE', [topicId]);
    const [students] = await db.query('SELECT id FROM elem_students WHERE id = ? FOR UPDATE', [studentId]);
    if (!topics.length || !students.length) throw Object.assign(new Error('Student or topic not found.'), { httpStatus: 404 });
    const tables = ['learning_topics','elem_students','parent_table','parent_student','pet_level_progress','pet_bonus_progress','pet_topic_mastery','notifications'];
    const [engines] = await db.query(`SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
    if (tables.some(name => !engines.some(r => r.tableName === name && r.engine?.toUpperCase() === 'INNODB'))) throw new Error('Intervention completion requires existing InnoDB tables.');
    // Revalidate current ownership on this connection before any write.
    const [owners] = await db.query(`SELECT pt.id FROM parent_table pt JOIN parent_student ps ON ps.parent_id = pt.id
      WHERE pt.user_id = ? AND pt.is_deleted = 0 AND ps.student_id = ? FOR UPDATE`, [parentUserId,studentId]);
    if (!owners.length) throw Object.assign(new Error("You don't have access to this student's records."), { httpStatus: 403 });
    const [levels] = await db.query('SELECT difficulty, status FROM pet_level_progress WHERE student_id = ? AND topic_id = ? FOR UPDATE', [studentId,topicId]);
    const [bonuses] = await db.query('SELECT game FROM pet_bonus_progress WHERE student_id = ? AND topic_id = ? FOR UPDATE', [studentId,topicId]);
    if (await resolveArchiveStatus(studentId, topicId, db)) {
      // Historical records lack a topic/event key in notifications. Never
      // fabricate a legacy notification here: separate reviewed repair only.
      body = { success: true, alreadyArchived: true };
    } else if ((await getHungerFilled(studentId, topicId, db)) < HUNGER_SEGMENTS ||
      VALID_DIFFICULTIES.some(d => !levels.some(r => r.difficulty === d && r.status === 'completed')) ||
      BONUS_GAMES.some(game => !bonuses.some(r => r.game === game))) {
      status = 409;
      body = { message: 'Finish Easy, Medium, Hard, Matching and Memory before ending the intervention.', code: 'STEPS_INCOMPLETE' };
      // An existing low-grade reflag may have cleared progress. Commit that
      // existing policy atomically, while rejecting completion as before.
    } else {
      const [insert] = await db.query('INSERT IGNORE INTO pet_topic_mastery (student_id, topic_id) VALUES (?, ?)', [studentId,topicId]);
      body = { success: true, ...(insert.affectedRows === 0 ? { alreadyArchived: true } : {}) };
      if (insert.affectedRows !== 0) {
        const [[student]] = await db.query('SELECT first_name FROM elem_students WHERE id = ?', [studentId]);
        const [[topic]] = await db.query('SELECT topic_name FROM learning_topics WHERE id = ?', [topicId]);
        const [parents] = await db.query(`SELECT pt.user_id FROM parent_student ps
          INNER JOIN parent_table pt ON pt.id = ps.parent_id WHERE ps.student_id = ? AND pt.is_deleted = 0 FOR UPDATE`, [studentId]);
        for (const userId of new Set(parents.map(p => p.user_id).filter(Boolean))) {
          // This final in-app notification row is durable delivery, not a
          // post-commit side effect or a promise of socket/email delivery.
          await db.query(`INSERT INTO notifications (user_id, student_id, title, message, type)
            VALUES (?, ?, ?, ?, 'success')`, [userId,studentId,'Intervention Completed',`${student?.first_name ?? 'Your child'} has completed the ${topic?.topic_name ?? 'this topic'} intervention! Great job!`]);
        }
      }
    }
    commitAttempted = true;
    await db.commit(); active = false;
  } catch (error) {
    if (error.fatal) discard = true;
    if (commitAttempted) {
      discard = true; status = 503;
      body = { message: 'Intervention completion could not be confirmed. Reload its current state before trying again.', code: 'INTERVENTION_OUTCOME_UNCERTAIN', outcome: 'uncertain' };
    } else {
      if (active) { try { await db.rollback(); } catch (rollbackError) { discard = true; console.error('Intervention rollback failed:', {code:rollbackError?.code ?? 'UNKNOWN'}); } }
      status = error.httpStatus || 500;
      body = { message: error.httpStatus ? error.message : 'Failed to mark topic mastered.' };
      console.error('Error marking topic mastered:', {code:error.code ?? 'UNKNOWN'});
    }
  } finally {
    if (db) {
      try { if (discard) db.destroy(); else db.release(); }
      catch (error) {
        console.error('Intervention cleanup failed:', {code:error?.code ?? 'UNKNOWN'});
        if (!discard) { try { db.destroy(); } catch (destroyError) { console.error('Intervention destruction failed:', {code:destroyError?.code ?? 'UNKNOWN'}); } }
      }
    }
  }
  return res.status(status).json(body);
};


// -----------------------------------------------------------------------
// GET /bonus/:studentId/:topicId
// Returns the bonus games for a topic, written for the student's grade:
//   match  -> 5 pairs for the matching game
//   memory -> the first 4 of the same pairs (8 cards = a clean 4x2 grid)
// Generated once per topic + grade with Groq (quiz keys), then cached in
// ai_bonus_games. Refuses (410) once the intervention is archived.
// -----------------------------------------------------------------------
const MEMORY_PAIR_COUNT = quizContent.MEMORY_COUNT;

async function getOrCreateBonusPairs(topicId, gradeLevel) {
  return quizContent.loadBonus(topicId, gradeLevel);
}

exports.getBonusGames = async (req, res) => {
  const { studentId, topicId } = req.params;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    if (await resolveArchiveStatus(studentId, topicId)) {
      return res.status(410).json(ARCHIVED_RESPONSE);
    }

    const gradeLevel = await getStudentGradeLevel(studentId);
    const pairs = await getOrCreateBonusPairs(topicId, gradeLevel);

    return res.status(200).json({
      match: pairs.map((p, i) => ({ id: i + 1, left: p.left, right: p.right })),
      memory: pairs
        .slice(0, MEMORY_PAIR_COUNT)
        .map((p, i) => ({ id: i + 1, a: p.left, b: p.right })),
    });
  } catch (error) {
    if (error.httpStatus) return res.status(error.httpStatus).json({message:error.message, ...(error.code ? {code:error.code} : {}), ...(error.code === 'QUIZ_OUTCOME_UNCERTAIN' ? {outcome:'uncertain'} : {})});
    console.error("Error fetching bonus games:", error);
    return res.status(500).json({ message: "Failed to fetch bonus games." });
  }
};


exports.completeBonusGame = async (req, res) => {
  const { studentId, topicId } = req.params;
  const { game } = req.body;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });
  if (!BONUS_GAMES.includes(game)) {
    return res.status(400).json({ message: "game must be 'match' or 'memory'." });
  }

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    if (await resolveArchiveStatus(studentId, topicId)) {
      return res.status(410).json(ARCHIVED_RESPONSE);
    }

    if (!(await quizContent.findBonus(topicId, await getStudentGradeLevel(studentId)))) return res.status(409).json({message:'This bonus activity is incomplete or unavailable. Reload it before completing it.'});

    await connection.query(
      `INSERT IGNORE INTO pet_bonus_progress (student_id, topic_id, game) VALUES (?, ?, ?)`,
      [studentId, topicId, game]
    );

    return res.status(200).json({
      hungerFilled: await getHungerFilled(studentId, topicId),
      hungerTotal: HUNGER_SEGMENTS,
      bonus: await getBonusProgress(studentId, topicId),
    });
  } catch (error) {
    console.error("Error completing bonus game:", error);
    return res.status(500).json({ message: "Failed to save bonus game progress." });
  }
};
