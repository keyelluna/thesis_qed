const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateReport, reportingMonths } = require('../src/modules/teacher/attendance/monthlyAttendanceReport.service');
const roster = [{id:1,name:'Male',gender:'Male'},{id:2,name:'Female',gender:'Female'}];
test('P/L are present, A/E absent; duplicate students and marks count once; missing stays unknown', () => {
  const result=aggregateReport([...roster,roster[0]],[
    {studentId:1,date:'2026-10-01',status:'L'},{studentId:1,date:'2026-10-01',status:'L'},
    {studentId:2,date:'2026-10-01',status:'E'},{studentId:1,date:'2026-10-02',status:'A'},
    {studentId:1,date:'2026-10-03',status:'P'},{studentId:1,date:'2026-09-30',status:'P'},
    {studentId:2,date:'2026-10-20',status:'P'},
  ],'2026-10');
  assert.deepEqual(result.enrollment,{male:1,female:1,total:2});
  assert.deepEqual(result.days.map(d=>d.date),['2026-10-01','2026-10-02','2026-10-20']);
  assert.deepEqual(result.days[0],{date:'2026-10-01',malePresent:1,femalePresent:0,maleAbsent:0,femaleAbsent:1,unmarked:0});
  assert.equal(result.days[1].maleAbsent,1);assert.equal(result.days[1].unmarked,1);assert.equal(result.days[1].femaleAbsent,0);
  assert.equal(result.numberOfDays,3);assert.deepEqual(result.sums,{male:1,female:1});
});
test('sample 279/22 and 318/22 rounds by gender to 13+14=27 without AM/PM doubling',()=>{
  const students=Array.from({length:28},(_,i)=>({id:i+1,name:'Student '+i,gender:i<13?'Male':'Female'}));
  const dates=Array.from({length:30},(_,i)=>'2026-09-'+String(i+1).padStart(2,'0')).filter(d=>![0,6].includes(new Date(d+'T12:00:00Z').getUTCDay()));
  const records=dates.flatMap((date,index)=>students.map((s,i)=>({studentId:s.id,date,status:(i===0&&index<7)||(i===13&&index<12)?'A':'P'})));
  const result=aggregateReport(students,records,'2026-09');
  assert.equal(result.numberOfDays,22);assert.deepEqual(result.sums,{male:279,female:318});assert.deepEqual(result.ada,{male:13,female:14,total:27});
});
test('half rounds upward, zero days leaves ADA blank, unknown gender never becomes male',()=>{
  const half=aggregateReport(roster,[{studentId:1,date:'2026-10-01',status:'P'},{studentId:1,date:'2026-10-02',status:'A'}],'2026-10');assert.equal(half.ada.male,1);
  const empty=aggregateReport([...roster,{id:3,name:'Missing gender',gender:null}],[],'2026-10');assert.equal(empty.ada,null);assert.equal(empty.numberOfDays,0);assert.equal(empty.enrollment.total,2);assert.equal(empty.unknownGender[0].id,'3');
});
test('month options span grading periods and year boundaries; conflicting duplicate marks fail',()=>{
  assert.deepEqual(reportingMonths([{startDate:'2026-12-15',endDate:'2027-01-10'},{startDate:'2027-01-11',endDate:'2027-02-15'}]),['2026-12','2027-01','2027-02']);
  assert.throws(()=>aggregateReport(roster,[{studentId:1,date:'2026-10-01',status:'P'},{studentId:1,date:'2026-10-01',status:'A'}],'2026-10'),/Conflicting/);
});
