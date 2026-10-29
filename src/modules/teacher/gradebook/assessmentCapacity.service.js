function requireAvailableSlot(domain,used){
 if(!Array.isArray(domain?.scoreColumns))return;
 if(Number(used)>=new Set(domain.scoreColumns).size)throw Object.assign(new Error('No scoring columns remain for this category or domain in the assigned Excel template for this term.'),{statusCode:409});
}
module.exports={requireAvailableSlot};
