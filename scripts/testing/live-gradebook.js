// Opt-in integration harness. Uses only run-owned synthetic records for writes.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mysql = require('mysql2/promise');
const fixturePath = process.env.QED_LIVE_FIXTURE;
if (!fixturePath) throw Error('QED_LIVE_FIXTURE must point to a private temporary fixture file');
const options = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, timezone: '+08:00', dateStrings: true };

async function setup() {
  if (fs.existsSync(fixturePath)) throw Error('Fixture exists; clean it up before another setup');
  const db = await mysql.createConnection(options);
  const f = { prefix: `qede2e_${crypto.randomBytes(4).toString('hex')}`, password: crypto.randomBytes(24).toString('base64url'), accounts: {}, students: [], sections: [], classes: [], subjectSections: [], subjects: [], templates: [] };
  const insert = async (table, data) => { const [r] = await db.query(`INSERT INTO ${mysql.escapeId(table)} SET ?`, data); return r.insertId; };
  try {
    await db.beginTransaction();
    const [[year]] = await db.query('SELECT id FROM school_year WHERE is_active=1 ORDER BY id DESC LIMIT 1');
    if (!year) throw Error('No active school year');
    f.yearId = year.id;
    const [[period]] = await db.query('SELECT id FROM grading_periods WHERE school_year_id=? ORDER BY is_active DESC,term_number LIMIT 1', [year.id]);
    f.periodId = period.id;
    f.oldYearId = await insert('school_year', { school_year: f.prefix.slice(0, 20), is_active: 0 });
    f.gradeId = await insert('grade_level', { grade_level: 'Grade 1' });
    const hash = await require('bcrypt').hash(f.password, 10);
    for (const [key, role] of [['adviser', 'teacher'], ['subject', 'teacher'], ['principal', 'principal'], ['parent', 'parent']]) {
      const username = `${f.prefix}_${key}`;
      const userId = await insert('qed_authentication', { user_name: username, password: hash, role, must_change_password: 0 });
      const id = await insert(`${role}_table`, { user_id: userId, first_name: 'Integration', last_name: key, ...(role === 'parent' ? {} : { role }), status: 'active', gender: 'Female', email_address: `${username}@example.test` });
      f.accounts[key] = { userId, id, username, role };
    }
    for (const label of ['A', 'B']) {
      const sectionName = `${f.prefix.slice(-8)}-${label}`;
      const sectionId = await insert('grade_level_sections', { grade_level_id: f.gradeId, section_name: sectionName, school_year_id: f.yearId });
      const classId = await insert('classes', { grade_level_id: f.gradeId, section_id: sectionId, class_adviser_id: f.accounts.adviser.id, school_year_id: f.yearId, status: 'Active', room: 'TEST' });
      f.sections.push({ id: sectionId, name: sectionName }); f.classes.push(classId);
      for (const [kind, status, sy, deleted] of [['current', 'active', f.yearId, 0], ['graduate', 'graduated', f.yearId, 0], ['old', 'active', f.oldYearId, 0], ['deleted', 'active', f.yearId, 1]]) {
        const number = String(80000000000 + crypto.randomInt(1000000000));
        const studentId = await insert('elem_students', { student_number: number, learner_reference_number: '9' + number, grade_level_id: f.gradeId, first_name: `Test${label}${kind}`, last_name: f.prefix, gender: 'Female', section_id: sectionId, current_school_year_id: sy, status, is_deleted: deleted });
        f.students.push({ id: studentId, label, kind });
        if (kind === 'current') await insert('parent_student', { parent_id: f.accounts.parent.id, student_id: studentId });
      }
      for (const kind of ['own', 'external', 'historical']) {
        const subjectId = await insert('elem_subjects', { subject_name: `${f.prefix}_${label}_${kind}`, grade_level_id: f.gradeId });
        f.subjects.push(subjectId);
        const ss = await insert('subject-section', { subject_id: subjectId, section_id: sectionId, teacher_id: f.accounts[kind === 'own' ? 'adviser' : 'subject'].id, school_year_id: kind === 'historical' ? f.oldYearId : f.yearId, status: 'Active' });
        f.subjectSections.push({ id: ss, label, kind });
        if (kind === 'historical') continue;
        const templateId = await insert('subject_grade_templates', { subject_id: subjectId, file_name: 'integration-fixture.xlsx', file_path: 'integration-fixture-unused.xlsx', checksum_sha256: 'a'.repeat(64), ww_weight_percent: 40, pt_weight_percent: 60, exam_weight_percent: 0, exam_st1_subweight_percent: 0, exam_st2_subweight_percent: 0, exam_te_subweight_percent: 0, uploaded_by: f.accounts.adviser.userId, structure_json: JSON.stringify({ categories: { writtenWorks: { weightPercent: 40, columns: 1 }, performanceTask: { weightPercent: 60, columns: 1 } }, transmutationTable: [{ min: 0, max: 100, grade: 88 }] }) });
        f.templates.push(templateId);
        await insert('subject_grade_template_periods', { subject_section_id: ss, grading_period_id: f.periodId, template_id: templateId });
        const student = f.students.find(s => s.label === label && s.kind === 'current');
        await insert('subject_grade_cache', { student_id: student.id, subject_section_id: ss, grading_period_id: f.periodId, average: kind === 'own' ? 90 : 88, is_complete: 1 });
      }
      const student = f.students.find(s => s.label === label && s.kind === 'current');
      await insert('advisory_overall_grades', { student_id: student.id, section_id: sectionId, grade_level_id: f.gradeId, grading_period_id: f.periodId, overall_average: 89 });
    }
    fs.writeFileSync(fixturePath, JSON.stringify(f));
    await db.commit();
    console.log('Synthetic fixture committed: two advisory classes, four accounts; credentials saved privately.');
  } catch (e) { await db.rollback(); if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath); throw e; }
  finally { await db.end(); }
}

