const express = require('express');
const router = express.Router();
const verifyToken = require('../../modules/authentication/authentication.middleware');
const notificationController = require('./notification.controller');

router.get('/:userId', verifyToken, notificationController.getNotifications);
router.patch('/:id/read', verifyToken, notificationController.markAsRead);
router.patch('/user/:userId/read-all', verifyToken, notificationController.markAllAsRead);

module.exports = router;