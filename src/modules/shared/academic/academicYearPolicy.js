function schoolDate(now=new Date()) {
 return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function validDate(date){return typeof date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;}
function unfinishedTerms(rows,today=schoolDate()) {
 const blocked=[1,2,3].filter(number=>{
  const matches=rows.filter(row=>Number(row.term_number)===number);
  if(matches.length!==1)return true;
  const {start_date:start,end_date:end}=matches[0];
  return !validDate(start)||!validDate(end)||start>end||end>=today;
 }).map(number=>({term_number:number,term_label:'Term '+number}));
 if(rows.some(row=>![1,2,3].includes(Number(row.term_number))))blocked.push({term_number:0,term_label:'Term configuration'});
 return blocked;
}
module.exports={schoolDate,unfinishedTerms};
