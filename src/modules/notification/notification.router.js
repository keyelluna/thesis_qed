const express = require('express');
const router = express.Router();
const notificationController = require('./notification.controller');

router.get('/:userId', notificationController.getNotifications);
router.patch('/:id/read', notificationController.markAsRead);
router.patch('/user/:userId/read-all', notificationController.markAllAsRead);

module.exports = router;