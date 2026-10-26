const connection = require('../../../../../config/db');
const groq = require('../../../shared/ai/groq.service');
const QUESTION_COUNT = 10, MATCH_COUNT = 5, MEMORY_COUNT = 4;
const text = value => typeof value === 'string' && value.trim().length > 0;
const key = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
const failure = (status, message, code) => Object.assign(new Error(message), { httpStatus: status, code });
function validQuestions(rows, stored = false) {
  if (!Array.isArray(rows) || rows.length !== QUESTION_COUNT) return false;
  const seen = new Set();
  return rows.every((q, index) => {
    if (!q || typeof q !== 'object') return false;
    const fields = stored ? ['question_text','choice_a','choice_b','choice_c','choice_d','explanation'] : ['questionText','choiceA','choiceB','choiceC','choiceD','explanation'];
    if (!fields.every(f => text(q[f]))) return false;
    const stem = key(q[fields[0]]), choices = fields.slice(1,5).map(f => key(q[f]));
    if (seen.has(stem) || new Set(choices).size !== 4 || !['A','B','C','D'].includes(q[stored ? 'correct_answer' : 'correctAnswer'])) return false;
    if (stored && (!q.id || Number(q.order_index) !== index)) return false;
    seen.add(stem); return true;
  });
}
function readPairs(raw) {
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
function validPairs(raw) {
  const rows = readPairs(raw), left = new Set(), right = new Set();
  return Array.isArray(rows) && rows.length === MATCH_COUNT && rows.every(p => {
    if (!p || !text(p.left) || !text(p.right) || p.left.trim().length > 40 || p.right.trim().length > 40) return false;
    const l = key(p.left), r = key(p.right);
    if (l === r || left.has(l) || right.has(r)) return false;
    left.add(l); right.add(r); return true;
  });
}
async function quizRows(id, db) {
  const [rows] = await db.query(`SELECT id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, explanation, order_index
    FROM ai_practice_questions WHERE practice_set_id = ? ORDER BY order_index ASC`, [id]);
  return rows;
}
async function findQuiz(topic, grade, difficulty, db = connection) {
  const [sets] = await db.query(`SELECT id, title FROM ai_practice_sets WHERE topic_id = ? AND difficulty = ? AND grade_level <=> ? ORDER BY generated_at DESC, id DESC`, [topic, difficulty, grade]);
  for (const set of sets) {
    const rows = await quizRows(set.id, db);
    if (text(set.title) && validQuestions(rows, true)) return { practiceSetId: set.id, title: set.title, questions: rows };
  }
  return null;
}
async function findBonus(topic, grade, db = connection) {
  const [sets] = await db.query('SELECT pairs FROM ai_bonus_games WHERE topic_id = ? AND grade_level <=> ? ORDER BY generated_at DESC, id DESC', [topic, grade]);
  for (const set of sets) if (validPairs(set.pairs)) return readPairs(set.pairs);
  return null;
}
async function requireQuiz(id, topic, grade, difficulty) {
  const [sets] = await connection.query('SELECT id, title, difficulty FROM ai_practice_sets WHERE id = ? AND topic_id = ? AND grade_level <=> ?', [id, topic, grade]);
  const set = sets[0], rows = set ? await quizRows(id, connection) : [];
  if (!set || !['Easy','Medium','Hard'].includes(set.difficulty) || (difficulty && difficulty !== set.difficulty) || !text(set.title) || !validQuestions(rows, true)) {
    throw failure(409, 'This quiz is incomplete or unavailable. Reload the activity to get a complete quiz.', 'QUIZ_INCOMPLETE');
  }
  return rows;
}
async function topicContext(topic) {
  const [rows] = await connection.query(`SELECT lt.topic_name, es.subject_name FROM learning_topics lt INNER JOIN \`subject-section\` ss ON lt.subject_section_id = ss.id INNER JOIN elem_subjects es ON ss.subject_id = es.id WHERE lt.id = ?`, [topic]);
  if (!rows.length) throw failure(404, 'Topic not found.');
  return rows[0];
}
// Only content writes use this transaction; slow AI requests run beforehand.
// The existing topic row is a cross-worker mutex, including NULL grade scopes.
async function persist(kind, topic, grade, difficulty, title, generated) {
  let db, active = false, commitAttempted = false, discard = false, result;
  try {
    db = await connection.getConnection();
    try { await db.beginTransaction(); active = true; } catch (error) { discard = true; throw error; }
    const [topics] = await db.query('SELECT id FROM learning_topics WHERE id = ? FOR UPDATE', [topic]);
    if (!topics.length) throw failure(404, 'Topic not found.');
    const tables = kind === 'quiz' ? ['learning_topics','ai_practice_sets','ai_practice_questions'] : ['learning_topics','ai_bonus_games'];
    const [engines] = await db.query(`SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
    if (tables.some(name => !engines.some(r => r.tableName === name && r.engine?.toUpperCase() === 'INNODB'))) throw Error('Quiz content persistence requires existing InnoDB tables.');
    result = kind === 'quiz' ? await findQuiz(topic, grade, difficulty, db) : await findBonus(topic, grade, db);
    if (!result) {
      if (kind === 'quiz') {
        const [set] = await db.query('INSERT INTO ai_practice_sets (topic_id, title, difficulty, grade_level, model_used) VALUES (?, ?, ?, ?, ?)', [topic, title, difficulty, grade, 'groq']);
        for (const [i,q] of generated.entries()) await db.query(`INSERT INTO ai_practice_questions (practice_set_id, question_text, choice_a, choice_b, choice_c, choice_d, correct_answer, explanation, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [set.insertId,q.questionText,q.choiceA,q.choiceB,q.choiceC,q.choiceD,q.correctAnswer,q.explanation,i]);
        const rows = await quizRows(set.insertId, db);
        if (!validQuestions(rows, true)) throw Error('Persisted quiz did not satisfy its completeness contract.');
        result = { practiceSetId: set.insertId, title, questions: rows };
      } else {
        await db.query('INSERT INTO ai_bonus_games (topic_id, grade_level, pairs, model_used) VALUES (?, ?, ?, ?)', [topic, grade, JSON.stringify(generated), 'groq']);
        result = await findBonus(topic, grade, db);
        if (!result) throw Error('Persisted bonus content did not satisfy its completeness contract.');
      }
    }
    commitAttempted = true; await db.commit(); active = false;
  } catch (error) {
    if (error.fatal) discard = true;
    if (commitAttempted) { discard = true; throw failure(503, 'Quiz generation could not be confirmed. Retry loading this activity to check saved content.', 'QUIZ_OUTCOME_UNCERTAIN'); }
    if (active) { try { await db.rollback(); } catch (rollbackError) { discard = true; console.error('Quiz rollback failed:', { code: rollbackError?.code ?? 'UNKNOWN' }); } }
    throw error;
  } finally {
    if (db) { try { if (discard) db.destroy(); else db.release(); } catch (error) { console.error('Quiz connection cleanup failed:', {code:error?.code??'UNKNOWN'}); if (!discard) { try { db.destroy(); } catch (destroyError) { console.error('Quiz destruction failed:', {code:destroyError?.code??'UNKNOWN'}); } } } }
  }
  return result;
}
const inFlight = new Map();
async function load(kind, topic, grade, difficulty) {
  const existing = kind === 'quiz' ? await findQuiz(topic,grade,difficulty) : await findBonus(topic,grade);
  if (existing) return existing;
  const scope = JSON.stringify([kind,String(topic),grade,difficulty]);
  if (inFlight.has(scope)) return inFlight.get(scope);
  const work = (async () => {
    const context = await topicContext(topic);
    const generated = kind === 'quiz'
      ? await groq.generateQuiz(context.topic_name,context.subject_name,[`Understand and correctly apply concepts related to ${context.topic_name}${grade ? ` at the ${grade} level` : ''}`],difficulty,grade)
      : await groq.generateMatchPairs(context.topic_name,context.subject_name,grade);
    if (!(kind === 'quiz' ? validQuestions(generated) : Array.isArray(generated) && validPairs(generated))) throw failure(502, 'The generated activity is incomplete or invalid. Please retry loading it.', 'INVALID_QUIZ_CONTENT');
    return persist(kind,topic,grade,difficulty,context.topic_name,generated);
  })().finally(() => inFlight.delete(scope));
  inFlight.set(scope,work); return work;
}
module.exports = { loadQuiz:(topic,grade,difficulty)=>load('quiz',topic,grade,difficulty), loadBonus:(topic,grade)=>load('bonus',topic,grade,null), requireQuiz, findBonus, QUESTION_COUNT, MATCH_COUNT, MEMORY_COUNT };
