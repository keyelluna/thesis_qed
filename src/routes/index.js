const express = require("express");
const router = express.Router();

// ============================ S Y S T E M   R O U T E S =============================

const notificationRoutes = require("../modules/notification/notification.router.js");

router.use('/notification', notificationRoutes);

//==================================== A D M I N =======================================

const authenticationRoutes = require("./../modules/authentication/authentication.router.js");
const loginFreqencyRoutes = require("./../modules/authentication/loginfrequency.router.js")
const userRecordRoutes = require("./../modules/admin/user-record/userRecord.router.js");
const studentRecordRoutes = require("./../modules/admin/student-record/studentRecord.router.js");
const classesManagementRoutes = require("./../modules/admin/classes-management/classManagement.router.js");
const sectionManagementRoutes = require("./../modules/admin/section-management/section.router.js");
const subjectManagementRoutes = require("./../modules/admin/subject-management/subjectManagement.router.js");
const academicYearRouters = require("./../modules/admin/subject-management/academicYear.router.js");
const gradeLevelRoutes = require("./../modules/utils/gradeLevels.router.js");
const calendarRoutes = require("./../modules/shared/calendar/calendar.router.js");
const settingsRoutes = require("../modules/settings/school-year-management/sy.router.js");
const gradingPeriodsRouters = require("../modules/settings/grading-periods/gradingPeriods.router.js");

router.use("/auth", authenticationRoutes);
router.use("/analytics", loginFreqencyRoutes);
router.use("/user", userRecordRoutes);
router.use("/student", studentRecordRoutes);
router.use("/classes", classesManagementRoutes);
router.use("/section", sectionManagementRoutes);
router.use("/subject", subjectManagementRoutes);
router.use("/gradeLevel", gradeLevelRoutes);
router.use("/calendar", calendarRoutes);
router.use("/sy", settingsRoutes);
router.use("/gradingPeriods", gradingPeriodsRouters); 
router.use("/academic-year", academicYearRouters);

//==================================== T E A C H E R =======================================//
const mySubjectRoutes = require("./../modules/teacher/my-subjects/mySubjects.router.js");
const teacherDashboardRoutes = require("./../modules/teacher/dashboard/teacherDashboard.router.js");
const subjectGradingRoutes = require("./../modules/teacher/gradebook/subjectGrading.router.js");
const advisoryRoutes = require("./../modules/teacher/roster/advisory.router.js");
const holisticRoutes = require("./../modules/teacher/holistic/holistics.router.js");
const advisoryGradingRoutes = require("./../modules/teacher/averagegrade/advisoryGrade.router.js");
const advisoryAttendanceRoutes = require("./../modules/teacher/attendance/advisoryAttendance.router.js");

router.use("/mySubjects", mySubjectRoutes);
router.use("/teacherDashboard", teacherDashboardRoutes);
router.use("/teacherGrading", subjectGradingRoutes);
router.use("/teacherAdvisory", advisoryRoutes);
router.use("/teacherHolistic", holisticRoutes);
router.use("/advisoryGrading", advisoryGradingRoutes);
router.use("/teacherAttendance", advisoryAttendanceRoutes);
//=================================== P A R E N T S ========================================

const dashboardRoutes = require("../modules/parents/Dashboard/dashboard.router.js")
const schoolyearTermRoutes = require("../modules/parents/getSchoolYear/schoolYear.router.js");
const parentsProfileRoutes = require("../modules/parents/parentsProfile/parentsProfile.router.js");
const linkedChildrenRoutes = require("./../modules/parents/LinkedChildren/linkedChildren.router.js");
const attendanceRoutes = require("./../modules/parents/Student-Record/Overview/attendance.router.js");
const termPerformanceRoutes = require("./../modules/parents/Student-Record/Overview/studentTermPerformance.router.js");
const holisticPerformanceRoutes = require("../modules/parents/Student-Record/Overview/holisticPerformance.router.js");
const missedActivitiesRoutes = require("./../modules/parents/Student-Record/Academic/missedActivities.router.js");
const classSchedule = require("./../modules/parents/Student-Record/Academic/classSchedule.router.js");
const weeklyHolisticRoutes = require("./../modules/parents/Student-Record/holistic/weeklyHolistic.router.js");
const termProgressReportRoutes = require("../modules/parents/Student-Record/ProgressReport/termPerformance.router.js");
const termHolisticReportRoutes = require("./../modules/parents/Student-Record/ProgressReport/termHolistic.router.js");
const attendanceReportRoutes = require("./../modules/parents/Student-Record/ProgressReport/attendance.router.js");
const studentProfilesRoutes = require("./../modules/parents/Student-Record/StudentProfile/studentProfile.Router.js");

router.use("/dashboard", dashboardRoutes);
router.use("/sy_term", schoolyearTermRoutes);
router.use("/profile", parentsProfileRoutes);
router.use("/linkedChildren", linkedChildrenRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/termPerformance", termPerformanceRoutes);
router.use("/holisticPerformance", holisticPerformanceRoutes);
router.use("/missedActivities", missedActivitiesRoutes);
router.use("/classSchedule", classSchedule);
router.use("/weeklyHolisticEvaluation", weeklyHolisticRoutes);
router.use("/termPerformanceProgress", termProgressReportRoutes);
router.use("/termHolisticProgress", termHolisticReportRoutes);
router.use("/attendanceSummary", attendanceReportRoutes);
router.use("/studentProfile", studentProfilesRoutes);

//=================================== P R I N C I P A L ========================================

const principalDashboardRoutes = require("./../modules/principal/dashboard/dashboard.router.js");
const teacherRoutes = require("./../modules/principal/teachers/teachers.router.js");
const studentRoutes = require("./../modules/principal/students/students.router.js");
const reportsRoutes = require("./../modules/principal/Reports/reports.router.js");

router.use("/dashboard", principalDashboardRoutes);
router.use("/teachers", teacherRoutes);
router.use("/student", studentRoutes);
router.use("/reports", reportsRoutes);


module.exports = router;
