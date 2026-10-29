const test=require('node:test'),assert=require('node:assert/strict');const {requireAvailableSlot}=require('../src/modules/teacher/gradebook/assessmentCapacity.service');
for(const used of [5,6,100])test('full or overflowing mapped category rejects addition: '+used,()=>{assert.throws(()=>requireAvailableSlot({scoreColumns:[1,2,3,4,5]},used),{statusCode:409});});
test('remaining capacity and independent domains remain usable',()=>{requireAvailableSlot({scoreColumns:[1,2,3,4,5]},4);requireAvailableSlot({scoreColumns:[6,7,8,9,10]},0);});
test('empty mappings have zero capacity and duplicate columns are not extra slots',()=>{assert.throws(()=>requireAvailableSlot({scoreColumns:[]},0));assert.throws(()=>requireAvailableSlot({scoreColumns:[1,1]},1));});
