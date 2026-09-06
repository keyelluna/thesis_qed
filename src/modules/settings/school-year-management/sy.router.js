const express = require("express");
const router = express.Router();
const schoolYearController = require("./sy.controller");
 
// get all school year
router.get('/getAllSy', schoolYearController.getAllSchoolYears);
 
// get active school year
router.get('/getActiveSy', schoolYearController.getActiveSchoolYear);
 
// get school year by id
router.get('/getSyById/:id', schoolYearController.getSchoolYearById);
 
// create new school year
router.post('/createSy', schoolYearController.createSchoolYear);
 
// update school year
router.put('/updateSy/:id', schoolYearController.updateSchoolYear);
 
// set a school year as active (deactivates the rest)
router.patch('/activateSy/:id', schoolYearController.setActiveSchoolYear);
 
// "delete" -> just deactivates (is_active = 0); must be DELETE to match schoolYearService.ts
router.delete('/deleteSy/:id', schoolYearController.deleteSchoolYear);
 
module.exports = router;
 