async function cleanup() {
  const f = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (!/^qede2e_[a-f0-9]{8}$/.test(f.prefix)) throw Error('Invalid fixture owner');
  const db = await mysql.createConnection(options);
  const remove = async (table, column, ids) => { if (ids.length) await db.query(`DELETE FROM ${mysql.escapeId(table)} WHERE ${mysql.escapeId(column)} IN (?)`, [ids]); };
  try {
    const users = Object.values(f.accounts).map(a => a.userId), ss = f.subjectSections.map(s => s.id), students = f.students.map(s => s.id);
    const [owned] = await db.query('SELECT id FROM qed_authentication WHERE id IN (?) AND user_name LIKE ?', [users, `${f.prefix}_%`]);
    if (owned.length !== users.length) throw Error('Account ownership mismatch; refusing cleanup');
    await db.beginTransaction();
    await remove('system_audit_logs', 'actor_user_id', users);
    await remove('login_logs', 'user_id', users);
    await remove('notifications', 'user_id', users);
    await remove('grade_submission_history', 'submitted_by', [f.accounts.adviser.id, f.accounts.subject.id]);
    await remove('grade_visibility', 'student_id', students);
    await remove('subject_grade_submissions', 'subject_section_id', ss);
    await remove('grade_submissions', 'section_id', f.sections.map(s => s.id));
    await remove('subject_grade_template_periods', 'subject_section_id', ss);
    await remove('subject_grade_templates', 'id', f.templates);
    await remove('subject-section', 'id', ss);
    await remove('elem_subjects', 'id', f.subjects);
    await remove('elem_students', 'id', students);
    await remove('classes', 'id', f.classes);
    await remove('grade_level_sections', 'id', f.sections.map(s => s.id));
    await remove('qed_authentication', 'id', users);
    await remove('grade_level', 'id', [f.gradeId]);
    await remove('school_year', 'id', [f.oldYearId]);
    await db.commit();
    fs.unlinkSync(fixturePath);
    console.log('Synthetic fixture and test audit/login records removed.');
  } catch (e) { await db.rollback(); throw e; } finally { await db.end(); }
}

async function assessments() {
  const f = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const db = await mysql.createConnection(options);
  try {
    await db.beginTransaction();
    for (const ss of f.subjectSections.filter(s => s.kind !== 'historical')) {
      const grade = ss.kind === 'own' ? 90 : 88;
      const structure = { ww: { weightPercent: 40, domains: [] }, pt: { weightPercent: 60, domains: [] }, examWeightPercent: 0, examinations: { enabled: false, categoryWeightPercent: 0, components: [] }, transmutationTable: [{ igMin: 0, igMax: 100, transmuted: grade }], descriptorTable: [{ numericalGrade: grade, descriptor: 'Proficient' }], layout: { examWeightedScoreColumn: 1 }, termConfigurations: {} };
      await db.query('UPDATE subject_grade_templates t JOIN subject_grade_template_periods p ON p.template_id=t.id SET t.structure_json=?,t.export_map_json=? WHERE p.subject_section_id=?', [JSON.stringify(structure), JSON.stringify({ version: 3 }), ss.id]);
      const student = f.students.find(s => s.label === ss.label && s.kind === 'current');
      await db.query('DELETE FROM grade_items WHERE subject_section_id=? AND activity_name=?', [ss.id, f.prefix]);
      for (const tab of ['writtenWorks', 'performanceTask']) {
        const [item] = await db.query('INSERT INTO grade_items SET ?', { subject_section_id: ss.id, grading_period_id: f.periodId, tab, item_date: '2026-10-01', topic: 'Synthetic integration assessment', activity_name: f.prefix, max_items: 20 });
        await db.query('INSERT INTO grade_scores SET ?', { item_id: item.insertId, student_id: student.id, score: 20 });
      }
    }
    await db.commit(); console.log('Synthetic assessments and complete scores prepared.');
  } catch (e) { await db.rollback(); throw e; } finally { await db.end(); }
}

function server() {
  // A separate loopback test process uses the real auth, controllers and SQL.
  // Only outbound notifications are replaced; grades and API responses are real.
  global.__mysqlPoolCleaned = true; // Never kill another app's idle DB sessions during a test.
  const db = require('../../config/db');
  let clock = 0;
  for (const method of ['execute', 'query']) {
    db[method] = async (...args) => {
      const conn = await db.getConnection();
      try { await conn.query('SET timestamp = ?', [clock]); return await conn[method](...args); }
      finally { conn.release(); }
    };
  }
  const notification = require('../../src/modules/notification/notification.service');
  for (const key of Object.keys(notification)) notification[key] = async () => {};
  const express = require('express');
  const app = express();
  app.use(require('cors')({ origin: 'http://localhost:5173', credentials: true }));
  app.use(require('cookie-parser')()); app.use(express.json());
  app.get('/__test/health', (_req, res) => res.json({ ready: true }));
  app.post('/__test/clock', (req, res) => {
    const f = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    if (req.body.key !== f.password) return res.sendStatus(403);
    clock = req.body.ended ? 2051222400 : 0; // 2035-01-01 in this process's DB sessions only.
    res.json({ ended: Boolean(clock) });
  });
  app.use('/api', require('../../src/modules/shared/audit/auditLog.service').auditMutationRequests);
  app.use('/api', require('../../src/routes'));
  app.listen(7411, 'localhost', () => console.log('Integration API ready on localhost:7411; outbound notifications suppressed.'));
}
Promise.resolve(({ setup, assessments, cleanup, server })[process.argv[2]]?.()).catch(e => { console.error(e.sqlMessage || e.message); process.exitCode = 1; });
